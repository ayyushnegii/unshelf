const INSTAGRAM_REEL = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function isInstagramReel(value) {
  return INSTAGRAM_REEL.test(String(value || "").trim());
}

export function shortcodeFromUrl(value) {
  const match = String(value || "").match(INSTAGRAM_REEL);
  return match ? match[1] : "";
}

export function normalizeReelUrl(value) {
  const match = String(value || "").trim().match(INSTAGRAM_REEL);
  return match ? `https://www.instagram.com/reel/${match[1]}/` : "";
}

export function parseReelUrls(text) {
  const source = String(text || "");
  const found = source.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[A-Za-z0-9_-]+\/?/gi
  ) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of found) {
    const url = normalizeReelUrl(raw);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export function compactUrl(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.length > 1 ? url.pathname : "";
    return `${url.host.replace(/^www\./, "")}${path}`;
  } catch {
    return String(value || "");
  }
}

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "—";
  const mins = Math.floor(total / 60);
  const secs = Math.round(total % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatDate(value) {
  if (!value) return "Undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateShort(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}

export function providerName(value) {
  if (value === "groq") return "Groq · Whisper Large v3 Turbo";
  if (value === "local") return "Local · Faster Whisper";
  return "Whisper";
}

export function noteMarkdown(item) {
  const lines = [
    "---",
    `source: ${item.url || ""}`,
    `creator: ${item.creator || ""}`,
    `posted: ${item.postedAt || ""}`,
    `transcribed: ${item.createdAt || new Date().toISOString()}`,
    `provider: ${item.provider || ""}`,
    "---",
    "",
    `# ${item.title || "Untitled Reel"}`,
    "",
    `**${item.creator || "Unknown creator"}** · ${formatDate(item.postedAt)} · ${formatDuration(item.duration)}`,
    "",
    "## Transcript",
    "",
    item.transcript || "_No speech detected._",
    "",
  ];
  if (item.keyLines?.length) {
    lines.push("## Key lines", "");
    for (const line of item.keyLines) lines.push(`> ${line}`, "");
  }
  if (item.links?.length) {
    lines.push("## Links mentioned", "");
    for (const link of item.links) lines.push(`- ${link}`);
    lines.push("");
  }
  if (item.caption) {
    lines.push("## Caption", "", item.caption, "");
  }
  lines.push("---", "", "_Unshelved with Unshelf — local-first Reel notes._");
  return lines.join("\n");
}

export function markdownFilename(item) {
  const base = (item.title || item.shortcode || "reel")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
  return `unshelf-${base || "reel"}.md`;
}

export async function downloadText(text, filename, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
