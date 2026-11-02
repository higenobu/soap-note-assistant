import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import numpy as np
from fastapi import HTTPException


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backend = load("llm_asr", "service/llm_asr.py")
evaluation = load("compare_asr", "scripts/compare_asr.py")
api = load("llm_test_api", "service/app.py")


class LlmAsrTests(unittest.TestCase):
    def test_all_samples_retained_including_last_partial_window(self):
        waveform = np.arange(45 * 16000 + 7)
        chunks = list(backend.windows(waveform))
        np.testing.assert_array_equal(np.concatenate([c[2] for c in chunks]), waveform)
        self.assertEqual([(c[0], c[1]) for c in chunks], [(0,20), (20,40), (40,len(waveform)/16000)])
        with self.assertRaises(ValueError):
            list(backend.windows(waveform, 31))

    def test_generated_only_tokens_are_not_sliced_by_prompt_length(self):
        tokenizer = Mock()
        tokenizer.decode.return_value = "発熱はない"
        generated = np.array([[10, 11, 2]])
        self.assertEqual(backend.decode_generated(tokenizer, generated, 512, {2}), "発熱はない")
        tokenizer.decode.assert_called_once_with([10, 11, 2], skip_special_tokens=True)
        with self.assertRaises(HTTPException) as failure:
            backend.decode_generated(tokenizer, np.array([[10,11,12]]), 3, {2})
        self.assertEqual(failure.exception.status_code, 422)

    def test_fixed_windows_do_not_invent_speakers_and_abort_on_partial_generation(self):
        engine = object.__new__(backend.Engine)
        engine.metadata = {"segmentation": "fixed-window-20s"}
        engine.recognize = Mock(side_effect=["発熱はない", "薬は5mg"])
        result = engine.transcribe(np.zeros(21*16000), api.review_flags)
        self.assertEqual([s["speaker"] for s in result["segments"]], ["不明", "不明"])
        self.assertEqual(result["segments"][1]["end"], 21)
        self.assertTrue(result["requires_review"])
        engine.recognize.side_effect = ["first", HTTPException(422, "truncated")]
        with self.assertRaises(HTTPException):
            engine.transcribe(np.zeros(21*16000), api.review_flags)

    def test_shared_upload_dispatches_to_experimental_engine_and_reports_metadata(self):
        engine = Mock()
        engine.metadata = {"device": "cuda:0", "model": backend.MODEL_ID, "experimental": True}
        engine.transcribe.return_value = {"segments": [{"text": "発熱はない"}]}
        with patch.dict(api.state, {"engine": engine, "model": object()}, clear=True), patch.object(api, "decode_bounded", return_value=np.zeros(16000)):
            self.assertEqual(api.health()["device"], "cuda:0")
            self.assertTrue(api.health()["experimental"])
            self.assertEqual(api.transcribe_file("dummy"), engine.transcribe.return_value)
            engine.transcribe.assert_called_once()

    def test_experimental_decoder_rejects_over_60_seconds_without_silent_truncation(self):
        import wave
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "long.wav"
            with wave.open(str(path), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * (61*16000))
            with patch.dict("os.environ", {"ASR_BACKEND": "llm-jp"}):
                with self.assertRaises(HTTPException) as failure:
                    api.decode_bounded(str(path))
                self.assertEqual(failure.exception.status_code, 413)
            with patch.dict("os.environ", {"ASR_BACKEND": "whisper"}):
                self.assertEqual(len(api.decode_bounded(str(path))), 61*16000)


