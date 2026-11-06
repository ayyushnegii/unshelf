#!/usr/bin/env python3
"""
Unshelf Bridge
==============

A tiny localhost service that turns an Instagram Reel URL into a transcript.

It is deliberately boring: no web UI, no database, no cloud storage. The Chrome
extension is the interface. This process owns the two things a browser cannot do
reliably: fetching Instagram media, and running a speech model.

Run:
    .venv\\Scripts\\python.exe unshelf\\bridge\\unshelf_bridge.py
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

APP_NAME = "Unshelf Bridge"
APP_VERSION = "1.0.0"
DEFAULT_PORT = 8765
DEFAULT_HOST = "127.0.0.1"

BRIDGE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BRIDGE_DIR / "models"
TMP_DIR = BRIDGE_DIR / "tmp"
LOG_DIR = BRIDGE_DIR / "logs"

GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = os.environ.get("UNSHELF_GROQ_MODEL", "whisper-large-v3-turbo")
GROQ_MAX_BYTES = 25 * 1024 * 1024
MAX_REEL_SECONDS = int(os.environ.get("UNSHELF_MAX_SECONDS", "1200"))

MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
}

STOPWORDS = {
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
    "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
    "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
    "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
    "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
    "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
    "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
    "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
    "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
    "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
    "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't",
    "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
    "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
    "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
    "they've", "this", "those", "through", "to", "too", "under", "until", "up",
    "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
    "weren't", "what", "what's", "when", "when's", "where", "where's", "which",
    "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would",
    "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
    "yourself", "yourselves", "just", "really", "actually", "like", "know",
    "think", "going", "gonna", "want", "got", "get", "make", "thing", "things",
    "one", "two", "also", "now", "right", "okay", "ok", "yeah", "um", "uh",
}


class BridgeError(Exception):
    """A clean, user-facing failure."""


@dataclass
class Job:
    id: str
    url: str
    provider: str
    model: str
    cookies_browser: str
    language: str | None
    groq_key: str = ""
    status: str = "queued"
    stage: str = "queued"
    message: str = "Waiting to start"
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def public(self) -> dict[str, Any]:
        payload = {
            "id": self.id,
            "url": self.url,
            "provider": self.provider,
            "status": self.status,
            "stage": self.stage,
            "message": self.message,
            "error": self.error,
            "createdAt": self.created_at,
        }
        if self.result:
            payload["result"] = self.result
        return payload


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="unshelf-job")
        self._ytdlp_version: str | None = None
        self._models: dict[str, Any] = {}
        self._model_lock = threading.Lock()

    # ---------- public API ----------

    def submit(self, payload: dict[str, Any]) -> Job:
        job = Job(
            id=uuid.uuid4().hex[:12],
            url=payload["url"],
            provider=payload.get("provider", "auto"),
            model=payload.get("model", "small"),
            cookies_browser=payload.get("cookiesBrowser", "none"),
            language=payload.get("language") or None,
            groq_key=str(payload.get("groqKey") or ""),
        )
        with self._lock:
            self._jobs[job.id] = job
            self._prune_locked()
        self._executor.submit(self._run, job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def health(self) -> dict[str, Any]:
        with self._lock:
            jobs = list(self._jobs.values())
        return {
            "ok": True,
            "name": APP_NAME,
            "version": APP_VERSION,
            "ytdlp": self.ytdlp_version(),
            "python": sys.version.split()[0],
            "models": {name: self.model_ready(name) for name in MODEL_REPOS},
            "defaultModel": os.environ.get("UNSHELF_MODEL", "small"),
            "groqEnvKey": bool(os.environ.get("GROQ_API_KEY", "").strip()),
            "activeJobs": sum(1 for j in jobs if j.status in {"queued", "running"}),
            "queuedJobs": sum(1 for j in jobs if j.status == "queued"),
            "maxSeconds": MAX_REEL_SECONDS,
        }

    def ytdlp_version(self) -> str:
        if self._ytdlp_version:
            return self._ytdlp_version
        try:
            out = subprocess.run(
                [sys.executable, "-m", "yt_dlp", "--version"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            self._ytdlp_version = (out.stdout or out.stderr).strip().splitlines()[0]
        except Exception:
            self._ytdlp_version = "unavailable"
        return self._ytdlp_version

    # ---------- job lifecycle ----------

    def _update(self, job: Job, *, status: str | None = None, stage: str | None = None,
                message: str | None = None) -> None:
        with self._lock:
            if status is not None:
                job.status = status
            if stage is not None:
                job.stage = stage
            if message is not None:
                job.message = message
            job.updated_at = time.time()

    def _prune_locked(self) -> None:
        now = time.time()
        stale = [
            jid for jid, job in self._jobs.items()
            if job.status in {"done", "error"} and now - job.updated_at > 3600
        ]
        for jid in stale:
            self._jobs.pop(jid, None)

    def _run(self, job: Job) -> None:
        job_dir = TMP_DIR / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._update(job, status="running", stage="fetching",
                         message="Fetching the Reel")
            info, audio_path = download_reel(
                job.url, job_dir, job.cookies_browser,
                on_status=lambda msg: self._update(job, message=msg),
            )

            caption = (info.get("description") or info.get("title") or "").strip()
            duration = info.get("duration")
            if duration and float(duration) > MAX_REEL_SECONDS:
                raise BridgeError(
                    f"This Reel is {int(float(duration) // 60)} minutes long. "
                    f"The limit is {MAX_REEL_SECONDS // 60} minutes."
                )

            provider = (job.provider or "auto").lower()
            groq_key = (os.environ.get("GROQ_API_KEY", "") or "").strip()
            request_key = job.groq_key.strip()

            used = "local"
            transcript = ""
            language = job.language
            key_lines: list[str] = []

            if provider in {"auto", "groq"} and (request_key or groq_key):
                self._update(job, stage="transcribing",
                             message="Transcribing with Groq")
                try:
                    transcript, language, segments = groq_transcribe(
                        audio_path, request_key or groq_key, job.language
                    )
                    used = "groq"
                    key_lines = extract_key_lines(segments)
                except Exception as exc:
                    if provider == "groq":
                        raise
                    self._update(job, stage="transcribing",
                                 message="Groq failed; switching to local Whisper")
                    transcript, language, segments = self._local_transcribe(
                        job, audio_path
                    )
                    key_lines = extract_key_lines(segments)
            else:
                self._update(job, stage="transcribing",
                             message="Transcribing locally with Whisper")
                transcript, language, segments = self._local_transcribe(
                    job, audio_path
                )
                key_lines = extract_key_lines(segments)

            transcript = clean_transcript(transcript)
            if not transcript and not caption:
                raise BridgeError("No speech or caption was found in this Reel.")

            creator = (
                info.get("uploader")
                or info.get("channel")
                or info.get("uploader_id")
                or "Unknown creator"
            ).lstrip("@")
            title = make_title(caption, creator)
            links = extract_links(f"{caption}\n{transcript}")
            posted = info.get("upload_date") or ""
            if not posted and info.get("timestamp"):
                try:
                    posted = datetime.fromtimestamp(
                        float(info["timestamp"]), tz=timezone.utc
                    ).strftime("%Y-%m-%d")
                except Exception:
                    posted = ""

            result = {
                "url": normalize_instagram_url(job.url),
                "shortcode": info.get("id") or shortcode_from_url(job.url),
                "title": title,
                "creator": creator,
                "caption": caption,
                "postedAt": posted,
                "duration": round(float(duration), 1) if duration else None,
                "thumbnail": info.get("thumbnail") or "",
                "transcript": transcript,
                "keyLines": key_lines,
                "links": links,
                "language": language or "unknown",
                "provider": used,
                "wordCount": len(transcript.split()) if transcript else 0,
                "hashtags": sorted(set(re.findall(r"#([A-Za-z0-9_]+)", caption))),
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
            with self._lock:
                job.result = result
                job.status = "done"
                job.stage = "done"
                job.message = "Note ready"
                job.updated_at = time.time()
        except BridgeError as exc:
            self._fail(job, str(exc))
        except subprocess.TimeoutExpired:
            self._fail(job, "The download took too long. Check the link and try again.")
        except Exception as exc:  # noqa: BLE001 - last-resort user-facing guard
            traceback.print_exc()
            self._fail(job, friendly_exception(exc))
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)

    def _fail(self, job: Job, message: str) -> None:
        with self._lock:
            job.status = "error"
            job.stage = "error"
            job.error = message
            job.message = message
            job.updated_at = time.time()

    def _local_transcribe(self, job: Job, audio_path: Path) -> tuple[str, str, list[str]]:
        model = self.get_local_model(
            job.model,
            on_status=lambda msg: self._update(job, stage="downloading-model", message=msg),
        )
        self._update(job, stage="transcribing", message="Transcribing locally with Whisper")
        return transcribe_local(model, audio_path, job.language)

    # ---------- local model ----------

    def model_ready(self, size: str) -> bool:
        path = MODELS_DIR / f"faster-whisper-{size}"
        return (path / "model.bin").exists()

    def get_local_model(self, size: str,
                        on_status: Callable[[str], None] | None = None) -> Any:
        size = size if size in MODEL_REPOS else "small"
        model_path = MODELS_DIR / f"faster-whisper-{size}"
        with self._model_lock:
            cached = self._models.get(size)
            if cached is not None:
                return cached

            if not (model_path / "model.bin").exists():
                if on_status:
                    on_status(f"Downloading the {size} Whisper model once (about 460 MB)")
                download_model(size, model_path, on_status=on_status)

            if on_status:
                on_status("Loading the local Whisper model")
            from faster_whisper import WhisperModel

            model = WhisperModel(
                str(model_path),
                device="cpu",
                compute_type="int8",
                local_files_only=True,
                cpu_threads=max(2, min(8, (os.cpu_count() or 4) - 1)),
            )
            self._models[size] = model
            return model


# ---------------------------------------------------------------------------
# Downloading
# ---------------------------------------------------------------------------


def download_reel(url: str, job_dir: Path, cookies_browser: str,
                  on_status: Callable[[str], None] | None = None) -> tuple[dict[str, Any], Path]:
    if cookies_browser and cookies_browser != "none":
        if on_status:
            on_status(f"Fetching the Reel using {cookies_browser.title()} cookies")

    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--no-warnings",
        "--no-update",
        "--no-playlist",
        "--write-info-json",
        "-f", "bestaudio/best",
        "-o", str(job_dir / "%(id)s.%(ext)s"),
    ]
    if cookies_browser and cookies_browser != "none":
        cmd += ["--cookies-from-browser", cookies_browser]
    cmd.append(url)

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        useful = [line.strip() for line in detail if line.strip() and not line.startswith("WARNING")]
        raise BridgeError(trim_ytdlp_error(useful[-1] if useful else "Could not fetch this Reel."))

    info_files = list(job_dir.glob("*.info.json"))
    if not info_files:
        raise BridgeError("Instagram returned no metadata for this Reel.")
    info = json.loads(info_files[0].read_text(encoding="utf-8"))

    audio_files = [
        p for p in job_dir.iterdir()
        if p.is_file()
        and p.suffix.lower() not in {".json", ".jpg", ".jpeg", ".png", ".webp", ".part"}
        and p.stat().st_size > 1024
    ]
    if not audio_files:
        raise BridgeError("No audio track was found in this Reel.")
    audio = max(audio_files, key=lambda p: p.stat().st_size)
    if audio.stat().st_size > 200 * 1024 * 1024:
        raise BridgeError("This Reel's audio is too large to process.")
    return info, audio


def trim_ytdlp_error(line: str) -> str:
    line = re.sub(r"^ERROR:\s*", "", line).strip()
    line = re.sub(r"\s+", " ", line)
    lowered = line.lower()
    if "login" in lowered or "cookies" in lowered or "rate-limit" in lowered or "empty media" in lowered:
        return (
            "Instagram would not release this Reel. It may be private or login-walled. "
            "Choose your browser under Cookies in the extension, then try again."
        )
    if "not available" in lowered or "unavailable" in lowered or "removed" in lowered:
        return "This Reel is unavailable, deleted, or region-locked."
    if "unsupported url" in lowered:
        return "That does not look like an Instagram Reel link."
    return line[:280] or "Could not fetch this Reel."


def normalize_instagram_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        raise BridgeError("Paste an Instagram Reel link first.")
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    parsed = urllib.parse.urlparse(raw)
    host = re.sub(r"^(?:www\.|m\.)", "", parsed.netloc.lower())
    if host not in {"instagram.com", "instagr.am"}:
        raise BridgeError("That link is not from Instagram.")
    match = re.search(r"/(reel|p|tv)/([A-Za-z0-9_-]+)", parsed.path)
    if not match:
        raise BridgeError("That Instagram link is not a Reel or video post.")
    return f"https://www.instagram.com/{match.group(1)}/{match.group(2)}/"


def shortcode_from_url(raw: str) -> str:
    match = re.search(r"/(?:reel|p|tv)/([A-Za-z0-9_-]+)", raw)
    return match.group(1) if match else ""


# ---------------------------------------------------------------------------
# Groq
# ---------------------------------------------------------------------------


def groq_transcribe(audio_path: Path, api_key: str,
                    language: str | None) -> tuple[str, str, list[str]]:
    if not api_key:
        raise BridgeError("No Groq API key was provided.")
    if audio_path.stat().st_size > GROQ_MAX_BYTES:
        raise BridgeError("Audio is over Groq's 25 MB limit; using local Whisper.")

    boundary = f"----Unshelf{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
            f"{value}\r\n".encode("utf-8")
        )

    field("model", GROQ_MODEL)
    field("response_format", "verbose_json")
    field("temperature", "0")
    if language:
        field("language", language)

    mime = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    parts.append(
        (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{audio_path.name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
    )
    parts.append(audio_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        GROQ_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "User-Agent": f"Unshelf/{APP_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        message = raw
        try:
            parsed = json.loads(raw)
            message = parsed.get("error", {}).get("message") or raw
        except Exception:
            pass
        if exc.code == 401:
            raise BridgeError("Groq rejected the API key. Check it in Settings.") from exc
        if exc.code == 429:
            raise BridgeError("Groq's free limit is busy right now. Try again shortly.") from exc
        raise BridgeError(f"Groq error {exc.code}: {message[:220]}") from exc
    except urllib.error.URLError as exc:
        raise BridgeError(f"Could not reach Groq: {exc.reason}") from exc

    text = (payload.get("text") or "").strip()
    segments = [
        (s.get("text") or "").strip()
        for s in payload.get("segments", [])
        if (s.get("text") or "").strip()
    ]
    if not text and segments:
        text = " ".join(segments)
    if not text:
        raise BridgeError("Groq returned an empty transcript.")
    return text, payload.get("language") or (language or "unknown"), segments


def validate_groq_key(api_key: str) -> tuple[bool, str]:
    api_key = (api_key or "").strip()
    if not api_key:
        return False, "Enter a Groq key first."
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/models",
        headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"Unshelf/{APP_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                return True, "Groq API key is valid."
            return False, f"Groq returned status {resp.status}."
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return False, "Groq rejected the API key (401 Unauthorized)."
        if exc.code == 429:
            return False, "Groq rate limit reached (429 Too Many Requests)."
        return False, f"Groq error ({exc.code})."
    except Exception as exc:
        return False, f"Could not connect to Groq: {exc}"


# ---------------------------------------------------------------------------
# Local Whisper
# ---------------------------------------------------------------------------


def download_model(size: str, model_path: Path,
                   on_status: Callable[[str], None] | None = None) -> None:
    model_path.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise BridgeError(
            "The local transcription package is missing. Run install-unshelf.bat."
        ) from exc
    repo = MODEL_REPOS.get(size, MODEL_REPOS["small"])
    if on_status:
        on_status(f"Downloading the {size} Whisper model (one time)")
    try:
        snapshot_download(repo_id=repo, local_dir=str(model_path))
    except Exception as exc:
        raise BridgeError(f"Could not download the local model: {exc}") from exc
    if not (model_path / "model.bin").exists():
        raise BridgeError("The local model download did not finish. Try again.")


def transcribe_local(model: Any, audio_path: Path,
                     language: str | None) -> tuple[str, str, list[str]]:
    try:
        segments_iter, info = model.transcribe(
            str(audio_path),
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            language=language or None,
        )
        texts: list[str] = []
        for segment in segments_iter:
            text = (segment.text or "").strip()
            if text:
                texts.append(text)
    except Exception as exc:
        raise BridgeError(f"Local transcription failed: {exc}") from exc

    text = join_segments(texts)
    if not text:
        raise BridgeError("Whisper could not find speech in this Reel.")
    return text, getattr(info, "language", None) or (language or "unknown"), texts


def join_segments(segments: list[str]) -> str:
    paragraphs: list[str] = []
    current: list[str] = []
    for seg in segments:
        current.append(seg)
        if len(current) >= 5 and seg.endswith((".", "?", "!")):
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(p.strip() for p in paragraphs if p.strip())


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------


def clean_transcript(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def make_title(caption: str, creator: str) -> str:
    first = next((line.strip() for line in caption.splitlines() if line.strip()), "")
    first = re.sub(r"https?://\S+", "", first).strip(" -–—|")
    if not first:
        return f"Reel by {creator}"
    if len(first) > 86:
        first = first[:83].rsplit(" ", 1)[0] + "…"
    return first


def extract_links(text: str) -> list[str]:
    found = re.findall(r"https?://[^\s<>\"')\]]+", text or "")
    bare = re.findall(r"(?<![\w/])((?:www\.)?(?:youtube\.com|youtu\.be|instagram\.com|tiktok\.com)/[^\s<>\"')\]]+)", text or "")
    found.extend("https://" + item for item in bare)
    links: list[str] = []
    for raw in found:
        link = raw.rstrip(".,;:!?*_~")
        if link not in links:
            links.append(link)
    return links[:20]


def extract_key_lines(segments: list[str], limit: int = 4) -> list[str]:
    """Extractive highlights: frequent, specific, early sentences."""
    text = " ".join(segments)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    candidates = [
        s.strip() for s in sentences
        if 42 <= len(s.strip()) <= 240 and len(s.split()) >= 7
    ]
    if not candidates:
        candidates = [s.strip() for s in segments if 30 <= len(s.strip()) <= 240]
    if not candidates:
        return []

    freq: dict[str, int] = {}
    for word in re.findall(r"[A-Za-z][A-Za-z'-]+", text.lower()):
        if word not in STOPWORDS and len(word) > 2:
            freq[word] = freq.get(word, 0) + 1
    if not freq:
        return candidates[:limit]

    top = max(freq.values())
    scored: list[tuple[float, int, str]] = []
    for index, sentence in enumerate(candidates):
        words = [
            w for w in re.findall(r"[A-Za-z][A-Za-z'-]+", sentence.lower())
            if w not in STOPWORDS
        ]
        if not words:
            continue
        score = sum(freq.get(w, 0) / top for w in words) / (len(words) ** 0.55)
        score += max(0.0, 0.35 - index * 0.03)
        if re.search(r"\b(how|why|because|should|never|always|best|worst|secret|rule|step)\b", sentence.lower()):
            score += 0.18
        scored.append((score, index, sentence))

    chosen = sorted(scored, key=lambda item: item[0], reverse=True)[:limit]
    chosen.sort(key=lambda item: item[1])
    return [sentence for _, _, sentence in chosen]


def friendly_exception(exc: Exception) -> str:
    text = str(exc).strip()
    if isinstance(exc, FileNotFoundError):
        return "A required file was missing. Re-run install-unshelf.bat."
    if "No space left" in text or "disk" in text.lower():
        return "The disk is full while processing this Reel."
    return text[:280] or "Something went wrong while processing this Reel."


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class UnshelfHandler(BaseHTTPRequestHandler):
    server_version = f"Unshelf/{APP_VERSION}"
    manager: JobManager

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")

    # ---------- helpers ----------

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "")
        if not origin:
            return True
        return origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Unshelf-Client")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 1_000_000:
            raise BridgeError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise BridgeError("Invalid JSON request.") from exc
        if not isinstance(payload, dict):
            raise BridgeError("Invalid request.")
        return payload

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Origin not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Origin not allowed"})
            return
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            body = (
                "Unshelf Bridge is running.\n"
                "The Chrome extension talks to this service. You can close this tab.\n"
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/v1/health":
            self._send_json(HTTPStatus.OK, self.manager.health())
            return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9]+)", path)
        if match:
            job = self.manager.get(match.group(1))
            if not job:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Job not found"})
                return
            self._send_json(HTTPStatus.OK, job.public())
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Origin not allowed"})
            return
        path = urllib.parse.urlparse(self.path).path
        if path == "/v1/test-key":
            try:
                payload = self._read_json()
                key = str(payload.get("groqKey") or payload.get("key") or "")
                ok, msg = validate_groq_key(key)
                if ok:
                    self._send_json(HTTPStatus.OK, {"ok": True, "message": msg})
                else:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": msg})
            except Exception as exc:  # noqa: BLE001
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": friendly_exception(exc)})
            return
        if path != "/v1/jobs":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        try:
            payload = self._read_json()
            url = normalize_instagram_url(payload.get("url", ""))
            provider = str(payload.get("provider", "auto")).lower()
            if provider not in {"auto", "groq", "local"}:
                provider = "auto"
            model = str(payload.get("model", "small")).lower()
            if model not in MODEL_REPOS:
                model = "small"
            cookies = str(payload.get("cookiesBrowser", "none")).lower()
            if cookies not in {"none", "chrome", "edge", "firefox", "brave", "opera"}:
                cookies = "none"
            job_payload = {
                "url": url,
                "provider": provider,
                "model": model,
                "cookiesBrowser": cookies,
                "language": payload.get("language") or None,
                "groqKey": str(payload.get("groqKey") or ""),
            }
            job = self.manager.submit(job_payload)
            self._send_json(HTTPStatus.ACCEPTED, {"id": job.id, "status": job.status})
        except BridgeError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": friendly_exception(exc)})


def run_server(host: str, port: int) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    manager = JobManager()
    UnshelfHandler.manager = manager

    httpd = ThreadingHTTPServer((host, port), UnshelfHandler)
    httpd.daemon_threads = True

    print()
    print("  UNSHELF  /  keep the idea, lose the scroll")
    print("  ------------------------------------------")
    print(f"  Bridge    http://{host}:{port}")
    print(f"  yt-dlp    {manager.ytdlp_version()}")
    print(f"  Models    {MODELS_DIR}")
    print("  Status    waiting for the Chrome extension")
    print("  Stop      Ctrl+C")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopping Unshelf Bridge.")
    finally:
        httpd.server_close()
        manager._executor.shutdown(wait=False, cancel_futures=True)  # noqa: SLF001


def main() -> None:
    parser = argparse.ArgumentParser(description="Unshelf local bridge")
    parser.add_argument("--host", default=os.environ.get("UNSHELF_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("UNSHELF_PORT", DEFAULT_PORT)))
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
