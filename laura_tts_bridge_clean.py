#!/usr/bin/env python3
"""
AutoSpeak Local TTS Bridge (Clean, GitHub-ready)

- Exposes:
    POST /tts     -> {"text": "...", "chunk": false, "max_chars": 600}
    GET  /latest  -> returns latest audio file (audio/mpeg)

- Behavior:
    * Uses ElevenLabs if ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are set
    * Otherwise falls back to macOS `say` (to AIFF) + `afplay` playback
    * Saves audio files to ./audio (relative to working dir)
    * Binds to 127.0.0.1 by default

Environment variables (optional):
    ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
    STABILITY, SIMILARITY, STYLE     (optional ElevenLabs params)
    PORT                              (default: 5005)

Dependencies:
    pip install flask requests
    (macOS fallback uses built-in 'say' and 'afplay')
"""
import io
import os
import re
import sys
import time
import json
import wave
import uuid
import queue
import shutil
import base64
import logging
import datetime as dt
from typing import Optional

from flask import Flask, request, send_file, jsonify, abort
import requests
import subprocess
from pathlib import Path

# ---------------- Config ----------------
AUDIO_DIR = Path("./audio")
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)

PORT = int(os.getenv("PORT", "5005"))
HOST = "127.0.0.1"

ELEVEN_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVEN_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "").strip()
ELEVEN_BASE = "https://api.elevenlabs.io/v1/text-to-speech"

# Optional ElevenLabs params
ELEVEN_STABILITY   = float(os.getenv("STABILITY", "0.45"))
ELEVEN_SIMILARITY  = float(os.getenv("SIMILARITY", "0.70"))
ELEVEN_STYLE       = float(os.getenv("STYLE", "0.15"))

# ---------------- App ----------------
app = Flask(__name__)

def _timestamp():
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")

def _safe_filename(prefix=""):
    return f"{_timestamp()}_{uuid.uuid4().hex[:8]}"

def _latest_audio_path() -> Optional[Path]:
    files = sorted(AUDIO_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None

def _speak_elevenlabs(text: str) -> Path:
    voice_id = ELEVEN_VOICE_ID
    if not ELEVEN_API_KEY or not voice_id:
        raise RuntimeError("ElevenLabs not configured")
    url = f"{ELEVEN_BASE}/{voice_id}"
    headers = {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": "eleven_monolingual_v1",
        "voice_settings": {
            "stability": ELEVEN_STABILITY,
            "similarity_boost": ELEVEN_SIMILARITY,
            "style": ELEVEN_STYLE
        }
    }
    logging.info("ElevenLabs: POST %s", url)
    r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=60)
    if r.status_code == 429:
        # propagate 429 so caller can decide
        raise requests.HTTPError("429 Too Many Requests", response=r)
    r.raise_for_status()
    out = AUDIO_DIR / f"{_safe_filename()}.mp3"
    with open(out, "wb") as f:
        f.write(r.content)
    return out

def _speak_macos(text: str) -> Path:
    """Fallback for macOS using 'say' + 'afplay'."""
    aiff = AUDIO_DIR / f"{_safe_filename()}.aiff"
    mp3  = AUDIO_DIR / f"{_safe_filename()}.mp3"

    # Synthesize to AIFF
    # Choose a default voice; users can change the system default or adapt this
    args = ["say", "-o", str(aiff), text]
    logging.info("macOS say: %s", " ".join(args))
    try:
        subprocess.run(args, check=True)
    except FileNotFoundError:
        raise RuntimeError("'say' not found (macOS only). Configure ElevenLabs instead.")

    # Convert AIFF -> MP3 (uses afconvert if present; otherwise leave AIFF)
    # afconvert is present on macOS; try it:
    try:
        subprocess.run(["afconvert", str(aiff), str(mp3), "-f", "MP3", "-d", "ae32"], check=True)
        out_path = mp3
    except Exception:
        logging.warning("afconvert not available; serving AIFF instead of MP3.")
        out_path = aiff

    # Play audio (non-blocking)
    try:
        subprocess.Popen(["afplay", str(out_path)])
    except FileNotFoundError:
        logging.warning("'afplay' not found; skipping auto-playback. File saved: %s", out_path)

    # Clean intermediate AIFF if MP3 created
    if out_path == mp3 and aiff.exists():
        try:
            aiff.unlink()
        except Exception:
            pass
    return out_path

def synthesize(text: str) -> Path:
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty text")

    # Strip an optional leading "LAURA:" (case-insensitive) if present
    text = re.sub(r'^\s*LAURA:\s*', '', text, flags=re.I)

    # Try ElevenLabs, then fallback
    if ELEVEN_API_KEY and ELEVEN_VOICE_ID:
        try:
            return _speak_elevenlabs(text)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                logging.warning("ElevenLabs 429 (rate-limited). Consider retrying later.")
            else:
                logging.exception("ElevenLabs error; falling back to macOS 'say'.")
        except Exception:
            logging.exception("ElevenLabs error; falling back to macOS 'say'.")

    return _speak_macos(text)

@app.route("/latest", methods=["GET"])
def latest():
    p = _latest_audio_path()
    if not p:
        return jsonify({"message": "No audio yet"}), 404
    # Guess content type (mp3 or aiff)
    mimetype = "audio/mpeg" if p.suffix.lower() == ".mp3" else "audio/aiff"
    return send_file(str(p), mimetype=mimetype)

@app.route("/tts", methods=["POST"])
def tts():
    try:
        data = request.get_json(force=True) or {}
    except Exception:
        data = {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Missing 'text'"}), 400

    chunk = bool(data.get("chunk"))
    max_chars = int(data.get("max_chars") or 600)

    if not chunk and len(text) > max_chars:
        text = text[:max_chars]

    # Naive chunking: split by sentences if chunk==True
    paths = []
    if chunk and len(text) > max_chars:
        # split on sentence-ish boundaries
        import re as _re
        sentences = _re.split(r'(?<=[\.\!\?])\s+', text)
        current = ""
        for s in sentences:
            if len(current) + len(s) + 1 <= max_chars:
                current += ((" " if current else "") + s)
            else:
                if current:
                    paths.append(synthesize(current))
                current = s
        if current:
            paths.append(synthesize(current))
    else:
        paths.append(synthesize(text))

    # Return the last file as immediate response (client can GET /latest)
    last = paths[-1]
    mimetype = "audio/mpeg" if last.suffix.lower() == ".mp3" else "audio/aiff"
    return send_file(str(last), mimetype=mimetype)

def main():
    logging.info("AutoSpeak Bridge starting on %s:%d", HOST, PORT)
    if ELEVEN_API_KEY and ELEVEN_VOICE_ID:
        logging.info("Mode: ElevenLabs (voice=%s)", ELEVEN_VOICE_ID)
    else:
        logging.info("Mode: macOS fallback (say/afplay)")
    app.run(host=HOST, port=PORT, debug=False)

if __name__ == "__main__":
    main()