class InputAndTerminationTests(unittest.TestCase):
    def test_real_whisper_features_preserve_full_duration_and_partial_frame(self):
        # Actual pinned feature extractor, no weights, network, Torch or GPU required.
        from transformers import WhisperFeatureExtractor
        extractor = WhisperFeatureExtractor(feature_size=128)
        for samples in [557 * 160, 1282 * 160 + 1, 20 * 16000]:
            waveform = np.zeros(samples, dtype=np.float32)
            audio = extractor([waveform], sampling_rate=16000,
                              return_attention_mask=True, return_tensors="np")
            info = backend.input_diagnostics(waveform, audio, extractor, 4)
            self.assertEqual(info["input_samples"], samples)
            self.assertLess(abs(info["mask_seconds"] - samples / 16000), 0.011)
            self.assertEqual(info["feature_shape"], [1, 128, 3000])
            self.assertGreater(info["adapter_audio_tokens"], 0)
        audio.attention_mask[:] = 0
        with self.assertRaises(HTTPException) as failure:
            backend.input_diagnostics(waveform, audio, extractor, 4)
        self.assertEqual(failure.exception.status_code, 503)

    def test_stereo_48khz_audio_is_resampled_to_complete_mono_16khz(self):
        import wave
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stereo.wav"
            signal = (np.sin(np.arange(48000) * 2 * np.pi * 400 / 48000) * 10000).astype(np.int16)
            with wave.open(str(path), "wb") as audio:
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(48000)
                audio.writeframes(np.column_stack([signal, signal]).tobytes())
            waveform = api.decode_bounded(str(path))
            self.assertEqual(waveform.shape, (16000,))
            self.assertTrue(np.isfinite(waveform).all())
            self.assertGreater(np.max(np.abs(waveform[-100:])), 0.1)

    def test_eos_and_token_limit_are_distinct_and_never_include_transcript_tokens(self):
        tokenizer = Mock()
        tokenizer.decode.return_value = "private transcript"
        diagnostic = {}
        text = backend.decode_generated(tokenizer, np.array([[123, 456, 2]]), 512, {2}, diagnostic)
        self.assertEqual(text, "private transcript")
        self.assertEqual(diagnostic["finish_reason"], "eos")
        self.assertEqual(diagnostic["generated_tokens"], 3)
        self.assertNotIn("private", str(diagnostic))
        self.assertNotIn("123", str(diagnostic))
        self.assertNotIn("456", str(diagnostic))
        with self.assertRaises(HTTPException):
            backend.decode_generated(tokenizer, np.array([[123,456,789]]), 3, {2}, diagnostic)
        self.assertEqual(diagnostic["finish_reason"], "token_limit")
        self.assertEqual(backend.generation_diagnostics([123], 512, {2})["finish_reason"], "other")

    def test_diagnostics_opt_in_includes_empty_windows_without_claiming_completeness(self):
        engine = object.__new__(backend.Engine)
        engine.metadata = {"experimental": True}
        engine.diagnostics_enabled = True
        def fake(audio, diagnostic=None):
            if diagnostic is not None:
                diagnostic.update({"finish_reason": "eos", "generated_tokens": 1})
            return "" if len(audio) == 20*16000 else "example"
        engine.recognize = fake
        result = engine.transcribe(np.zeros(21*16000), api.review_flags)
        self.assertEqual(len(result["diagnostics"]), 2)
        self.assertEqual(len(result["segments"]), 1)
        engine.diagnostics_enabled = False
        self.assertNotIn("diagnostics", engine.transcribe(np.zeros(21*16000), api.review_flags))


class EvaluationTests(unittest.TestCase):
    def test_character_error_rate_insertion_deletion_substitution_and_empty(self):
        self.assertEqual(evaluation.cer("abc", "abc"), 0)
        for text in ["axc", "ab", "abcd"]:
            self.assertAlmostEqual(evaluation.cer("abc", text), 1/3)
        self.assertEqual(evaluation.cer("a", "abcd"), 3)
        self.assertIsNone(evaluation.cer("", "text"))

    def test_normalization_preserves_negations_and_numeric_values(self):
        self.assertEqual(evaluation.normalize("薬は５ｍｇ、発熱はない。\n"), "薬は5mg、発熱はない。")
        self.assertNotEqual(evaluation.normalize("発熱はない"), evaluation.normalize("発熱あり"))
        self.assertNotEqual(evaluation.normalize("5.0mg"), evaluation.normalize("50.0mg"))

    def test_failed_endpoint_has_no_accuracy_score_and_other_endpoint_is_evaluated(self):
        import io
        import json
        import sys
        import urllib.error
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "audio.wav").write_bytes(b"same audio")
            (root / "reference.txt").write_text("発熱はない", encoding="utf-8")
            output = root / "report.json"
            argv = ["compare_asr.py", str(root / "audio.wav"), str(root / "reference.txt"), "--output", str(output)]
            response = {"segments": [{"text": "発熱はない"}], "duration": 1}
            failure = urllib.error.HTTPError("http://localhost", 503, "private text", {}, None)
            stdout = io.StringIO()
            with patch.object(sys, "argv", argv), patch.object(evaluation.getpass, "getpass", return_value="secret"), patch.object(evaluation, "transcribe", side_effect=[failure, (response, 2)]), patch("sys.stdout", stdout):
                self.assertEqual(evaluation.main(), 1)
            report = json.loads(output.read_text())
            self.assertEqual(report["results"]["whisper"], {"status": "failed", "http_status": 503})
            self.assertEqual(report["results"]["llm-asr"]["cer_raw"], 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("発熱", stdout.getvalue())
            self.assertNotIn("secret", stdout.getvalue())
            self.assertNotIn("private text", stdout.getvalue())

    def test_request_uses_identical_raw_audio_and_no_redirects(self):
        import io
        payload = b'{"segments":[{"text":"test"}],"duration":1}'
        opener = Mock()
        opener.open.side_effect = lambda *a, **k: io.BytesIO(payload)
        with patch.object(evaluation.urllib.request, "build_opener", return_value=opener):
            for port in [8003,8004]:
                evaluation.transcribe(f"http://127.0.0.1:{port}/soap-api/transcribe", b"same-audio", "audio/wav", "secret")
        for call in opener.open.call_args_list:
            self.assertEqual(call.args[0].data, b"same-audio")
            self.assertEqual(call.args[0].get_header("Authorization"), "Bearer secret")
        with self.assertRaises(ValueError):
            evaluation.transcribe("http://example.com/", b"x", "audio/wav", "secret")
        self.assertIsNone(evaluation.NoRedirect().redirect_request(None,None,None,None,None,None))


if __name__ == "__main__":
    unittest.main()
