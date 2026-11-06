import { Bridge, BridgeError } from "./bridge.js";
import { getSettings, providerLabel, providerShort, saveSettings } from "./settings.js";
import { getHistory, addHistory, clearHistory, searchHistory } from "./history.js";
import {
  escapeHtml,
  safeHttpUrl,
  isInstagramReel,
  normalizeReelUrl,
  parseReelUrls,
  compactUrl,
  formatDuration,
  formatDate,
  formatDateShort,
  plural,
  providerName,
  noteMarkdown,
  markdownFilename,
  downloadText,
  copyText,
} from "./format.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  capture: $("#captureMount"),
  batch: $("#batchMount"),
  history: $("#historyMount"),
  tabs: {
    capture: $("#tabCapture"),
    batch: $("#tabBatch"),
    history: $("#tabHistory"),
  },
  views: {
    capture: $("#viewCapture"),
    batch: $("#viewBatch"),
    history: $("#viewHistory"),
  },
  batchBadge: $("#batchBadge"),
  bridgePill: $("#bridgePill"),
  bridgeLabel: $("#bridgeLabel"),
  footerStats: $("#footerStats"),
  toast: $("#toast"),
};

const state = {
  settings: null,
  bridge: null,
  health: null,
  history: [],
  activeTabUrl: "",
  tab: "capture",
  view: "idle",
  jobs: new Map(),
  active: new Set(),
  batchIds: [],
  currentJobId: null,
  currentItem: null,
  currentErrorJob: null,
  resultOrigin: "capture",
  historyQuery: "",
  batchInput: "",
  busyStarting: false,
  startError: "",
  pollTimer: null,
  healthTimer: null,
};

const ICONS = {
  instagram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"></circle></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"></path></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"></path></svg>`,
};

/* ------------------------------------------------------------------ boot */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindStatic();
  state.settings = await getSettings();
  state.bridge = new Bridge(state.settings.bridgeUrl);
  state.history = await getHistory();
  state.activeTabUrl = await activeTabUrl();

  const stored = await chrome.storage.local.get("unshelf.runtime");
  const runtime = stored["unshelf.runtime"] || {};
  state.batchIds = Array.isArray(runtime.batchIds) ? runtime.batchIds : [];
  for (const id of runtime.activeJobIds || []) {
    if (!state.jobs.has(id)) {
      state.jobs.set(id, { id, url: "", job: null, startedAt: Date.now() / 1000 });
    }
    state.active.add(id);
  }
  state.currentJobId = runtime.currentJobId || null;

  await refreshHealth();

  if (state.active.size > 0) {
    if (state.currentJobId && state.jobs.has(state.currentJobId)) {
      state.view = "job";
    }
    await pollActive({ quiet: true });
  }

  renderAll();
  state.healthTimer = setInterval(refreshHealth, 20000);
}

function bindStatic() {
  els.tabs.capture.addEventListener("click", () => switchTab("capture"));
  els.tabs.batch.addEventListener("click", () => switchTab("batch"));
  els.tabs.history.addEventListener("click", () => switchTab("history"));

  $("#brandBtn").addEventListener("click", () => {
    state.view = "idle";
    state.currentJobId = null;
    switchTab("capture");
  });

  $("#settingsBtn").addEventListener("click", openOptions);
  els.bridgePill.addEventListener("click", async () => {
    await refreshHealth();
    renderAll();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !changes.settings) return;
    state.settings = { ...state.settings, ...(changes.settings.newValue || {}) };
    state.bridge = new Bridge(state.settings.bridgeUrl);
    await refreshHealth();
    renderAll();
  });
}

/* --------------------------------------------------------------- health */

async function refreshHealth() {
  try {
    state.health = await state.bridge.health();
  } catch {
    state.health = null;
  }
  updateChrome();
}

function updateChrome() {
  const online = Boolean(state.health?.ok);
  const working = online && state.active.size > 0;
  els.bridgePill.classList.toggle("is-online", online && !working);
  els.bridgePill.classList.toggle("is-busy", working);
  els.bridgePill.classList.toggle("is-offline", !online);
  els.bridgeLabel.textContent = !online ? "Offline" : working ? "Working" : "Bridge on";

  for (const [name, button] of Object.entries(els.tabs)) {
    const active = state.tab === name;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }

  els.batchBadge.hidden = state.active.size === 0;
  els.batchBadge.textContent = String(state.active.size);

  const count = state.history.length;
  els.footerStats.textContent = count === 0 ? "0 notes" : plural(count, "note");
}

