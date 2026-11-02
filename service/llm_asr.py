"""Experimental adapter for the pinned ja-speech-llm inference implementation."""
import os
from fastapi import HTTPException

MODEL_ID = "Atotti/llm-jp-4-8b-speech-asr"
SOURCE_REVISION = "b04d5061e4ccb68f8955a2af9483c143a860d6d0"
PROMPT = "あなたは音声を理解できるAIアシスタントです。\n\n<|reserved_343|><|reserved_342|>### 指示:\n音声を書き起こしてください。\n\n### 応答:\n"


def windows(waveform, seconds=20):
    if not 1 <= seconds <= 30:
        raise ValueError("Chunk size must be between 1 and 30 seconds")
    for start in range(0, len(waveform), seconds * 16000):
        end = min(start + seconds * 16000, len(waveform))
        yield start / 16000, end / 16000, waveform[start:end]


def decode_generated(tokenizer, generated, max_tokens, eos_ids):
    # Upstream generate() uses decoder.generate(inputs_embeds=...), returning ONLY
    # generated tokens. Do NOT slice by the prompt length (despite the model card).
    ids = generated[0].tolist()
    if len(ids) >= max_tokens and (not ids or ids[-1] not in eos_ids):
        raise HTTPException(422, "生成上限に達しました。音声を短くして再試行してください。")
    return tokenizer.decode(ids, skip_special_tokens=True).strip()


class Engine:
    def __init__(self):
        import torch
        from transformers import AutoProcessor, AutoTokenizer
        from speech_llm_ja import LlamaForSpeechLM, LlamaForSpeechLMConfig
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("This experimental service requires a BF16-capable CUDA GPU")
        revision = os.environ.get("LLM_ASR_REVISION", "main")
        config = LlamaForSpeechLMConfig.from_pretrained(MODEL_ID, revision=revision)
        self.model = LlamaForSpeechLM.from_pretrained(
            MODEL_ID, revision=revision, config=config, torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True).to("cuda:0").eval()
        self.processor = AutoProcessor.from_pretrained(config.encoder_id)
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=revision)
        self.tokenizer.pad_token = self.tokenizer.eos_token
        eos = self.model.decoder.generation_config.eos_token_id
        if eos is None:
            eos = self.tokenizer.eos_token_id
        self.eos_ids = set(eos if isinstance(eos, list) else [eos])
        self.metadata = {"device": "cuda:0", "model": MODEL_ID,
                         "model_revision": getattr(config, "_commit_hash", None) or revision,
                         "source_revision": SOURCE_REVISION,
                         "segmentation": "fixed-window-20s", "experimental": True}

    def recognize(self, waveform):
        import torch
        audio = self.processor([waveform], return_tensors="pt", return_attention_mask=True,
                               sampling_rate=16000)
        prompt = self.tokenizer(PROMPT, return_tensors="pt")
        with torch.inference_mode():
            generated = self.model.generate(
                input_features=audio.input_features.to("cuda:0"),
                encoder_attention_mask=audio.attention_mask.to("cuda:0"),
                input_ids=prompt.input_ids.to("cuda:0"),
                decoder_attention_mask=prompt.attention_mask.to("cuda:0"),
                max_new_tokens=512, do_sample=False,
                pad_token_id=self.tokenizer.pad_token_id)
        return decode_generated(self.tokenizer, generated, 512, self.eos_ids)

    def transcribe(self, waveform, review_flags):
        segments = []
        for start, end, audio in windows(waveform):
            text = self.recognize(audio)
            if not text:
                continue
            if len(text) > 2000 or sum(len(s["text"]) for s in segments) + len(text) > 12000:
                raise HTTPException(413, "発話が多いため、音声を短く分割してください。")
            segments.append({"id": f"u{len(segments)+1}", "start": round(start, 2),
                             "end": round(end, 2), "speaker": "不明", "text": text,
                             "flags": review_flags(text) + ["時刻は固定分割の区間です"]})
        if not segments:
            raise HTTPException(422, "発話を取得できませんでした。録音を確認してください。")
        return {**self.metadata, "segments": segments, "duration": round(len(waveform)/16000, 2),
                "speaker_detection": "manual", "requires_review": True}
