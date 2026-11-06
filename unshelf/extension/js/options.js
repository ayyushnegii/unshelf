import { getSettings, saveSettings, providerLabel, modelLabel } from "./settings.js";
import { Bridge } from "./bridge.js";
import { getHistory, clearHistory } from "./history.js";
import { noteMarkdown, downloadText, plural } from "./format.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  settings: null,
  history: [],
  health: null,
  testing: false,
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  state.settings = await getSettings();
  state.history = await getHistory();
  fillForm(state.settings);
  bind();
  await testConnection({ quiet: true });
  updateSummary();
}

function fillForm(settings) {
  const provider = document.querySelector(`input[name="provider"][value="${settings.provider}"]`);
  if (provider) provider.checked = true;
  $("#groqKey").value = settings.groqKey || "";
  $("#model").value = settings.model || "small";
  $("#cookiesBrowser").value = settings.cookiesBrowser || "none";
  $("#language").value = settings.language || "";
  $("#bridgeUrl").value = settings.bridgeUrl || "http://127.0.0.1:8765";
}

function draft() {
  return {
    provider: document.querySelector('input[name="provider"]:checked')?.value || "auto",
    groqKey: $("#groqKey").value.trim(),
    model: $("#model").value,
    cookiesBrowser: $("#cookiesBrowser").value,
    language: $("#language").value,
    bridgeUrl: normalizeBridge($("#bridgeUrl").value),
  };
}

function normalizeBridge(value) {
  let url = (value || "").trim() || "http://127.0.0.1:8765";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

function bind() {
  $("#toggleKey").addEventListener("click", () => {
    const input = $("#groqKey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("#toggleKey").textContent = showing ? "Show" : "Hide";
  });

  $("#testGroqKey")?.addEventListener("click", async () => {
    const key = $("#groqKey").value.trim();
    if (!key) {
      toast("Enter a Groq key first");
      return;
    }
    const btn = $("#testGroqKey");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const bridge = new Bridge(normalizeBridge($("#bridgeUrl").value));
      const res = await bridge.testKey(key);
      toast(res.message || "Groq key is valid");
    } catch (err) {
      toast(err.message || "Could not validate key");
    } finally {
      btn.disabled = false;
      btn.textContent = "Test";
    }
  });

  for (const radio of document.querySelectorAll('input[name="provider"]')) {
    radio.addEventListener("change", updateSummary);
  }

  $("#saveBtn").addEventListener("click", save);
  $("#testBridge").addEventListener("click", () => testConnection());
  $("#copyCommand").addEventListener("click", async () => {
    await navigator.clipboard.writeText("unshelf\\start-unshelf.bat");
    toast("Command copied");
  });

  $("#exportNotes").addEventListener("click", exportNotes);
  $("#clearNotes").addEventListener("click", clearNotes);
  $("#closeBtn").addEventListener("click", () => window.close());
}

async function testConnection({ quiet = false } = {}) {
  if (state.testing) return;
  state.testing = true;
  const bridge = new Bridge(normalizeBridge($("#bridgeUrl").value));
  const status = $("#bridgeStatus");
  const text = $("#bridgeStatusText");
  const meta = $("#bridgeStatusMeta");
  const testResult = $("#bridgeTestResult");

  status.classList.remove("is-online", "is-offline");
  if (!quiet) {
    text.textContent = "Testing the bridge…";
    meta.textContent = "";
    testResult.textContent = "Testing…";
  }

  try {
    state.health = await bridge.health();
    status.classList.add("is-online");
    text.textContent = "Bridge connected";
    meta.textContent = `yt-dlp ${state.health.ytdlp || "?"}`;
    testResult.textContent = `Connected. yt-dlp ${state.health.ytdlp || "available"}.`;
    if (!quiet) toast("Bridge is running");
  } catch (error) {
    state.health = null;
    status.classList.add("is-offline");
    text.textContent = "Bridge not reachable";
    meta.textContent = state.settings?.bridgeUrl || "";
    testResult.textContent = error.message || "Start the bridge, then test again.";
    if (!quiet) toast("Bridge is not running");
  } finally {
    state.testing = false;
    updateSummary();
  }
}

function updateSummary() {
  const current = draft();
  $("#summaryEngine").textContent = providerLabel(current);
  $("#summaryModel").textContent = modelLabel(current.model);
  $("#summaryBridge").textContent = state.health?.ok ? "Connected" : "Offline";
  $("#summaryYtdlp").textContent = state.health?.ytdlp || "—";
  $("#summaryNotes").textContent = plural(state.history.length, "note");
}

async function save() {
  const current = draft();
  if (!/^https?:\/\/[^ ]+$/i.test(current.bridgeUrl)) {
    toast("Enter a valid bridge address");
    return;
  }
  if (current.provider === "groq" && !current.groqKey) {
    toast("Groq needs a free API key");
    $("#groqKey").focus();
    return;
  }

  const button = $("#saveBtn");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    state.settings = await saveSettings(current);
    state.history = await getHistory();
    $("#saveStatus").textContent = `Saved at ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}. Stored locally.`;
    await testConnection({ quiet: true });
    updateSummary();
    toast("Settings saved");
  } finally {
    button.disabled = false;
    button.textContent = "Save changes";
  }
}

async function exportNotes() {
  state.history = await getHistory();
  if (!state.history.length) {
    toast("No notes to export yet");
    return;
  }
  const text = state.history.map(noteMarkdown).join("\n\n---\n\n");
  const date = new Date().toISOString().slice(0, 10);
  await downloadText(text, `unshelf-notes-${date}.md`);
  toast(`Exporting ${plural(state.history.length, "note")}`);
}

async function clearNotes() {
  if (!confirm("Clear all saved Unshelf notes? This cannot be undone.")) return;
  state.history = await clearHistory();
  updateSummary();
  toast("History cleared");
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("is-visible"), 2300);
}