/* ---------------------------------------------------------------- tabs */

function switchTab(tab) {
  state.tab = tab;
  for (const [name, view] of Object.entries(els.views)) {
    view.classList.toggle("is-active", name === tab);
  }
  updateChrome();
  renderTab();
}

function renderAll() {
  updateChrome();
  renderTab();
}

function renderTab() {
  if (state.tab === "capture") renderCapture();
  if (state.tab === "batch") renderBatch();
  if (state.tab === "history") renderHistory();
}

/* -------------------------------------------------------------- capture */

function renderCapture() {
  if (state.view === "result" && state.currentItem) {
    els.capture.innerHTML = resultTemplate(state.currentItem);
    bindResult(state.currentItem);
    return;
  }
  if (state.view === "error" && state.currentErrorJob) {
    els.capture.innerHTML = errorTemplate(state.currentErrorJob);
    bindError(state.currentErrorJob);
    return;
  }
  if (state.view === "job" && state.currentJobId) {
    const entry = state.jobs.get(state.currentJobId);
    els.capture.innerHTML = jobTemplate(entry);
    bindJob(entry);
    return;
  }
  els.capture.innerHTML = idleTemplate();
  bindIdle();
}

function idleTemplate() {
  const detected = normalizeReelUrl(state.activeTabUrl);
  const online = Boolean(state.health?.ok);
  const settings = state.settings;
  const missingKey = settings.provider === "groq" && !settings.groqKey;
  const localModel = settings.model || "small";
  const modelReady = Boolean(state.health?.models?.[localModel]);
  const provider = providerLabel(settings);
  const startDisabled = !online || missingKey || state.busyStarting;
  const startLabel = state.busyStarting
    ? "Starting…"
    : settings.provider === "groq"
      ? "Transcribe with Groq"
      : settings.provider === "local"
        ? "Transcribe locally"
        : settings.groqKey
          ? "Transcribe this Reel"
          : "Transcribe locally";
  const engineNote =
    settings.provider === "local" || (!settings.groqKey && settings.provider !== "groq")
      ? modelReady
        ? "Audio stays on this machine."
        : `First run downloads the ${localModel} model once.`
      : settings.groqKey
        ? "Audio goes to Groq for transcription."
        : "Add a free Groq key, or use local Whisper.";

  const background = [...state.active][0];
  const backgroundEntry = background ? state.jobs.get(background) : null;

  return `
    <section class="stagger">
      <div class="hero">
        <p class="eyebrow">${detected ? "Current tab" : "New note"}</p>
        <h1 class="display">Turn a Reel into a <em>note.</em></h1>
        <p class="hero-note">Keep the transcript, the key lines, and the links. Then clear the saved folder without losing the idea.</p>
      </div>

      ${
        online
          ? ""
          : `<div class="notice" style="margin-bottom:14px">
              <p class="notice-title">
                <span class="status-dot" style="background:var(--red)"></span>
                The bridge is off.
              </p>
              <p>Run the local helper once, then leave its window open. It does the downloading and transcription.</p>
              <div class="code-line"><code>unshelf\\start-unshelf.bat</code><button class="text-link" type="button" data-action="copy-command">Copy</button></div>
              <button class="btn btn-sm" type="button" data-action="retry-bridge">Retry connection</button>
            </div>`
      }

      ${
        state.startError
          ? `<div class="notice" style="margin-bottom:14px"><p class="notice-title">Could not start</p><p>${escapeHtml(state.startError)}</p></div>`
          : ""
      }

      ${
        detected
          ? `<div class="url-card">
              <span class="url-mark">${ICONS.instagram}</span>
              <div class="url-copy">
                <div class="url-label">Reel detected <span class="chip chip-green">ready</span></div>
                <div class="url-value">${escapeHtml(compactUrl(detected))}</div>
              </div>
            </div>`
          : `<div class="url-card">
              <span class="url-mark">${ICONS.instagram}</span>
              <div class="url-copy">
                <div class="url-label">Paste a Reel link</div>
                <div class="url-edit">
                  <div class="input-row">
                    <input class="input" id="manualUrl" type="url" spellcheck="false" autocomplete="off" placeholder="instagram.com/reel/…" aria-label="Instagram Reel URL">
                  </div>
                </div>
              </div>
            </div>
            <p class="hint" style="margin-top:7px">Open a Reel first, or paste its link here.</p>`
      }

      <div class="provider-row">
        <span class="provider-label">Engine <strong>${escapeHtml(provider)}</strong></span>
        <button class="text-link" type="button" data-action="settings">${missingKey ? "Add key" : "Settings"}</button>
      </div>

      <button class="btn btn-primary btn-block start-btn" id="startBtn" type="button" ${
        startDisabled ? "disabled" : ""
      }>
        <span>${escapeHtml(startLabel)}</span>
        ${ICONS.arrow}
      </button>
      <p class="hint" style="margin-top:7px">${escapeHtml(engineNote)}</p>

      <div class="alt-actions">
        <button class="text-link" type="button" data-action="batch">Batch a list →</button>
        ${
          backgroundEntry
            ? `<button class="text-link" type="button" data-action="background">${state.active.size} in progress →</button>`
            : `<span class="alt-note">${modelReady || settings.groqKey || settings.provider === "groq" ? "Ready when you are" : "One-time model setup"}</span>`
        }
      </div>

      <div class="how">
        <div class="how-step"><span class="how-num">01</span><span class="how-text">Fetch the Reel's audio and caption</span><span class="how-tag">yt-dlp</span></div>
        <div class="how-step"><span class="how-num">02</span><span class="how-text">Turn speech into a clean transcript</span><span class="how-tag">Whisper</span></div>
        <div class="how-step"><span class="how-num">03</span><span class="how-text">Save a searchable note you can keep</span><span class="how-tag">local</span></div>
      </div>
    </section>
  `;
}

