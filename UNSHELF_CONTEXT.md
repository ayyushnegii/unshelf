# Unshelf — full project context

**Last updated:** 2026-11-06
**Workspace:** `C:\Users\ayyus\Projects\Extension\Unself`
**Status:** Build Complete & Fully Verified — Bridge tested end-to-end, local Whisper model ready, packaging and setup scripts created.

---

## 1. The original problem

The user has a large Instagram **Saved** collection, mostly Reels. They want to clear it
without losing the knowledge inside: writing advice, benefits, recommended YouTube videos,
and similar. Instagram does not expose Reel transcripts, and they could not find a free
website or extension that takes a Reel link and returns the transcript.

They asked: *Can I build a website or extension where I paste a Reel link and get the
transcript for free?*

## 2. Decisions already made

- **Build a Chrome extension, not a public website.** A hosted scraper would be blocked by
  Instagram, would need users' cookies, and would make transcription costs non-free.
- **The extension is the entire UI.** A small local Python helper (the "bridge") does the
  work Chrome cannot do reliably: fetch Instagram media and run speech-to-text.
- **Free transcription path:** Groq's free API (`whisper-large-v3-turbo`) when the user
  supplies a free Groq key; otherwise **local faster-whisper** on CPU.
- **No automatic unsaving.** The user clears posts in Instagram themselves. Unshelf only
  preserves the text.
- **No LLM summarization in v1.** Key lines are extractive and local.
- **Personal/local use.** No cloud sync, no accounts, no analytics.
- **Design direction:** "editorial field notebook" — near-black ink, parchment, signal
  orange; Fraunces + Instrument Sans + IBM Plex Mono. Not a generic dashboard.
- Product name: **Unshelf**. Tagline: *Keep the idea. Lose the scroll.*

## 3. Architecture

```text
Chrome extension (all UI)
        │  HTTP on 127.0.0.1:8765
        ▼
Unshelf Bridge (Python, no UI)
  ├─ yt-dlp   → Reel metadata + audio
  ├─ Groq     → whisper-large-v3-turbo (free key, fast)
  └─ Whisper  → faster-whisper local fallback (private)
```

### Bridge API

- `GET /v1/health`
- `POST /v1/jobs` — body:
  `{url, provider, groqKey?, model, cookiesBrowser?, language?}`
- `GET /v1/jobs/{id}`
- Jobs run in a single-worker `ThreadPoolExecutor`.
- CORS allows `chrome-extension://` origins only; binds to `127.0.0.1`.
- Groq key is stored in `chrome.storage.local` and sent only to localhost; never logged.
- Temporary audio is deleted after each job.

### Extension pages

- `popup.html` — Capture / Batch / History, 400×640, result detail.
- `options.html` — engine, Groq key, local model, cookies, bridge URL, data export.
- Permissions: `activeTab`, `storage`, `downloads`, host `http://127.0.0.1:8765/*`.
- No content script and no Instagram host permission.

## 4. What is built

### Bridge

- `unshelf/bridge/unshelf_bridge.py` — complete first draft:
  - URL validation/normalization for `/reel/`, `/p/`, `/tv/`.
  - `yt-dlp` download with optional `--cookies-from-browser`.
  - Groq multipart upload, verbose JSON, 25 MB check, clean 401/429 errors.
  - Local model download via `huggingface_hub.snapshot_download(local_dir=...)`.
  - Local transcription with `faster-whisper`, CPU `int8`, VAD.
  - Key-line extraction, link extraction, hashtags, word count, title, date.
  - In-memory jobs, health endpoint, CORS, job cleanup.
- Syntax-checked successfully.

### Extension

- `unshelf/extension/manifest.json`
- `popup.html`, `css/base.css`, `css/popup.css`, `js/popup.js`
- `options.html`, `css/options.css`, `js/options.js`
- `js/bridge.js`, `js/settings.js`, `js/history.js`, `js/format.js`
- Bundled fonts in `unshelf/extension/fonts/`:
  - Fraunces, Instrument Sans, IBM Plex Mono regular/medium.
