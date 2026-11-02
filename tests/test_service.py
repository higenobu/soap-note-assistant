import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import jwt
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("soap_service", Path(__file__).parents[1] / "service/app.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"JWT_SECRET": "test-secret-" * 5, "ASR_ALLOWED_USERS": "demo", "JWT_ALGORITHM": "HS256"})
        self.env.start()
        self.client = TestClient(api.app)  # No lifespan: no downloads or real model in unit tests.
        self.token = jwt.encode({"sub": "demo", "exp": time.time() + 600}, "test-secret-" * 5, algorithm="HS256")
        self.headers = {"Authorization": "Bearer " + self.token, "Content-Type": "audio/webm"}

    def tearDown(self):
        self.env.stop()

    def test_auth_rejects_missing_expired_and_disallowed_users(self):
        self.assertEqual(self.client.post("/soap-api/transcribe", content=b"audio").status_code, 401)
        for sub, exp in [("other", time.time()+600), ("demo", time.time()-600)]:
            token = jwt.encode({"sub": sub, "exp": exp}, "test-secret-" * 5, algorithm="HS256")
            r = self.client.post("/soap-api/transcribe", content=b"audio", headers=self.headers | {"Authorization": "Bearer " + token})
            self.assertEqual(r.status_code, 401)

    def test_empty_wrong_type_busy_and_upload_limit(self):
        self.assertEqual(self.client.post("/soap-api/transcribe", content=b"", headers=self.headers).status_code, 422)
        self.assertEqual(self.client.post("/soap-api/transcribe", content=b"x", headers=self.headers | {"Content-Type": "text/plain"}).status_code, 415)
        api.lock.acquire()
        try:
            self.assertEqual(self.client.post("/soap-api/transcribe", content=b"x", headers=self.headers).status_code, 429)
        finally:
            api.lock.release()
        with patch.object(api, "MAX_BYTES", 2):
            self.assertEqual(self.client.post("/soap-api/transcribe", content=b"123", headers=self.headers).status_code, 413)
        self.assertFalse(api.lock.locked())

    def test_temp_audio_deleted_after_success_and_failure(self):
        for fails in [False, True]:
            captured = []
            def fake(path):
                captured.append(Path(path))
                self.assertEqual(Path(path).read_bytes(), b"private-audio")
                if fails:
                    raise ValueError("private medical text")
                return {"segments": [{"id": "u1", "speaker": "不明", "text": "架空の発話"}]}
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AUDIO_TMP": directory}), patch.object(api, "transcribe_file", side_effect=fake):
                response = self.client.post("/soap-api/transcribe", content=b"private-audio", headers=self.headers)
                self.assertEqual(response.status_code, 503 if fails else 200)
                self.assertEqual(list(Path(directory).iterdir()), [])
                self.assertFalse(captured[0].exists())
                self.assertNotIn("private medical text", response.text)
                self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertFalse(api.lock.locked())

    def test_review_flags_do_not_assign_speaker_or_diagnosis(self):
        flags = api.review_flags("薬は5mgではない")
        self.assertTrue(any("用量" in f for f in flags))
        self.assertTrue(any("否定" in f for f in flags))


if __name__ == "__main__":
    unittest.main()