function bindIdle() {
  els.capture.onclick = async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "settings") return openOptions();
    if (action === "batch") return switchTab("batch");
    if (action === "retry-bridge") {
      await refreshHealth();
      renderCapture();
      return;
    }
    if (action === "copy-command") {
      await copyText("unshelf\\start-unshelf.bat");
      showToast("Command copied");
      return;
    }
    if (action === "background") {
      const id = [...state.active][0];
      if (id) {
        state.currentJobId = id;
        state.view = "job";
        renderCapture();
      }
      return;
    }
    if (event.target.closest("#startBtn")) return startFromCapture();
  };

  els.capture.onkeydown = (event) => {
    if (event.key === "Enter" && event.target.id === "manualUrl") {
      event.preventDefault();
      startFromCapture();
    }
  };
}

async function startFromCapture() {
  const manual = $("#manualUrl")?.value.trim();
  const url = normalizeReelUrl(manual || state.activeTabUrl);
  if (!url) {
    showToast("Paste an Instagram Reel link first");
    return;
  }
  await beginJob(url);
}

async function beginJob(url, { batch = false } = {}) {
  if (state.busyStarting) return;
  if (!state.health?.ok) {
    state.startError = "The local bridge is not running.";
    renderCapture();
    return;
  }
  if (state.settings.provider === "groq" && !state.settings.groqKey) {
    showToast("Add your free Groq key in Settings");
    openOptions();
    return;
  }

  state.busyStarting = true;
  state.startError = "";
  const payload = {
    url,
    provider: state.settings.provider,
    model: state.settings.model,
    cookiesBrowser: state.settings.cookiesBrowser,
    language: state.settings.language || null,
  };
  if (state.settings.groqKey) payload.groqKey = state.settings.groqKey;

  try {
    const created = await state.bridge.createJob(payload);
    const entry = {
      id: created.id,
      url,
      job: {
        id: created.id,
        status: "queued",
        stage: "queued",
        message: "Waiting to start",
        createdAt: Date.now() / 1000,
      },
      startedAt: Date.now() / 1000,
    };
    state.jobs.set(created.id, entry);
    state.active.add(created.id);
    if (batch) state.batchIds.push(created.id);
    state.currentJobId = created.id;
    state.view = "job";
    state.tab = "capture";
    for (const [name, view] of Object.entries(els.views)) {
      view.classList.toggle("is-active", name === "capture");
    }
    await persistRuntime();
    ensurePolling();
    renderAll();
  } catch (error) {
    state.startError = error instanceof BridgeError ? error.message : "Could not start the job.";
    renderCapture();
  } finally {
    state.busyStarting = false;
  }
}

/* ------------------------------------------------------------------ job */

