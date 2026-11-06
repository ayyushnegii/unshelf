export const DEFAULT_SETTINGS = Object.freeze({
  bridgeUrl: "http://127.0.0.1:8765",
  provider: "auto",
  groqKey: "",
  model: "small",
  cookiesBrowser: "none",
  language: "",
});

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function providerLabel(settings) {
  if (settings.provider === "local") return "Local Whisper";
  if (settings.provider === "groq") {
    return settings.groqKey ? "Groq · free" : "Groq · key needed";
  }
  return settings.groqKey ? "Groq · free → local" : "Local Whisper";
}

export function providerShort(settings) {
  if (settings.provider === "groq") return settings.groqKey ? "Groq" : "No key";
  if (settings.provider === "local") return "Local";
  return settings.groqKey ? "Groq → local" : "Local";
}

export function modelLabel(model) {
  return (
    { tiny: "Tiny · fastest", base: "Base · 145 MB", small: "Small · 460 MB", medium: "Medium · 1.5 GB" }[
      model
    ] || model
  );
}
