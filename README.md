# Unshelf

> **Keep the idea. Lose the scroll.**  
> Turn saved Instagram Reels into clean, searchable Markdown notes: full transcript, key highlights, and links. Free and local-first.

---

## Why Unshelf?

Saved Reels accumulate faster than they get watched. The ideas inside them — book recommendations, coding tricks, writing advice, recipes — are trapped inside video and lost forever when you clear your saved collection.

Unshelf lets you clear your Instagram Saved folder without losing the knowledge:
- **Instant extraction:** Transcribes speech into text and captures caption, title, creator, duration, and hashtags.
- **Key takeaways & links:** Extracts highlighted quotes and mentioned URLs directly into Markdown.
- **100% Free & Local-First:** No paid subscriptions, no telemetry, no cloud lock-in. Notes stay in your Chrome profile.

---

## Architecture

```text
Chrome Extension (Popup, Batch, History, Settings)
        │
        │  Local HTTP (127.0.0.1:8765)
        ▼
Unshelf Bridge (Python Service)
   ├── yt-dlp         → Fetches Reel audio & metadata
   ├── Groq API       → whisper-large-v3-turbo (Optional: blazing fast, free tier)
   └── Faster-Whisper → Systran/faster-whisper-small (Local fallback: 100% private, runs on CPU)
```

- **Chrome Extension (`unshelf/extension`)**: Beautiful "editorial field notebook" interface (Fraunces + Instrument Sans + IBM Plex Mono).
- **Unshelf Bridge (`unshelf/bridge`)**: Deliberately lightweight localhost helper that does the two things Chrome cannot do natively: download Instagram audio via `yt-dlp` and run speech-to-text.

---

## Quick Start (Windows)

### 1. Install & Set Up the Bridge

Double-click `install-unshelf.bat` (or run in terminal):
```powershell
.\install-unshelf.bat
```
This automatically:
- Creates a virtual environment in `.venv/`
- Installs pinned, verified dependencies (`faster-whisper`, `av==16.0.0`, `yt-dlp>=2026.10.26`, `huggingface_hub`)

### 2. Start the Bridge

Double-click `start-unshelf.bat`:
```powershell
.\start-unshelf.bat
```
You will see:
```text
  UNSHELF  /  keep the idea, lose the scroll
  ------------------------------------------
  Bridge    http://127.0.0.1:8765
  yt-dlp    2026.10.26
  Models    .../unshelf/bridge/models
  Status    waiting for the Chrome extension
  Stop      Ctrl+C
```
*Keep this terminal window running in the background while using Unshelf.*

### 3. Load the Extension in Chrome

1. Open Google Chrome (or Edge / Brave / Arc).
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top right).
4. Click **Load unpacked** (top left).
5. Select the folder:
   ```
   c:\Users\ayyus\Projects\Extension\Unself\unshelf\extension
   ```
6. Click the Extensions (puzzle piece) icon in your toolbar and **Pin** Unshelf.

---

## How to Use

### Single Reel Capture
1. Open any Instagram Reel in Chrome (e.g. `https://www.instagram.com/reel/...`).
2. Click the **Unshelf** icon in your toolbar (or press `Alt+Shift+U`).
3. Unshelf detects the current Reel. Click **Transcribe this Reel**.
4. Read the transcript, copy the note, or click **Save .md** to export your Markdown file.

### Manual Capture
If you are on another tab or have a link copied:
1. Click the Unshelf toolbar icon.
2. Paste any Instagram Reel link into the URL input and click **Transcribe**.

### Batch Transcription
1. Switch to the **Batch** tab in the popup.
2. Paste up to 50 Instagram Reel links (one per line or mixed text).
3. Click **Start batch**.
4. The bridge processes them sequentially in the background. You can close the popup; active jobs will continue running and automatically populate your history.

### History & Export
1. Switch to the **History** tab to search past Reel notes by creator, title, keywords, or hashtags.
2. Click any note to view full details.
3. Click **Export all** in settings to download all saved notes.

---

## Transcription Engines

Configure your engine in **Settings** (gear icon in popup):

| Engine | Speed | Privacy | Setup |
|---|---|---|---|
| **Auto (Recommended)** | Fast (Groq) or Offline (Whisper) | Audio sent to Groq if key is present; otherwise 100% local | Default |
| **Groq (Free Key)** | ~2–5 seconds per Reel | Audio processed via Groq Cloud API | [Get free Groq key](https://console.groq.com/keys) |
| **Local Whisper** | ~15–30 seconds per Reel | 100% on-device CPU, zero data leaves machine | Included `faster-whisper-small` (~460 MB) |

### Groq Free Tier Limits
- 20 Requests / minute
- 2,000 Requests / day
- 8 hours of audio / day
- **Cost:** \$0 / completely free. Plenty for 20–50 Reels daily.

---

## Private or Login-Walled Reels

If Instagram returns `"Instagram would not release this Reel. It may be private or login-walled"`:
1. Open Unshelf **Settings**.
2. Under **Instagram access**, set **Use cookies from** to your browser (`Chrome`, `Edge`, `Firefox`, or `Brave`) where you are logged in.
3. Cookies are read locally by `yt-dlp` and never sent anywhere except Instagram.

---

## File Structure

```text
Unself/
├── unshelf/
│   ├── bridge/
│   │   ├── unshelf_bridge.py      # Localhost HTTP service (port 8765)
│   │   └── models/                # Downloaded local faster-whisper models
│   └── extension/
│       ├── manifest.json          # Chrome MV3 manifest
│       ├── popup.html             # Main popup interface
│       ├── options.html           # Settings & configuration
│       ├── css/                   # Editorial field notebook styling
│       ├── js/                    # Popup, options, bridge client, history
│       ├── fonts/                 # Fraunces, Instrument Sans, IBM Plex Mono
│       └── icons/                 # 16, 32, 48, 128 px icons
├── install-unshelf.bat             # One-click environment setup
├── start-unshelf.bat               # One-click bridge launcher
├── requirements.txt               # Pinned Python dependencies
└── README.md                      # Documentation
```

---

## License

Personal and local open-source use.