function jobTemplate(entry) {
  const job = entry?.job || {
    status: "queued",
    stage: "queued",
    message: "Starting the bridge…",
  };
  const stage = job.stage || "queued";
  const done = job.status === "done" || stage === "done";
  const fetching = stage === "fetching" || stage === "queued";
  const transcribing = stage === "transcribing" || stage === "downloading-model";
  const gotAudio = ["transcribing", "downloading-model", "done"].includes(stage) || done;
  const started = entry?.startedAt || job.createdAt || Date.now() / 1000;
  const elapsed = Math.max(0, Math.round(Date.now() / 1000 - started));

  const step = (stateClass, num, label, tag) => `
    <div class="step ${stateClass}">
      <span class="step-dot"></span>
      <span class="step-label">${label}</span>
      <span class="step-tag">${tag}</span>
    </div>`;

  return `
    <section class="rise">
      <div class="job-top">
        <button class="back-btn" id="jobBack" type="button">${ICONS.back} Back</button>
        <span class="mono muted">${state.active.has(entry?.id) ? "IN PROGRESS" : "PROCESSING"}</span>
      </div>
      <p class="eyebrow">Unshelving</p>
      <h1 class="job-title">Listening <em>closely.</em></h1>
      <p class="job-sub">Keep this open, or close it — the bridge keeps working.</p>
      <p class="job-source">${escapeHtml(compactUrl(entry?.url || "")) || "Reel"}</p>

      <div class="steps">
        ${step(gotAudio ? "is-done" : fetching ? "is-active" : "", "01",
          "Fetch the Reel audio",
          gotAudio ? "done" : fetching ? "working" : "waiting")}
        ${step(done ? "is-done" : transcribing ? "is-active" : "",
          "02",
          stage === "downloading-model" ? "Download the local model" : "Transcribe the speech",
          done ? "done" : transcribing ? "working" : "waiting")}
        ${step(done ? "is-active" : "", "03", "Build the note", done ? "almost" : "waiting")}
      </div>

      <p class="job-message">${escapeHtml(job.message || "Working…")}</p>
      <div class="job-meta">
        <span>${elapsed}s elapsed</span>
        <span>${escapeHtml(providerName(job.provider || ""))}</span>
      </div>
    </section>
  `;
}

function bindJob(entry) {
  $("#jobBack")?.addEventListener("click", () => {
    state.view = "idle";
    state.currentJobId = null;
    persistRuntime();
    renderCapture();
  });
}

function errorTemplate(job) {
  return `
    <section class="rise">
      <div class="job-top">
        <button class="back-btn" id="errorBack" type="button">${ICONS.back} Back</button>
        <span class="mono muted">NOT SAVED</span>
      </div>
      <p class="eyebrow">Needs a hand</p>
      <h1 class="job-title">The Reel <em>resisted.</em></h1>
      <div class="notice" style="margin-top:15px">
        <p class="notice-title">${escapeHtml(job.error || "Something went wrong.")}</p>
        <p>Public Reels usually work. Private or login-walled ones need your browser cookies.</p>
      </div>
      <div class="job-actions">
        <button class="btn btn-primary btn-block" id="retryJob" type="button">Try again ${ICONS.arrow}</button>
      </div>
      <div class="alt-actions">
        <button class="text-link" type="button" data-action="settings">Open settings</button>
        <button class="text-link" type="button" data-action="batch">Back to batch</button>
      </div>
    </section>
  `;
}

function bindError(job) {
  $("#errorBack")?.addEventListener("click", () => {
    state.view = "idle";
    state.currentErrorJob = null;
    renderCapture();
  });
  $("#retryJob")?.addEventListener("click", () => {
    if (job?.url) beginJob(job.url);
  });
  els.capture.querySelector("[data-action='settings']")?.addEventListener("click", openOptions);
  els.capture.querySelector("[data-action='batch']")?.addEventListener("click", () => switchTab("batch"));
}

/* --------------------------------------------------------------- result */

