// 站长后台的使用统计：每日计数（usage_daily 表）+ 最近活跃（settings 内部键 _last_seen）+ 汇总接口用的聚合查询。
// 记录都是尽力而为：表还没建（迁移没跑）时静默跳过，不影响正常请求。
const SEEN_KEY = "_last_seen";           // settings 表里的 ISO 时间，/api/me 时更新
const SEEN_EVERY_MS = 10 * 60 * 1000;    // 10 分钟内重复打开页面不重复写
export const STATS_DAYS = 30;            // 曲线覆盖的天数

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// 打开页面（/api/me）时记一次活跃：更新 _last_seen，并在 usage_daily 里占当天一行（日活）
export async function touchSeen(env, uid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key=?").bind(uid, SEEN_KEY).first();
    const now = new Date();
    if (row && now - new Date(row.value) < SEEN_EVERY_MS) return;
    await env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
      .bind(uid, SEEN_KEY, now.toISOString()).run();
    await env.DB.prepare("INSERT INTO usage_daily (day,user_id) VALUES (?,?) ON CONFLICT(day,user_id) DO NOTHING").bind(today(), uid).run();
  } catch {}
}

// 每次 AI 请求（站点模型或自己的模型）计一次
export async function countAi(env, uid, own) {
  try {
    await env.DB.prepare("INSERT INTO usage_daily (day,user_id,ai,ai_own) VALUES (?,?,1,?) ON CONFLICT(day,user_id) DO UPDATE SET ai=ai+1, ai_own=ai_own+excluded.ai_own")
      .bind(today(), uid, own ? 1 : 0).run();
  } catch {}
}

// 单条查询失败（表不存在等）返回空数组，别让一张可选表拖垮整个面板
async function rows(db, sql, ...binds) {
  try { const { results } = await db.prepare(sql).bind(...binds).all(); return results || []; } catch { return []; }
}
const byUser = (list) => new Map(list.map((r) => [r.user_id, r]));
const maxStr = (...xs) => xs.filter((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x)).sort().pop() || null; // 只认 YYYY-MM-DD 开头的时间

// 只读聚合；只取用户名 / 时间 / 计数，不碰密码哈希、API Key、券商凭证
export async function ownerStats(env) {
  const db = env.DB, day = today(), since = daysAgo(STATS_DAYS - 1), week = daysAgo(6);
  const [users, items, brokers, models, chats, flags, codes, top, daily, perUser7, perUserToday] = await Promise.all([
    rows(db, "SELECT id, username, created_at FROM users"),
    rows(db, `SELECT user_id, COUNT(*) AS n, SUM(CASE WHEN json_valid(valuations) THEN json_array_length(valuations) ELSE 0 END) AS v, MAX(updated_at) AS last
              FROM items GROUP BY user_id`),
    rows(db, `SELECT a.user_id, COUNT(DISTINCT a.id) AS accounts, COUNT(h.id) AS holdings
              FROM broker_accounts a LEFT JOIN holdings h ON h.account_id=a.id GROUP BY a.user_id`),
    rows(db, "SELECT user_id, COUNT(*) AS n FROM ai_models GROUP BY user_id"),
    rows(db, "SELECT user_id, COUNT(*) AS n, MAX(updated_at) AS last FROM ai_chats GROUP BY user_id"),
    rows(db, "SELECT user_id, key, value FROM settings WHERE key IN ('_ai_usage', ?)", SEEN_KEY),
    rows(db, "SELECT COUNT(*) AS total, COUNT(used_by) AS used FROM activation_codes"),
    rows(db, `SELECT symbol, MAX(ticker) AS ticker, MAX(name) AS name, COUNT(DISTINCT user_id) AS users
              FROM items GROUP BY symbol ORDER BY users DESC, symbol ASC LIMIT 10`),
    rows(db, "SELECT day, SUM(ai) AS ai, SUM(ai_own) AS ai_own, COUNT(*) AS active FROM usage_daily WHERE day>=? GROUP BY day", since),
    rows(db, "SELECT user_id, SUM(ai) AS ai, MAX(day) AS last FROM usage_daily WHERE day>=? GROUP BY user_id", week),
    rows(db, "SELECT user_id, ai FROM usage_daily WHERE day=?", day),
  ]);
  const I = byUser(items), B = byUser(brokers), M = byUser(models), C = byUser(chats), W = byUser(perUser7), T = byUser(perUserToday);
  const seen = new Map(), legacyAi = new Map(); // legacyAi：_ai_usage 只记站点模型的当天次数；迁移前也有
  for (const f of flags) {
    if (f.key === SEEN_KEY) seen.set(f.user_id, f.value);
    else { const [d, n] = String(f.value).split(":"); if (d === day) legacyAi.set(f.user_id, Number(n) || 0); }
  }

  const list = users.map((u) => {
    const it = I.get(u.id) || {}, br = B.get(u.id) || {}, ch = C.get(u.id) || {};
    const aiToday = Math.max(T.get(u.id)?.ai || 0, legacyAi.get(u.id) || 0);
    return {
      id: u.id, username: u.username, joined: u.created_at,
      items: it.n || 0, valuations: it.v || 0,
      accounts: br.accounts || 0, holdings: br.holdings || 0,
      models: M.get(u.id)?.n || 0, chats: ch.n || 0,
      aiToday, ai7d: Math.max(W.get(u.id)?.ai || 0, aiToday),
      lastActive: maxStr(seen.get(u.id), it.last, ch.last, W.get(u.id)?.last, u.created_at),
    };
  });

  // 每日曲线：新用户（users.created_at）+ AI 请求 / 日活（usage_daily）；今天的 AI 数与 _ai_usage 取大，迁移前后都不缺
  const D = new Map(daily.map((r) => [r.day, r]));
  const joinedOn = new Map();
  for (const u of users) { const d = String(u.created_at || "").slice(0, 10); joinedOn.set(d, (joinedOn.get(d) || 0) + 1); }
  const legacyToday = [...legacyAi.values()].reduce((a, b) => a + b, 0);
  const series = [];
  for (let i = STATS_DAYS - 1; i >= 0; i--) {
    const d = daysAgo(i), r = D.get(d) || {};
    series.push({ day: d, newUsers: joinedOn.get(d) || 0, ai: d === day ? Math.max(r.ai || 0, legacyToday) : r.ai || 0, aiOwn: r.ai_own || 0, active: r.active || 0 });
  }
  const sum = (k, n) => series.slice(-n).reduce((a, s) => a + s[k], 0);
  const c0 = codes[0] || {};
  return {
    generatedAt: new Date().toISOString(),
    users: { total: users.length, today: sum("newUsers", 1), week: sum("newUsers", 7), month: sum("newUsers", STATS_DAYS),
      active7d: list.filter((u) => u.lastActive && u.lastActive.slice(0, 10) >= week).length },
    codes: { issued: c0.total || 0, used: c0.used || 0 },
    content: { items: list.reduce((a, u) => a + u.items, 0), valuations: list.reduce((a, u) => a + u.valuations, 0),
      brokerUsers: list.filter((u) => u.accounts > 0).length, accounts: list.reduce((a, u) => a + u.accounts, 0) },
    ai: { today: series[series.length - 1].ai, week: sum("ai", 7), ownModelUsers: list.filter((u) => u.models > 0).length,
      chats: list.reduce((a, u) => a + u.chats, 0), chatUsers: list.filter((u) => u.chats > 0).length },
    topSymbols: top.map((r) => ({ symbol: r.symbol, ticker: r.ticker, name: r.name, users: r.users })),
    series, list,
  };
}
