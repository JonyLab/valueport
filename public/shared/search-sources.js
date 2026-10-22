// History is user-editable data too: validate links on both new replies and restoration.
export function normalizeResearch(value) {
  if (!value || !["ok", "empty"].includes(value.status) || !Array.isArray(value.sources)) return null;
  const sources = [];
  for (const s of value.sources.slice(0, 5)) {
    try {
      const u = new URL(s.url);
      if (u.protocol !== "https:" || u.username || u.password || u.href.length > 1200 || !Number.isInteger(s.id) || s.id < 1 || s.id > 5) continue;
      sources.push({ id: s.id, url: u.href, title: typeof s.title === "string" ? s.title.slice(0, 200) : u.hostname,
        publishedAt: typeof s.publishedAt === "string" ? s.publishedAt.slice(0, 80) : null });
    } catch { /* Ignore unsafe links in old or edited history. */ }
  }
  return { status: sources.length ? "ok" : "empty", searchedAt: typeof value.searchedAt === "string" ? value.searchedAt.slice(0, 80) : "", sources };
}