function resultTemplate(item) {
  const noteIndex = state.history.findIndex(
    (entry) => (entry.shortcode || entry.url) === (item.shortcode || item.url)
  );
  const number = String(noteIndex >= 0 ? noteIndex + 1 : state.history.length + 1).padStart(2, "0");
  const transcriptParagraphs = (item.transcript || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  const highlights = item.keyLines?.length
    ? item.keyLines.map((line) => `<blockquote class="highlight">${escapeHtml(line)}</blockquote>`).join("")
    : `<p class="empty">Not enough speech for highlights. The full transcript is still here.</p>`;
  const links = item.links?.length
    ? item.links
        .map((link) => {
          const url = safeHttpUrl(link);
          if (!url) return "";
          return `<a class="link-item" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
            ${ICONS.link}<span>${escapeHtml(link)}</span>
          </a>`;
        })
        .join("")
    : `<p class="empty">No links were found in the caption or transcript.</p>`;
  const hashtags = (item.hashtags || []).slice(0, 4).map((tag) => `<span class="chip">#${escapeHtml(tag)}</span>`).join("");
  const sourceUrl = safeHttpUrl(item.url) || "#";

  return `
    <section class="rise">
      <div class="result-head">
        <button class="back-btn" id="resultBack" type="button">${ICONS.back} Back</button>
        <span class="mono muted">NOTE ${number}</span>
      </div>

      <p class="result-kicker">Unshelved · ${escapeHtml(item.provider === "groq" ? "Groq" : "Local")}</p>
      <h1 class="result-title">${escapeHtml(item.title || "Untitled Reel")}</h1>
      <p class="result-byline"><strong>@${escapeHtml(item.creator || "unknown")}</strong> · ${formatDate(item.postedAt)} · ${formatDuration(item.duration)}</p>

      <div class="meta-row">
        <span class="chip chip-orange">${escapeHtml(item.language || "speech")}</span>
        <span class="chip">${item.wordCount || 0} words</span>
        <span class="chip">${escapeHtml(item.provider === "groq" ? "Groq Whisper" : "Local Whisper")}</span>
        ${hashtags}
      </div>

      <div class="action-row">
        <button class="btn btn-primary" id="copyNote" type="button">${ICONS.copy} Copy note</button>
        <button class="btn" id="saveNote" type="button">${ICONS.download} Save .md</button>
        <a class="btn" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${ICONS.external} Reel</a>
      </div>

      <div class="segmented" role="tablist" aria-label="Note sections">
        <button class="segment is-active" type="button" data-panel="transcript">Transcript</button>
        <button class="segment" type="button" data-panel="highlights">Highlights</button>
        <button class="segment" type="button" data-panel="links">Links</button>
      </div>

      <div class="panel" id="panelTranscript">
        <div class="transcript">${transcriptParagraphs || `<p class="empty">No speech was detected. The caption is below.</p>`}</div>
      </div>
      <div class="panel" id="panelHighlights" hidden>${highlights}</div>
      <div class="panel" id="panelLinks" hidden>${links}</div>

      ${
        item.caption
          ? `<div class="caption-block">
              <div class="caption-label">Original caption</div>
              <p class="caption-text">${escapeHtml(item.caption)}</p>
            </div>`
          : ""
      }

      <div class="result-footer">
        ${escapeHtml(providerName(item.provider))} · ${escapeHtml(formatDate(item.createdAt))} · saved on this machine
      </div>
    </section>
  `;
}

function bindResult(item) {
  $("#resultBack")?.addEventListener("click", () => {
    state.view = "idle";
    state.currentItem = null;
    if (state.resultOrigin === "history") {
      switchTab("history");
    } else if (state.resultOrigin === "batch") {
      switchTab("batch");
    } else {
      switchTab("capture");
    }
  });

  $("#copyNote")?.addEventListener("click", async () => {
    await copyText(noteMarkdown(item));
    showToast("Note copied");
  });

  $("#saveNote")?.addEventListener("click", async () => {
    try {
      await downloadText(noteMarkdown(item), markdownFilename(item));
      showToast("Markdown saved");
    } catch {
      showToast("Could not save the file");
    }
  });

  for (const segment of $$(".segment", els.capture)) {
    segment.addEventListener("click", () => {
      const target = segment.dataset.panel;
      for (const button of $$(".segment", els.capture)) {
        button.classList.toggle("is-active", button === segment);
      }
      for (const panel of $$(".panel", els.capture)) {
        panel.hidden = panel.id !== `panel${target[0].toUpperCase()}${target.slice(1)}`;
      }
    });
  }
}

/* ---------------------------------------------------------------- batch */

function renderBatch() {
  const batchJobs = state.batchIds
    .map((id) => state.jobs.get(id))
    .filter(Boolean);
  const urls = parseReelUrls(state.batchInput);
  const activeBatch = batchJobs.filter((entry) => state.active.has(entry.id)).length;
  const doneBatch = batchJobs.filter((entry) => entry.job?.status === "done").length;

  els.batch.innerHTML = `
    <section class="rise">
      <div class="section-head">
        <div>
          <p class="eyebrow">Batch</p>
          <h1 class="display">Clear the <em>backlog.</em></h1>
        </div>
        <span class="chip">${state.active.size} active</span>
      </div>
      <p class="hint" style="margin-bottom:12px">Paste up to 50 Reel links. They queue on the bridge and keep working if you close this popup.</p>

      <textarea class="textarea batch-input" id="batchInput" spellcheck="false" placeholder="https://www.instagram.com/reel/…&#10;https://www.instagram.com/reel/…&#10;https://www.instagram.com/reel/…">${escapeHtml(state.batchInput)}</textarea>
      <div class="batch-meta">
        <span id="batchCount">${urls.length} ${urls.length === 1 ? "link" : "links"} · 50 max</span>
        <span>${doneBatch} done</span>
      </div>

      <div class="batch-options">
        <select class="select" id="batchProvider" aria-label="Transcription engine">
          <option value="auto" ${state.settings.provider === "auto" ? "selected" : ""}>Auto engine</option>
          <option value="groq" ${state.settings.provider === "groq" ? "selected" : ""}>Groq · free key</option>
          <option value="local" ${state.settings.provider === "local" ? "selected" : ""}>Local Whisper</option>
        </select>
        <select class="select" id="batchCookies" aria-label="Browser cookies">
          <option value="none" ${state.settings.cookiesBrowser === "none" ? "selected" : ""}>No cookies</option>
          <option value="chrome" ${state.settings.cookiesBrowser === "chrome" ? "selected" : ""}>Chrome cookies</option>
          <option value="edge" ${state.settings.cookiesBrowser === "edge" ? "selected" : ""}>Edge cookies</option>
          <option value="firefox" ${state.settings.cookiesBrowser === "firefox" ? "selected" : ""}>Firefox cookies</option>
        </select>
      </div>

      <button class="btn btn-primary btn-block" id="queueBtn" type="button" ${urls.length ? "" : "disabled"}>
        Queue ${urls.length || ""} ${urls.length === 1 ? "Reel" : "Reels"} ${ICONS.arrow}
      </button>

      ${
        batchJobs.length
          ? `<div class="batch-list">${batchJobs.map(batchRow).join("")}</div>
             <div class="batch-footer">
               <button class="btn btn-sm" id="exportBatch" type="button">${ICONS.download} Export all notes</button>
               <button class="btn btn-sm btn-ghost" id="clearFinished" type="button">Clear finished</button>
             </div>`
          : `<div class="empty" style="margin-top:20px;border-top:1px solid var(--line);padding-top:13px">Nothing queued yet. Paste links above, or use Capture for the current Reel.</div>`
      }
      ${
        activeBatch
          ? `<p class="hint" style="margin-top:10px">${activeBatch} running · ${doneBatch} finished. The bridge processes one at a time.</p>`
          : ""
      }
    </section>
  `;
  bindBatch();
}

function batchRow(entry) {
  const job = entry.job;
  const status = job?.status || (state.active.has(entry.id) ? "queued" : "queued");
  const done = status === "done";
  const error = status === "error";
  const working = state.active.has(entry.id);
  const title =
    job?.result?.title ||
    (entry.url ? compactUrl(entry.url) : "Reel") ||
    "Reel";
  const sub = done
    ? `${job.result.creator || ""} · ${formatDuration(job.result.duration)}`
    : error
      ? job.error || "Failed"
      : job?.message || "Waiting";
  const stateLabel = done ? "OPEN" : error ? "FAILED" : working ? "WORKING" : "QUEUED";
  const stateClass = done ? "is-done" : error ? "is-error" : working ? "is-working" : "";
  return `
    <button class="batch-row ${done ? "is-done" : ""}" type="button" data-batch-id="${entry.id}" ${done ? "" : "disabled"}>
      <span>
        <span class="batch-row-title">${escapeHtml(title)}</span>
        <span class="batch-row-sub">${escapeHtml(sub)}</span>
      </span>
      <span class="batch-row-state ${stateClass}">${stateLabel}</span>
    </button>
  `;
}

function bindBatch() {
  const input = $("#batchInput");
  input?.addEventListener("input", () => {
    state.batchInput = input.value;
    const urls = parseReelUrls(state.batchInput);
    $("#batchCount").textContent = `${urls.length} ${urls.length === 1 ? "link" : "links"} · 50 max`;
    $("#queueBtn").disabled = urls.length === 0;
    $("#queueBtn").innerHTML = `Queue ${urls.length || ""} ${urls.length === 1 ? "Reel" : "Reels"} ${ICONS.arrow}`;
  });

  $("#batchProvider")?.addEventListener("change", async (event) => {
    state.settings = await saveSettings({ provider: event.target.value });
    showToast("Engine updated");
  });

  $("#batchCookies")?.addEventListener("change", async (event) => {
    state.settings = await saveSettings({ cookiesBrowser: event.target.value });
    showToast("Cookie source updated");
  });

  $("#queueBtn")?.addEventListener("click", startBatch);

  $("#exportBatch")?.addEventListener("click", exportAllHistory);

  $("#clearFinished")?.addEventListener("click", async () => {
    state.batchIds = state.batchIds.filter((id) => state.active.has(id));
    await persistRuntime();
    renderBatch();
  });

  els.batch.querySelectorAll("[data-batch-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const entry = state.jobs.get(row.dataset.batchId);
      if (entry?.job?.result) showResult(entry.job.result, "batch");
    });
  });
}

