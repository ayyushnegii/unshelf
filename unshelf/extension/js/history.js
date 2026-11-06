const HISTORY_KEY = "unshelf.history";
const MAX_HISTORY = 200;

export async function getHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

export async function addHistory(item) {
  if (!item) return [];
  const history = await getHistory();
  const id = item.shortcode || item.url;
  const next = [
    { ...item, savedAt: new Date().toISOString() },
    ...history.filter((entry) => (entry.shortcode || entry.url) !== id),
  ].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  return [];
}

export function searchHistory(history, query) {
  const needle = (query || "").trim().toLowerCase();
  if (!needle) return history;
  return history.filter((item) => {
    const haystack = [
      item.title,
      item.creator,
      item.caption,
      item.transcript,
      ...(item.keyLines || []),
      ...(item.hashtags || []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
