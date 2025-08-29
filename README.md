# AutoSpeak — Userscript + Local TTS Bridge (Clean, GitHub‑Ready)

A minimal, **user‑agnostic** setup for speaking ChatGPT assistant messages using a local HTTP bridge.
This repository contains no personal paths. Everything binds to **127.0.0.1** and saves audio under a local `audio/` folder.

## Components
- **Userscript**: `chat_autospeak_safe_v1_10c_stabilized.user.js`
  - Requires a trigger **prefix** (default `LAURA:`)
  - **Strips** the prefix before speech so it’s not spoken
  - Waits for streaming to **stabilize** before sending (no clipped audio)
  - Includes **HTTP 429 backoff** + conservative rate limits
- **Bridge (Python)**: `laura_tts_bridge_clean.py`
  - `POST /tts` (JSON: `{ "text": "Hello", "chunk": false, "max_chars": 600 }`)
  - `GET /latest` (returns latest MP3/AIFF)
  - **ElevenLabs** first (if `ELEVENLABS_API_KEY` & `ELEVENLABS_VOICE_ID` set), else **macOS** fallback (`say` + `afplay`)
  - Saves audio to `./audio/` (relative), binds to `127.0.0.1:5005`

## Requirements
- Browser + Userscript Manager (Tampermonkey/Violentmonkey)
- Python 3.9+
- Optional: ElevenLabs account, API key, and voice ID
- macOS for the built‑in fallback (`say` + `afplay`). ElevenLabs mode works cross‑platform.

## Quick Start
1. **Install the userscript**
   - Open `chat_autospeak_safe_v1_10c_stabilized.user.js` in your browser → Install.

2. **Run the bridge**
   - Option A (env file):
     ```bash
     cp .env.sample .env
     # Edit .env and set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID if you have them
     python3 laura_tts_bridge_clean.py
     ```
   - Option B (direct env):
     ```bash
     export ELEVENLABS_API_KEY="eleven_..."
     export ELEVENLABS_VOICE_ID="21m00Tcm4TlvDq8ikWAM"
     python3 laura_tts_bridge_clean.py
     ```
   The server listens at `http://127.0.0.1:5005`.

3. **Use the panel**
   - Toggle **Enable** ON, set Prefix to `LAURA:` (or your choice), keep **Chunk** ON.

4. **Test**
   - Send a message that starts with your prefix (e.g., `LAURA: Hello, test.`)
   - It should play and **not** speak the prefix word.

## Endpoints
- `POST /tts`
  - JSON: `{ "text": "string", "chunk": bool, "max_chars": int }`
  - Returns: synthesized audio of the last chunk (client may GET `/latest` as well)
- `GET /latest`
  - Returns latest audio file (MP3 or AIFF)

## Troubleshooting
- **“Skipped (prefix required)”** → Your message didn’t start with the configured prefix.
- **Mac voice instead of ElevenLabs** → Ensure both `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are set before launching.
- **Short/clipped audio** → Make sure only one userscript is enabled; 1.10c waits for streaming to finish.
- **Autoplay blocked** → Click **▶ Play last** once to prime the audio context.
- **429 rate limit** → The userscript has backoff; you can reduce message size (keep `Max` ~600) and avoid rapid consecutive sends.

## Security & Privacy
- The bridge binds to **127.0.0.1** (localhost) only.
- No telemetry; files are stored under `./audio/` locally.

## License
MIT — see `LICENSE`.