async function startBatch() {
  const urls = parseReelUrls(state.batchInput).slice(0, 50);
  if (!urls.length) {
    showToast("No Reel links found");
    return;
  }
  if (!state.health?.ok) {
    showToast("Start the local bridge first");
    return;
  }
  if (state.settings.provider === "groq" && !state.settings.groqKey) {
    showToast("Add your free Groq key in Settings");
    openOptions();
    return;
  }
  if (state.busyStarting) return;

  state.busyStarting = true;
  const button = $("#queueBtn");
  if (button) {
    button.disabled = true;
    button.textContent = `Queueing ${urls.length}…`;
  }

  let queued = 0;
  try {
    for (const url of urls) {
      try {
        const payload = {
          url,
          provider: state.settings.provider,
          model: state.settings.model,
          cookiesBrowser: state.settings.cookiesBrowser,
          language: state.settings.language || null,
        };
        if (state.settings.groqKey) payload.groqKey = state.settings.groqKey;
        const created = await state.bridge.createJob(payload);
        state.jobs.set(created.id, {
          id: created.id,
          url,
          job: { id: created.id, status: "queued", stage: "queued", message: "Waiting to start" },
          startedAt: Date.now() / 1000,
        });
        state.active.add(created.id);
        state.batchIds.push(created.id);
        queued += 1;
      } catch (error) {
        showToast(error.message || "A job could not be queued");
      }
    }
    state.batchInput = "";
    await persistRuntime();
    ensurePolling();
    renderBatch();
    showToast(`${queued} ${queued === 1 ? "Reel" : "Reels"} queued`);
  } finally {
    state.busyStarting = false;
  }
}

