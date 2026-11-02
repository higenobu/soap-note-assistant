"""Isolated, authenticated CPU speech service. Never logs audio/transcripts."""
from contextlib import asynccontextmanager
from pathlib import Path
import logging
import math
import os
import re
import tempfile
import threading

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool

MAX_BYTES = 32 * 1024 * 1024
MAX_SECONDS = 15 * 60
MAX_SEGMENTS = 200
MODEL_NAME = os.environ.get("ASR_MODEL", "small")
MIME_TYPES = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4"}
lock = threading.Lock()
state = {}
bearer = HTTPBearer(auto_error=False)


def auth_settings():
    secret = os.environ.get("JWT_SECRET", "")
    users = {s.strip() for s in os.environ.get("ASR_ALLOWED_USERS", "").split(",") if s.strip()}
    algorithm = os.environ.get("JWT_ALGORITHM", "HS256")
    if len(secret.encode()) < 32 or not users or algorithm not in {"HS256", "HS384", "HS512"}:
        raise RuntimeError("Configure JWT_SECRET, JWT_ALGORITHM and ASR_ALLOWED_USERS")
    return secret, users, algorithm


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "ログインしてください。")
    secret, users, algorithm = auth_settings()
    try:
        payload = jwt.decode(credentials.credentials, secret, algorithms=[algorithm], options={"require": ["exp", "sub"]})
        if not isinstance(payload["sub"], str) or payload["sub"] not in users:
            raise ValueError()
    except (jwt.InvalidTokenError, ValueError, TypeError):
        raise HTTPException(401, "音声認識の認証に失敗しました。") from None
    return payload["sub"]


@asynccontextmanager
async def lifespan(app):
    auth_settings()
    # Keep the host Python/CUDA and the existing LLM containers untouched.
    from faster_whisper import WhisperModel
    logging.getLogger("faster_whisper").setLevel(logging.ERROR)
    state["model"] = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8",
                                  cpu_threads=8, num_workers=1, download_root="/models")
    yield
    state.clear()


app = FastAPI(title="SOAP transcription", lifespan=lifespan)


@app.middleware("http")
async def no_store(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/soap-api/health")
def health():
    return {"status": "ok" if "model" in state else "loading", "device": "cpu", "model": MODEL_NAME}


def decode_bounded(path):
    """Decode at most 15 min; avoid expanding arbitrary compressed files in full."""
    import av
    import numpy as np
    pieces, count = [], 0
    try:
        with av.open(path) as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            def append(frames):
                nonlocal count
                for frame in frames:
                    count += frame.samples
                    if count > MAX_SECONDS * 16000:
                        raise HTTPException(413, "音声は15分以内に分割してください。")
                    pieces.append(frame.to_ndarray().reshape(-1).astype(np.float32) / 32768.0)
            for frame in container.decode(audio=0):
                append(resampler.resample(frame))
            append(resampler.resample(None))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "音声を読み取れませんでした。対応する録音形式を確認してください。") from None
    if not pieces or count == 0:
        raise HTTPException(422, "音声が空です。")
    return np.concatenate(pieces)


def review_flags(text):
    flags = ["話者・文字起こしを確認"]
    if re.search(r"\d|[０-９]", text):
        flags.append("数値・日付・用量を原音で確認")
    if re.search(r"ない|なし|否定|ません|ず|no\b|not\b", text, re.I):
        flags.append("否定表現を原音で確認")
    if re.search(r"薬|処方|服|投与|mg\b|mL\b", text, re.I):
        flags.append("薬剤名・単位を原音で確認")
    return flags


def transcribe_file(path):
    waveform = decode_bounded(path)
    model = state.get("model")
    if model is None:
        raise HTTPException(503, "音声認識モデルの準備中です。")
    iterator, info = model.transcribe(waveform, language="ja", beam_size=5, vad_filter=True,
                                     condition_on_previous_text=False)
    segments = []
    for source in iterator:
        text = source.text.strip()
        if not text:
            continue
        if len(segments) >= MAX_SEGMENTS or len(text) > 2000 or sum(len(s["text"]) for s in segments) + len(text) > 12000:
            raise HTTPException(413, "発話が多いため、音声を短く分割してください。")
        if not all(math.isfinite(x) for x in [source.start, source.end]):
            raise HTTPException(422, "音声の時刻情報を検証できませんでした。")
        segments.append({"id": "u" + str(len(segments) + 1), "start": round(source.start, 2),
                         "end": round(source.end, 2), "speaker": "不明", "text": text,
                         "flags": review_flags(text)})
    if not segments:
        raise HTTPException(422, "発話を取得できませんでした。録音を確認してください。")
    return {"segments": segments, "duration": round(len(waveform) / 16000, 2),
            "model": MODEL_NAME, "speaker_detection": "manual", "requires_review": True}


@app.post("/soap-api/transcribe")
async def transcribe(request: Request, user: str = Depends(current_user)):
    mime = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if mime not in MIME_TYPES:
        raise HTTPException(415, "対応する音声ファイルを選択してください。")
    if not lock.acquire(blocking=False):
        raise HTTPException(429, "別の音声を処理中です。しばらく待って再試行してください。")
    try:
        with tempfile.TemporaryDirectory(prefix="soap-", dir=os.environ.get("AUDIO_TMP", None)) as directory:
            path = Path(directory) / "audio"
            size = 0
            with path.open("wb") as stream:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "音声は32MB以内にしてください。")
                    stream.write(chunk)
            if size == 0:
                raise HTTPException(422, "音声ファイルが空です。")
            try:
                data = await run_in_threadpool(transcribe_file, str(path))
            except HTTPException:
                raise
            except Exception:
                # Never include decoder/model exception text: it may contain patient data.
                raise HTTPException(503, "音声認識に失敗しました。短い音声で再試行してください。") from None
            return JSONResponse(data)
    finally:
        lock.release()
