import { assertEncryptionKey, encryptJson, decryptJson } from "./crypto.js";

// AAD binds ciphertext to its table, owner and account (and date for history).
// Legacy columns remain only for rolling migration and contain placeholders after backfill.
export class PortfolioStorageError extends Error {
  constructor() { super("portfolio_storage_unavailable"); }
}
export async function requirePortfolioKey(env) {
  try { await assertEncryptionKey(env.CREDENTIALS_KEY); }
  catch { throw new PortfolioStorageError(); }
}
const context = (kind, uid, aid = "", day = "") => JSON.stringify(["portfolio", 1, kind, uid, aid, day]);
async function seal(env, aad, value) {
  try { return "v1:" + await encryptJson(env.CREDENTIALS_KEY, value, aad); }
  catch { throw new PortfolioStorageError(); }
}
async function open(env, aad, value) {
  try {
    if (!value.startsWith("v1:")) throw new Error();
    return await decryptJson(env.CREDENTIALS_KEY, value.slice(3), aad);
  } catch { throw new PortfolioStorageError(); }
}
const holdingValue = (r) => ({ symbol: r.symbol, name: r.name, quantity: r.quantity, cost_price: r.cost_price, currency: r.currency, market: r.market });
const cashValue = (r) => ({ currency: r.currency, amount: r.amount });
const historyValue = (r) => ({ USD: r.v_usd, HKD: r.v_hkd, CNY: r.v_cny });

export async function readHoldings(env, uid, accountId) {
  await requirePortfolioKey(env);
  const { results } = await env.DB.prepare("SELECT h.* FROM holdings h JOIN broker_accounts a ON a.id=h.account_id WHERE a.user_id=?" + (accountId == null ? "" : " AND a.id=?"))
    .bind(...(accountId == null ? [uid] : [uid, accountId])).all();
  return Promise.all((results || []).map(async (r) => ({ id: r.id, account_id: r.account_id,
    ...(r.data_enc == null ? holdingValue(r) : await open(env, context("holding", uid, r.account_id), r.data_enc)) })));
}
export async function readCash(env, uid, accountId) {
  await requirePortfolioKey(env);
  const { results } = await env.DB.prepare("SELECT b.* FROM cash_balances b JOIN broker_accounts a ON a.id=b.account_id WHERE a.user_id=?" + (accountId == null ? "" : " AND a.id=?"))
    .bind(...(accountId == null ? [uid] : [uid, accountId])).all();
  return Promise.all((results || []).map(async (r) => ({ account_id: r.account_id,
    ...(r.data_enc == null ? cashValue(r) : await open(env, context("cash", uid, r.account_id), r.data_enc)) })));
}

// Encrypt everything before deleting anything. D1 batch commits the complete replacement atomically.
export async function replaceSnapshot(env, uid, accountId, { positions, cash }) {
  await requirePortfolioKey(env);
  const db = env.DB, stmts = [
    db.prepare("DELETE FROM holdings WHERE account_id=?").bind(accountId),
    db.prepare("DELETE FROM cash_balances WHERE account_id=?").bind(accountId),
  ];
  for (const p of positions) {
    const enc = await seal(env, context("holding", uid, accountId), {
      symbol: p.symbol, name: p.name || "", quantity: p.quantity, cost_price: Number.isFinite(p.costPrice) ? p.costPrice : null,
      currency: p.currency, market: p.market || "",
    });
    stmts.push(db.prepare("INSERT INTO holdings (account_id,symbol,name,quantity,cost_price,currency,market,data_enc) VALUES (?,'','',0,NULL,'','',?)").bind(accountId, enc));
  }
  const merged = new Map();
  for (const r of cash) merged.set(r.currency, (merged.get(r.currency) || 0) + r.amount);
  for (const [currency, amount] of merged) {
    const enc = await seal(env, context("cash", uid, accountId), { currency, amount });
    stmts.push(db.prepare("INSERT INTO cash_balances (account_id,currency,amount,data_enc) VALUES (?,?,0,?)").bind(accountId, "enc:" + crypto.randomUUID(), enc));
  }
  await db.batch(stmts);
}

export async function readHistory(env, uid, since) {
  await requirePortfolioKey(env);
  const { results } = await env.DB.prepare("SELECT * FROM portfolio_snapshots WHERE user_id=? AND day>=? ORDER BY day ASC").bind(uid, since).all();
  return Promise.all((results || []).map(async (r) => ({ day: r.day, accountId: r.account_id,
    ...(r.data_enc == null ? historyValue(r) : await open(env, context("history", uid, r.account_id, r.day), r.data_enc)) })));
}
export async function historyStatement(env, uid, day, aid, value) {
  const enc = await seal(env, context("history", uid, aid, day), value);
  return env.DB.prepare("INSERT INTO portfolio_snapshots (user_id,day,account_id,v_usd,v_hkd,v_cny,data_enc) VALUES (?,?,?,0,0,0,?) ON CONFLICT(user_id,day,account_id) DO UPDATE SET v_usd=0,v_hkd=0,v_cny=0,data_enc=excluded.data_enc")
    .bind(uid, day, aid, enc);
}
export async function readStoredPlan(env, uid) {
  await requirePortfolioKey(env);
  let row;
  try { row = await env.DB.prepare("SELECT * FROM portfolio_plans WHERE user_id=?").bind(uid).first(); }
  catch (e) { if (/no such table: portfolio_plans/.test(e.message)) return null; throw e; }
  if (!row) return null;
  return row.data_enc == null ? JSON.parse(row.plan) : open(env, context("plan", uid), row.data_enc);
}
export async function writePlan(env, uid, plan) {
  const enc = await seal(env, context("plan", uid), plan);
  await env.DB.prepare("INSERT INTO portfolio_plans (user_id,plan,updated_at,data_enc) VALUES (?,'{}',?,?) ON CONFLICT(user_id) DO UPDATE SET plan='{}',updated_at=excluded.updated_at,data_enc=excluded.data_enc")
    .bind(uid, new Date().toISOString(), enc).run();
}