/* -------------------------------------------------------------- history */

function renderHistory() {
  const filtered = searchHistory(state.history, state.historyQuery);
  els.history.innerHTML = `
    <section class="rise">
      <div class="section-head">
        <div>
          <p class="eyebrow">History</p>
          <h1 class="display">The <em>shelf.</em></h1>
        </div>
        <span class="chip">${state.history.length}</span>
      </div>
      <div class="history-tools">
        <input class="input history-search" id="historySearch" type="search" placeholder="Search transcripts, people, tags…" value="${escapeHtml(state.historyQuery)}" aria-label="Search notes">
      </div>
      <p class="history-count" id="historyCount">${filtered.length} ${filtered.length === 1 ? "note" : "notes"}${state.historyQuery ? " matching" : " saved locally"}</p>
      <div class="history-list" id="historyList">${historyListTemplate(filtered)}</div>
      <div class="history-actions">
        <button class="btn btn-sm" id="exportHistory" type="button" ${state.history.length ? "" : "disabled"}>${ICONS.download} Export all</button>
        <button class="btn btn-sm btn-danger" id="clearHistory" type="button" ${state.history.length ? "" : "disabled"}>Clear history</button>
      </div>
    </section>
  `;
  bindHistory();
}

function historyListTemplate(items) {
  if (!items.length) {
    return `<div class="empty" style="padding:22px 0;border-top:1px solid var(--line)">${
      state.historyQuery
        ? "No notes match that search."
        : "No notes yet. Transcribe a Reel and it will land here."
    }</div>`;
  }
  return items
    .map(
      (item) => `
      <button class="history-row" type="button" data-history-id="${escapeHtml(item.shortcode || item.url)}">
        <span>
          <span class="history-title">${escapeHtml(item.title || "Untitled Reel")}</span>
          <span class="history-sub">@${escapeHtml(item.creator || "unknown")} · ${escapeHtml(formatDuration(item.duration))}</span>
        </span>
        <span class="history-meta"><strong>${escapeHtml(formatDateShort(item.savedAt || item.createdAt))}</strong>${item.provider === "groq" ? "Groq" : "Local"}</span>
      </button>`
    )
    .join("");
}

