"""Compare two loopback ASR APIs using identical audio; never print transcripts."""
import argparse
import getpass
import json
import os
from pathlib import Path
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request


def normalize(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text)
                   if not c.isspace())


def cer(reference, hypothesis):
    """Character Levenshtein rate. Empty references are undefined, not zero."""
    if not reference:
        return None
    previous = list(range(len(hypothesis) + 1))
    for i, a in enumerate(reference, 1):
        row = [i]
        for j, b in enumerate(hypothesis, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j-1] + (a != b)))
        previous = row
    return previous[-1] / len(reference)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward a bearer token to another host.


def transcribe(url, audio, mime, token):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password:
        raise ValueError("Use an HTTP loopback endpoint for local evaluation")
    request = urllib.request.Request(url, data=audio, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": mime})
    start = time.monotonic()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=1800) as response:
        result = json.load(response)
    elapsed = time.monotonic() - start
    if not isinstance(result, dict):
        raise ValueError("Invalid transcript response")
    segments = result.get("segments")
    if not isinstance(segments, list) or not segments or any(not isinstance(s, dict) or not isinstance(s.get("text"), str) for s in segments):
        raise ValueError("Invalid transcript response")
    return result, elapsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("reference", type=Path, help="Human-checked UTF-8 transcript")
    parser.add_argument("--output", required=True, type=Path, help="New private JSON report; includes transcripts")
    parser.add_argument("--token-file", type=Path, help="Optional chmod 600 token file; otherwise prompt")
    parser.add_argument("--terms", type=Path, help="Optional UTF-8 JSON array of important phrases")
    parser.add_argument("--whisper", default="http://127.0.0.1:8003/soap-api/transcribe")
    parser.add_argument("--llm-asr", default="http://127.0.0.1:8004/soap-api/transcribe")
    args = parser.parse_args()
    if args.token_file:
        if args.token_file.stat().st_mode & 0o077:
            parser.error("Token file must have mode 600 or stricter")
        token = args.token_file.read_text().strip()
    else:
        token = getpass.getpass("LLM API access token (hidden): ").strip()
    if not token:
        parser.error("An access token is required")
    if args.audio.stat().st_size > 32 * 1024 * 1024:
        parser.error("Audio must be at most 32 MB and 60 seconds")
    audio = args.audio.read_bytes()
    reference = args.reference.read_text(encoding="utf-8").strip()
    if not normalize(reference) or len(reference) > 20000:
        parser.error("Reference must contain 1–20000 characters")
    terms = json.loads(args.terms.read_text(encoding="utf-8")) if args.terms else []
    if not isinstance(terms, list) or any(not isinstance(t, str) or not t for t in terms):
        parser.error("Terms must be an array of non-empty strings")
    mime = {".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg",
            ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4"}.get(args.audio.suffix.lower())
    if mime is None:
        parser.error("Unsupported audio extension; use .wav, .webm, .ogg, .mp3 or .m4a")
    # Create exclusively, before sending audio; never overwrite an existing report.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    report = {"reference": reference, "normalization": "NFKC; remove whitespace only (preserve punctuation, signs and decimal points)", "results": {}}
    failed = False
    try:
        for name, url in [("whisper", args.whisper), ("llm-asr", args.llm_asr)]:
            try:
                result, elapsed = transcribe(url, audio, mime, token)
                hypothesis = "".join(s["text"] for s in result["segments"])
                if len(hypothesis) > 20000:
                    raise ValueError("Transcript too long")
                raw, normalized = cer(reference, hypothesis), cer(normalize(reference), normalize(hypothesis))
                duration = result.get("duration", 0)
                rtf = elapsed / duration if isinstance(duration, (float, int)) and duration > 0 else None
                report["results"][name] = {"status": "ok", "seconds": elapsed, "rtf": rtf,
                    "cer_raw": raw, "cer_normalized": normalized, "response": result,
                    "term_counts": [{"term": t, "reference": reference.count(t), "hypothesis": hypothesis.count(t)} for t in terms]}
                print(f"{name}: CER={normalized:.1%}, seconds={elapsed:.2f}, RTF={rtf if rtf is not None else 'unknown'}")
            except (urllib.error.URLError, ValueError, KeyError, TypeError, TimeoutError, OSError) as error:
                failed = True
                # Never print server bodies, transcripts, URLs, tokens, or exception text.
                status = error.code if isinstance(error, urllib.error.HTTPError) else None
                report["results"][name] = {"status": "failed", "http_status": status}
                print(f"{name}: failed (HTTP {status if status else 'unavailable/invalid response'})")
    finally:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