// Bounded, restartable backfill. A row's ciphertext and plaintext removal commit together.
// Only NULL means legacy; damaged/empty ciphertext never falls back to cleared columns.
export async function migratePortfolioBatch(env, limit = 50) {
  await requirePortfolioKey(env);
  limit = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
  const db = env.DB, stmts = [];
  // Refuse to create new ciphertext under a different key during rollout.
  for (const [table, kind] of [["holdings", "holding"], ["cash_balances", "cash"], ["portfolio_snapshots", "history"], ["portfolio_plans", "plan"]]) {
    const account = kind === "holding" || kind === "cash";
    const row = await db.prepare(account
      ? `SELECT t.*,a.user_id FROM ${table} t JOIN broker_accounts a ON a.id=t.account_id WHERE t.data_enc IS NOT NULL LIMIT 1`
      : `SELECT * FROM ${table} WHERE data_enc IS NOT NULL LIMIT 1`).first();
    if (row) await open(env, context(kind, row.user_id, row.account_id ?? "", row.day ?? ""), row.data_enc);
  }
  const credential = await db.prepare("SELECT cred_enc FROM broker_accounts WHERE cred_enc IS NOT NULL LIMIT 1").first();
  if (credential) {
    try { await decryptJson(env.CREDENTIALS_KEY, credential.cred_enc); }
    catch { throw new PortfolioStorageError(); }
  }
  const { results: hs } = await db.prepare("SELECT h.*,a.user_id FROM holdings h JOIN broker_accounts a ON a.id=h.account_id WHERE h.data_enc IS NULL ORDER BY h.id LIMIT ?").bind(limit).all();
  for (const r of hs || []) {
    const enc = await seal(env, context("holding", r.user_id, r.account_id), holdingValue(r));
    stmts.push(db.prepare("UPDATE holdings SET data_enc=?,symbol='',name='',quantity=0,cost_price=NULL,currency='',market='' WHERE id=? AND data_enc IS NULL").bind(enc, r.id));
  }
  if (stmts.length < limit) {
    const { results } = await db.prepare("SELECT b.*,a.user_id FROM cash_balances b JOIN broker_accounts a ON a.id=b.account_id WHERE b.data_enc IS NULL ORDER BY b.account_id,b.currency LIMIT ?").bind(limit - stmts.length).all();
    for (const r of results || []) {
      const enc = await seal(env, context("cash", r.user_id, r.account_id), cashValue(r));
      stmts.push(db.prepare("UPDATE cash_balances SET data_enc=?,currency=?,amount=0 WHERE account_id=? AND currency=? AND data_enc IS NULL").bind(enc, "enc:" + crypto.randomUUID(), r.account_id, r.currency));
    }
  }
  if (stmts.length < limit) {
    const { results } = await db.prepare("SELECT * FROM portfolio_snapshots WHERE data_enc IS NULL ORDER BY user_id,day,account_id LIMIT ?").bind(limit - stmts.length).all();
    for (const r of results || []) {
      const enc = await seal(env, context("history", r.user_id, r.account_id, r.day), historyValue(r));
      stmts.push(db.prepare("UPDATE portfolio_snapshots SET data_enc=?,v_usd=0,v_hkd=0,v_cny=0 WHERE user_id=? AND day=? AND account_id=? AND data_enc IS NULL").bind(enc, r.user_id, r.day, r.account_id));
    }
  }
  if (stmts.length < limit) {
    const { results } = await db.prepare("SELECT * FROM portfolio_plans WHERE data_enc IS NULL ORDER BY user_id LIMIT ?").bind(limit - stmts.length).all();
    for (const r of results || []) {
      const enc = await seal(env, context("plan", r.user_id), JSON.parse(r.plan));
      stmts.push(db.prepare("UPDATE portfolio_plans SET data_enc=?,plan='{}' WHERE user_id=? AND data_enc IS NULL").bind(enc, r.user_id));
    }
  }
  const updated = stmts.length ? await db.batch(stmts) : [];
  const remaining = await db.prepare("SELECT (SELECT COUNT(*) FROM holdings WHERE data_enc IS NULL)+(SELECT COUNT(*) FROM cash_balances WHERE data_enc IS NULL)+(SELECT COUNT(*) FROM portfolio_snapshots WHERE data_enc IS NULL)+(SELECT COUNT(*) FROM portfolio_plans WHERE data_enc IS NULL) AS n").first();
  return { migrated: updated.reduce((n, r) => n + (r.meta.changes || 0), 0), remaining: remaining.n, done: remaining.n === 0 };
}
