# Unshelf — design

**Date:** 2026-11-06
**Status:** approved

## Problem

Saved Instagram Reels accumulate faster than they get used. The knowledge inside
them — a writing technique, a book recommendation, a YouTube link — is trapped in
video and disappears when the saved item is cleared. Instagram does not expose
Reel transcripts, so the only reliable route is: fetch the audio, transcribe it,
and keep the text.

## Shape

Chrome extension for all UI, plus a small localhost helper for the parts Chrome
cannot do reliably.

```
Chrome extension (popup, batch, history, settings)
        │  HTTP on 127.0.0.1:8765
        ▼
Unshelf Bridge (Python, no UI)
  ├─ yt-dlp  → Reel metadata + audio
  ├─ Groq    → whisper-large-v3-turbo (free key, fast)
  └─ Whisper → faster-whisper local fallback (private)
```

A pure extension is rejected: Instagram media URLs are protected and
CORS-blocked, and Whisper is too heavy for a browser extension. A hosted website
is rejected: datacenter IPs get blocked, cookies are a security problem, and
transcription costs would make it non-free.

## User flow

1. Open a Reel and click the Unshelf toolbar icon.
2. The popup detects the Reel URL. Click **Transcribe this Reel**.
3. The bridge job moves through `fetching → transcribing → done`.
4. Result shows title, creator, caption, transcript, key lines, and links.
5. Actions: copy note, save Markdown, open Reel.
6. **Batch** tab accepts up to 50 URLs; bridge processes them sequentially.
7. **History** keeps the last 200 notes in `chrome.storage.local`, searchable
   and exportable.

## Bridge API

- `GET /v1/health` — bridge version, yt-dlp version, model availability.
- `POST /v1/jobs` — `{url, provider, groqKey?, model, cookiesBrowser?, language?}`.
  Returns `{id}` immediately.
- `GET /v1/jobs/{id}` — `{status, stage, result?, error?}`.
- Jobs run in a single-worker pool. Results live in memory for one hour.
- Bound to `127.0.0.1`; CORS allows `chrome-extension://` origins only.
- The Groq key is stored in the extension and sent only to localhost. It is
  never logged.

## Providers

**Auto** (default): Groq when a key is present, otherwise local Whisper. If Groq
fails, fall back to local when possible.

**Groq:** `POST https://api.groq.com/openai/v1/audio/transcriptions` with
`whisper-large-v3-turbo`. Free plan is sufficient for 20–50 Reels/day. Audio
must be under 25 MB.

**Local:** `faster-whisper` on CPU, `int8`, model `small` by default. Model is
downloaded once to `bridge/models/`. No audio leaves the machine.

## Failure handling

- Private/login-walled Reel → optional `--cookies-from-browser` with a clear
  error if the selected browser cannot be read.
- No speech → return caption and explain that no speech was detected.
- Groq 429 / size / network → automatic local fallback in Auto mode.
- Bridge offline → popup shows a one-click setup card.
- Deleted/age-restricted Reel → original yt-dlp error, trimmed to one line.

## Extension pages

- `popup.html` — Capture / Batch / History, 400×640, result detail view.
- `options.html` — provider, Groq key, model, cookies, bridge URL, test button.
- No content script and no Instagram host permission. Only `activeTab`,
  `storage`, `downloads`, and `http://127.0.0.1:8765/*`.

## Visual direction

Editorial field notebook: near-black ink, parchment text, signal orange.
Fraunces for display, Instrument Sans for UI, IBM Plex Mono for metadata.
Subtle grain, thin rules, staggered reveals, an orange progress spine. No
generic purple gradients or dashboard cards.

## Out of scope

- Automatically unsaving or modifying Instagram posts.
- Downloading video to keep.
- Cloud sync or a hosted service.
- Summarizing with an LLM in v1. Key lines are extractive and local.