function bindHistory() {
  const search = $("#historySearch");
  search?.addEventListener("input", () => {
    state.historyQuery = search.value;
    const filtered = searchHistory(state.history, state.historyQuery);
    $("#historyList").innerHTML = historyListTemplate(filtered);
    $("#historyCount").textContent = `${filtered.length} ${filtered.length === 1 ? "note" : "notes"}${state.historyQuery ? " matching" : " saved locally"}`;
    bindHistoryRows();
  });

  bindHistoryRows();
  $("#exportHistory")?.addEventListener("click", exportAllHistory);
  $("#clearHistory")?.addEventListener("click", async () => {
    if (!confirm("Clear all saved Unshelf notes? This cannot be undone.")) return;
    state.history = await clearHistory();
    renderAll();
    showToast("History cleared");
  });
}

function bindHistoryRows() {
  els.history.querySelectorAll("[data-history-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const item = state.history.find(
        (entry) => (entry.shortcode || entry.url) === row.dataset.historyId
      );
      if (item) showResult(item, "history");
    });
  });
}

/* --------------------------------------------------------------- shared */

function showResult(item, origin) {
  state.currentItem = item;
  state.currentErrorJob = null;
  state.resultOrigin = origin;
  state.view = "result";
  switchTab("capture");
}

async function exportAllHistory() {
  if (!state.history.length) {
    showToast("No notes to export yet");
    return;
  }
  const text = state.history.map(noteMarkdown).join("\n\n---\n\n");
  const date = new Date().toISOString().slice(0, 10);
  try {
    await downloadText(text, `unshelf-notes-${date}.md`);
    showToast(`Exporting ${plural(state.history.length, "note")}`);
  } catch {
    showToast("Could not export the notes");
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), 2300);
}

/* ------------------------------------------------------------- polling */

function ensurePolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => pollActive(), 1200);
}

async function pollActive({ quiet = false } = {}) {
  if (state.active.size === 0) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    return;
  }

  for (const id of [...state.active]) {
    try {
      const job = await state.bridge.getJob(id);
      const entry = state.jobs.get(id) || { id, url: "", job: null, startedAt: Date.now() / 1000 };
      entry.job = job;
      state.jobs.set(id, entry);

      if (job.status === "done" && job.result) {
        state.active.delete(id);
        state.history = await addHistory(job.result);
        if (state.currentJobId === id) {
          state.currentItem = job.result;
          state.resultOrigin = "capture";
          state.view = "result";
          state.currentJobId = null;
        }
      } else if (job.status === "error") {
        state.active.delete(id);
        if (state.currentJobId === id) {
          state.currentErrorJob = job;
          state.view = "error";
          state.currentJobId = null;
        }
      }
    } catch {
      // A single dropped poll is not fatal. Keep the job in the active set.
    }
  }

  await persistRuntime();
  updateChrome();

  if (!quiet) {
    if (state.tab === "capture") renderCapture();
    if (state.tab === "batch") renderBatch();
    if (state.tab === "history") {
      const filtered = searchHistory(state.history, state.historyQuery);
      const list = $("#historyList");
      if (list) {
        list.innerHTML = historyListTemplate(filtered);
        bindHistoryRows();
      }
      if ($("#historyCount")) {
        $("#historyCount").textContent = `${filtered.length} ${filtered.length === 1 ? "note" : "notes"}${state.historyQuery ? " matching" : " saved locally"}`;
      }
    }
  }

  if (state.active.size === 0 && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function persistRuntime() {
  await chrome.storage.local.set({
    "unshelf.runtime": {
      activeJobIds: [...state.active],
      batchIds: state.batchIds.slice(-100),
      currentJobId: state.currentJobId,
    },
  });
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url || "";
  } catch {
    return "";
  }
}