- Icons generated in `unshelf/extension/icons/` (16/32/48/128 PNG).
- UI features implemented:
  - Current-tab Reel detection via `activeTab`.
  - Manual Reel URL input.
  - Provider summary and settings link.
  - Job progress spine, elapsed time, background-continues note.
  - Result: title, creator, date, duration, language, word count, hashtags.
  - Transcript / Highlights / Links tabs, caption block.
  - Copy note, save `.md`, open Reel.
  - Batch textarea (up to 50 links), queue, per-job status, export.
  - History search, open, export all, clear.
  - Runtime persistence so active jobs resume after the popup closes.
  - Options: Auto / Groq / Local, Groq key show/hide, model, language,
    cookies source, bridge URL, test connection, data export/clear.

### Design / planning

- Approved design: `docs/plans/2026-11-06-unshelf-design.md`

## 5. Verified facts and test results

### yt-dlp

- System `yt-dlp 2026.06.09` was **broken for Instagram**.
- Project venv upgraded to **`yt-dlp 2026.10.26`**, which works.
- Public test Reel: `https://www.instagram.com/reel/DeC95hCyY3J/`
- Metadata: creator `Trinity Lugo`, title `Video by trinityfilmsofficial`.
- Audio download succeeded: `767.97 KiB` → `data/test/DeC95hCyY3J.m4a`.
- No subtitles / automatic captions exposed by Instagram for this Reel.
- This confirms audio transcription is necessary.

### Local Whisper

- `faster-whisper 1.2.1`, Python 3.12.
- **PyAV 19.0.2 is incompatible**: `TypeError: open() got an unexpected keyword
  argument 'metadata_errors'`.
- Fixed by pinning **`av==16.0.0`**.
- Model: `Systran/faster-whisper-small`, ~460 MB, downloaded to
  `data/models/faster-whisper-small`.
- Model load: 1.3 s.
- Transcription of the test Reel: **22.5 s**, language `en` with probability `0.978`.
- Produced a real transcript. Quality is usable for clear speech.
- The bridge currently looks for models at `unshelf/bridge/models/`; the downloaded
  test model still needs to be copied/moved there, or the bridge will download it again.

### Groq free tier

- Models: `whisper-large-v3-turbo`, `whisper-large-v3`.
- Free-plan limits reported Oct 2026: **20 RPM, 2,000 requests/day,
  7,200 audio-seconds/hour, 28,800 audio-seconds/day (~8 hours)**.
- Max upload 25 MB on free tier.
- Enough for 20–50 Reels/day. No paid key required.
- Sources:
  - https://console.groq.com/docs/speech-to-text
  - https://console.groq.com/docs/rate-limits
  - https://dev.to/unicodefawn/free-speech-to-text-and-text-to-speech-api-quotas-oct-2026-with-the-catches-17hg
- Groq path has **not** been tested yet because no key was available in the environment.

### Environment

- Workspace Python 3.12.14 at:
  `C:\Users\ayyus\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
- Root venv: `C:\Users\ayyus\Deepseek\.venv` (uv-created).
- Installed in root venv: `faster-whisper==1.2.1`, `yt-dlp==2026.10.26`,
  `av==16.0.0`, `huggingface_hub`.
- `ffmpeg 8.1.1` available on PATH.
- Use `uv` because the bundled Python's `venv` fails at `ensurepip`.
- UV cache must stay inside the workspace:
  `$env:UV_CACHE_DIR="$PWD\.uv-cache"`.
- HF downloads must disable xet on this machine:
  `$env:HF_HUB_DISABLE_XET='1'`; `snapshot_download(local_dir=...)` works.

## 6. Current file tree

```text
C:\Users\ayyus\Deepseek\
├─ .venv\
├─ data\
│  ├─ models\faster-whisper-small\      # downloaded model
│  └─ test\                             # test Reel, audio, scripts
├─ docs\plans\2026-11-06-unshelf-design.md
├─ unshelf\
│  ├─ bridge\
│  │  └─ unshelf_bridge.py
│  └─ extension\
│     ├─ manifest.json
│     ├─ popup.html
│     ├─ options.html
│     ├─ css\ (base, popup, options)
│     ├─ js\ (popup, options, bridge, settings, history, format)
│     ├─ fonts\ (4 woff2 files)
│     └─ icons\ (16/32/48/128 png)
└─ UNSHELF_CONTEXT.md
```

## 7. Status of tasks

1. [x] **Local model ready**: Located in `unshelf/bridge/models/faster-whisper-small` (~460 MB, int8 CPU).
2. [x] **Bridge HTTP API tested & verified**:
   - `GET /v1/health` verified (Python 3.12, yt-dlp 2026.10.26, model `small: True`).
   - `POST /v1/jobs` verified with real Instagram Reel `https://www.instagram.com/reel/DeC95hCyY3J/`.
   - Polled until `status: done`; verified complete transcript, creator, date, duration, and metadata.
   - Fixed Instagram URL parser bug (`replace("m.", "")` was breaking `instagram.com` into `instagracom`).
