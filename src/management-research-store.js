import { cleanManagementResearch } from "../public/shared/valuation/management-research.js";

export const RESEARCH_TTL = 6 * 60 * 60 * 1000;
const RETRY_TTL = 10 * 60 * 1000;
const DOCUMENT_TTL = 24 * 60 * 60 * 1000;
export const RESEARCH_TABLES = [
  `CREATE TABLE IF NOT EXISTS management_research_snapshots (
    symbol TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, saved_at TEXT NOT NULL,
    checked_at TEXT NOT NULL, refresh_after INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
    refresh_failed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS management_research_documents (
    symbol TEXT NOT NULL, url TEXT NOT NULL, source_url TEXT NOT NULL, format TEXT NOT NULL,
    pages_json TEXT NOT NULL, fetched_at TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, url))`,
];

// Retain official historical material, but never revive expired news as current.
export function usableStoredResearch(raw, symbol, now) {
  const clean = cleanManagementResearch(raw);
  if (!clean || clean.symbol !== symbol || clean.status !== "ok") return null;
  clean.sources = clean.sources.filter((source) => source.sourceType === "official"
    || (Date.parse(source.publishedAt) >= now - 120 * 86400000 && Date.parse(source.publishedAt) <= now + 86400000));
  return clean.sources.length ? cleanManagementResearch(clean) : null;
}

export function mergeResearchRefresh(previous, current) {
  const oldOfficial = previous?.sources.filter((source) => source.sourceType === "official") || [];
  const newOfficial = current?.sources?.filter((source) => source.sourceType === "official") || [];
  const period = (source) => /^(FY)?(20\d{2}) Q([1-4])$/.exec(source?.reportPeriod || "");
  const older = oldOfficial.some((old) => newOfficial.some((fresh) => {
    const a = period(old), b = period(fresh);
    return a && b && a[1] === b[1] && Number(a[2]) * 4 + Number(a[3]) > Number(b[2]) * 4 + Number(b[3]);
  }));
  if (oldOfficial.length && (!newOfficial.length || older)) {
    const news = current?.status === "ok" ? current.sources.filter((source) => source.sourceType !== "official") : [];
    return { failed: true, research: cleanManagementResearch({ ...previous, officialStatus: older ? "unavailable" : current?.officialStatus || "unavailable", officialReason: older ? "" : current?.officialReason || "",
      sources: [...oldOfficial, ...news].slice(0, 3) }) };
  }
  return current?.status === "ok" ? { failed: false, research: current } : { failed: true, research: previous };
}

// Per-request initialization only: never keep D1 promises in module globals.
export function createResearchStore(db) {
  if (!db) return null;
  let ready = null, disabled = false;
  const ensure = () => ready ||= db.batch(RESEARCH_TABLES.map((sql) => db.prepare(sql)));
  const safe = async (operation, fallback) => {
    if (disabled) return fallback;
    try { await ensure(); return await operation(); }
    catch { disabled = true; console.warn("management_research_storage_unavailable"); return fallback; }
  };
  return {
    load: (symbol, now) => safe(async () => {
      const row = await db.prepare("SELECT * FROM management_research_snapshots WHERE symbol=?").bind(symbol).first();
      if (!row) return null;
      let raw; try { raw = JSON.parse(row.snapshot_json); } catch { return null; }
      const research = usableStoredResearch(raw, symbol, now);
      return research ? { research, savedAt: row.saved_at, checkedAt: row.checked_at,
        refreshAfter: row.refresh_after, failed: !!row.refresh_failed } : null;
    }, null),
    save: (symbol, research, now, failed = false) => safe(async () => {
      const clean = cleanManagementResearch(research);
      if (clean?.status !== "ok" || clean.symbol !== symbol) return false;
      delete clean.storage;
      const at = new Date(now).toISOString();
      await db.prepare(`INSERT INTO management_research_snapshots
        (symbol,snapshot_json,saved_at,checked_at,refresh_after,lease_until,refresh_failed) VALUES (?,?,?,?,?,0,?)
        ON CONFLICT(symbol) DO UPDATE SET snapshot_json=excluded.snapshot_json, saved_at=excluded.saved_at,
        checked_at=excluded.checked_at, refresh_after=excluded.refresh_after, lease_until=0, refresh_failed=excluded.refresh_failed`)
        .bind(symbol, JSON.stringify(clean), at, at, now + (failed ? RETRY_TTL : RESEARCH_TTL), Number(failed)).run();
      return true;
    }, false),
    claimRefresh: (symbol, now) => safe(async () => {
      const result = await db.prepare(`UPDATE management_research_snapshots SET lease_until=?
        WHERE symbol=? AND refresh_after<=? AND lease_until<=?`).bind(now + 60000, symbol, now, now).run();
      return result.meta.changes > 0;
    }, false),
    failRefresh: (symbol, now) => safe(async () => {
      await db.prepare(`UPDATE management_research_snapshots SET checked_at=?,refresh_after=?,lease_until=0,refresh_failed=1 WHERE symbol=?`)
        .bind(new Date(now).toISOString(), now + RETRY_TTL, symbol).run();
    }, undefined),
    getDocument: (symbol, url, now) => safe(async () => {
      const row = await db.prepare("SELECT * FROM management_research_documents WHERE symbol=? AND url=? AND expires_at>?").bind(symbol, url, now).first();
      if (!row) return null;
      let pages; try { pages = JSON.parse(row.pages_json); } catch { return null; }
      if (!Array.isArray(pages) || !pages.length || pages.length > 40 || pages.some((p) => typeof p !== "string") || pages.join("").length > 200000
        || !["pdf", "html"].includes(row.format)) return null;
      return { pages, url: row.source_url, format: row.format, fetchedAt: row.fetched_at, publishedAt: row.published_at };
    }, null),
    putDocument: (symbol, url, document, now) => safe(async () => {
      if (!Array.isArray(document.pages) || !document.pages.length || document.pages.length > 40
        || document.pages.some((p) => typeof p !== "string") || document.pages.join("").length > 200000) return false;
      await db.prepare(`INSERT INTO management_research_documents (symbol,url,source_url,format,pages_json,fetched_at,published_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(symbol,url) DO UPDATE SET source_url=excluded.source_url,format=excluded.format,
        pages_json=excluded.pages_json,fetched_at=excluded.fetched_at,published_at=excluded.published_at,expires_at=excluded.expires_at`)
        .bind(symbol, url, document.url, document.format, JSON.stringify(document.pages), document.fetchedAt, document.publishedAt || "", now + DOCUMENT_TTL).run();
      return true;
    }, false),
  };
}
