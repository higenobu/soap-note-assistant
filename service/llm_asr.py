"""Experimental adapter for the pinned ja-speech-llm inference implementation."""
import os
import math
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


def input_diagnostics(waveform, audio, extractor, adapter_kernel):
    """Validate duration carried by the mask; never retain audio or feature values."""
    import numpy as np
    waveform = np.asarray(waveform)
    if waveform.ndim != 1 or not 0 < len(waveform) <= 30 * 16000 or not np.isfinite(waveform).all():
        raise HTTPException(422, "モデル入力音声の形式・長さを検証できませんでした。")
    rate, hop = extractor.sampling_rate, extractor.hop_length
    if rate != 16000 or hop <= 0 or adapter_kernel <= 0:
        raise HTTPException(503, "モデルの音声特徴量設定を検証できませんでした。")
    features, mask = audio.input_features, audio.attention_mask
    valid = int(mask.sum().item())
    expected = math.ceil(len(waveform) / hop)
    if (len(features.shape) != 3 or features.shape[0] != 1 or
            tuple(mask.shape) != (1, features.shape[-1]) or valid != expected):
        raise HTTPException(503, "音声入力とモデル入力の長さが一致しません。")
    # The pinned upstream Whisper encoder has stride 2; its adapter pools by kernel.
    tokens = ((valid - 1) // 2 + 1) // adapter_kernel
    if tokens < 1:
        raise HTTPException(422, "音声が短すぎます。")
    return {"sample_rate": rate, "input_samples": len(waveform),
            "input_seconds": len(waveform) / rate,
            "feature_shape": list(features.shape), "mask_frames": valid,
            "mask_seconds": valid * hop / rate,
            "expected_mask_frames": expected, "adapter_audio_tokens": tokens}


def generation_diagnostics(ids, max_tokens, eos_ids):
    ended_eos = bool(ids) and ids[-1] in eos_ids
    return {"generated_tokens": len(ids), "max_new_tokens": max_tokens,
            "finish_reason": "eos" if ended_eos else "token_limit" if len(ids) >= max_tokens else "other",
            "eos_token_ids": sorted(eos_ids),
            "last_eos_token_id": ids[-1] if ended_eos else None}


def decode_generated(tokenizer, generated, max_tokens, eos_ids, diagnostic=None):
    # Upstream generate() uses decoder.generate(inputs_embeds=...), returning ONLY
    # generated tokens. Do NOT slice by the prompt length (despite the model card).
    ids = generated[0].tolist()
    if diagnostic is not None:
        diagnostic.update(generation_diagnostics(ids, max_tokens, eos_ids))
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
        if config.encoder_type != "whisper":
            raise RuntimeError("This adapter validates Whisper input lengths only")
        self.processor = AutoProcessor.from_pretrained(config.encoder_id)
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=revision)
        self.tokenizer.pad_token = self.tokenizer.eos_token
        eos = self.model.decoder.generation_config.eos_token_id
        if eos is None:
            eos = self.tokenizer.eos_token_id
        self.eos_ids = set(eos if isinstance(eos, list) else [eos])
        if not self.eos_ids or any(not isinstance(i, int) or isinstance(i, bool) or i < 0 for i in self.eos_ids):
            raise RuntimeError("No valid generation EOS token IDs")
        self.diagnostics_enabled = os.environ.get("LLM_ASR_DIAGNOSTICS", "0") == "1"
        self.metadata = {"device": "cuda:0", "model": MODEL_ID,
                         "model_revision": getattr(config, "_commit_hash", None) or revision,
                         "source_revision": SOURCE_REVISION,
                         "segmentation": "fixed-window-20s", "experimental": True,
                         "diagnostics_enabled": self.diagnostics_enabled}

    def recognize(self, waveform, diagnostic=None):
        import torch
        audio = self.processor([waveform], return_tensors="pt", return_attention_mask=True,
                               sampling_rate=16000)
        inputs = input_diagnostics(waveform, audio, self.processor.feature_extractor,
                                   self.model.config.adapter_kernel_size)
        if diagnostic is not None:
            diagnostic.update(inputs)
            diagnostic["tokenizer_eos_token_id"] = self.tokenizer.eos_token_id
        prompt = self.tokenizer(PROMPT, return_tensors="pt")
        with torch.inference_mode():
            generated = self.model.generate(
                input_features=audio.input_features.to("cuda:0"),
                encoder_attention_mask=audio.attention_mask.to("cuda:0"),
                input_ids=prompt.input_ids.to("cuda:0"),
                decoder_attention_mask=prompt.attention_mask.to("cuda:0"),
                max_new_tokens=512, do_sample=False,
                pad_token_id=self.tokenizer.pad_token_id)
        return decode_generated(self.tokenizer, generated, 512, self.eos_ids, diagnostic)

    def transcribe(self, waveform, review_flags):
        segments, diagnostics = [], []
        for start, end, audio in windows(waveform):
            diagnostic = {"start": start, "end": end} if getattr(self, "diagnostics_enabled", False) else None
            text = self.recognize(audio, diagnostic=diagnostic)
            if diagnostic is not None:
                diagnostics.append(diagnostic)
            if not text:
                continue
            if len(text) > 2000 or sum(len(s["text"]) for s in segments) + len(text) > 12000:
                raise HTTPException(413, "発話が多いため、音声を短く分割してください。")
            segments.append({"id": f"u{len(segments)+1}", "start": round(start, 2),
                             "end": round(end, 2), "speaker": "不明", "text": text,
                             "flags": review_flags(text) + ["時刻は固定分割の区間です"]})
        if not segments:
            raise HTTPException(422, "発話を取得できませんでした。録音を確認してください。")
        result = {**self.metadata, "segments": segments, "duration": round(len(waveform)/16000, 2),
                "speaker_detection": "manual", "requires_review": True}
        if getattr(self, "diagnostics_enabled", False):
            result["diagnostics"] = diagnostics
        return result