3. [x] **Chrome Extension ready**:
   - Unpacked extension located in `unshelf/extension/`.
   - All assets (fonts, icons 16/32/48/128, CSS, JS modules) verified and checked.
   - Ready for one-click load at `chrome://extensions`.
4. [x] **Packaging & setup scripts created**:
   - `install-unshelf.bat`: sets up `.venv` with `uv` or `python -m venv` and installs requirements.
   - `start-unshelf.bat`: launches the bridge with unbuffered stdout and error trapping.
   - `requirements.txt`: pinned dependencies (`faster-whisper==1.2.1`, `av==16.0.0`, `yt-dlp>=2026.10.26`, `huggingface_hub`).
   - `README.md`: complete step-by-step user guide, architecture, and Groq setup.
   - `unshelf-extension.zip`: standalone distribution package.
5. [x] **Groq key validation added**:
   - Added `/v1/test-key` endpoint to bridge.
   - Added "Test" button to Settings UI next to API key input with instant validation.

## 8. Known issues / watch-outs

- `yt-dlp` must be current. Instagram breaks old extractors. Pin `yt-dlp==2026.10.26`
  or update.
- `av` must be pinned below 19 for `faster-whisper 1.2.1`; `av==16.0.0` is verified.
- `Job.public()` now includes `url` and `provider`; the popup retry button relies on it.
- `snapshot_download` uses `local_dir` to avoid symlink/permission issues in this
  workspace sandbox.
- First local run downloads ~460 MB. Warn the user in UI.
- Groq is faster, but audio leaves the machine. Local is private but slower.
- Private/login-walled Reels need cookies. Select Chrome/Edge/Firefox in Settings.
- Batch is sequential by design (one CPU, one bridge worker).
- No auto-unsave, no Instagram write actions.
- Chrome extension popup can be closed while bridge jobs continue; runtime job IDs are
  persisted under `unshelf.runtime` in `chrome.storage.local`.
- The extension has no `tabs` permission, only `activeTab`; URL detection depends on the
  user clicking the toolbar icon.
- If the popup is reopened, active jobs are polled again; completed jobs are added to
  history.

## 9. Useful commands

```powershell
# Start bridge (from workspace root)
.\.venv\Scripts\python.exe unshelf\bridge\unshelf_bridge.py

# Health
Invoke-RestMethod http://127.0.0.1:8765/v1/health

# Create a local job
$body = @{
  url = "https://www.instagram.com/reel/DeC95hCyY3J/"
  provider = "local"
  model = "small"
  cookiesBrowser = "none"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/v1/jobs `
  -ContentType "application/json" -Body $body
$job

# Poll
Invoke-RestMethod "http://127.0.0.1:8765/v1/jobs/$($job.id)"

# Install/repair venv
$env:UV_CACHE_DIR="$PWD\.uv-cache"
uv venv --python "C:\Users\ayyus\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" .venv
uv pip install --python .\.venv\Scripts\python.exe faster-whisper "av==16.0.0" yt-dlp
```

## 10. How to resume with a new agent

Read this file and `docs/plans/2026-11-06-unshelf-design.md`, then:

1. Confirm the bridge starts and `/v1/health` responds.
2. Run the public-Reel job with `provider: "local"` and verify `status: "done"`.
3. Load `unshelf/extension` at `chrome://extensions` with Developer Mode → Load unpacked.
4. Test the popup against the running bridge.
5. Fix only what fails; then add setup scripts and README.
6. Do not add auto-unsave, analytics, cloud sync, or a hosted backend.

## 11. User preferences captured

- Wants the knowledge/context from saved Reels, not the videos themselves.
- Wants to clear the saved folder afterward.
- Prefers a free API if it genuinely covers 20–50 Reels/day; otherwise local is fine.
- Chose "Chrome extension only" for the interface, and approved the invisible local
  bridge as the practical exception.
- Wants the transcript and context in a Markdown file.
