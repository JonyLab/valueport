// 资产页的「自然语言提问」：模型只把问题翻译成下面这套固定词表里的小查询（字段 / 运算符 / 视图都是白名单），
// 前端用真实数据在本地执行，按页面自己的组件（持仓表 / 环形图 / 单个数字）渲染。模型看不到任何金额和持仓列表。
// 校验（validatePfQuery）前后端共用：服务端拒绝未知字段 / 运算符，前端执行前再过一遍。

export const PFQ_ZONES = ["deep", "under", "fair", "over", "xover", "none"]; // 与 core.js 的 ZONES.key 一致，none = 未估值
export const PFQ_STATUS = ["over", "under", "ok", "build", "none"];          // 偏离状态；none = 没设目标
export const PFQ_ACTIONS = ["trimHot", "trimHold", "trim", "addCheap", "addWait", "add", "build", "buildCheap", "ok", "none"]; // holding.js 的 driftAction
export const PFQ_MARKETS = ["US", "HK", "CN"];

// type：enum 取值见 values（account / currency 的取值由请求带上）；num 是百分数或金额；bool；text 子串匹配
export const PFQ_FIELDS = {
  zone: { type: "enum", values: PFQ_ZONES },
  market: { type: "enum", values: PFQ_MARKETS },
  currency: { type: "enum" },
  account: { type: "enum" },
  weight: { type: "num" },       // 占总资产（含现金）%
  target: { type: "num" },       // 目标仓位 %
  drift: { type: "num" },        // 当前 − 目标，百分点
  driftStatus: { type: "enum", values: PFQ_STATUS },
  action: { type: "enum", values: PFQ_ACTIONS },
  pnlPct: { type: "num" },       // 浮动盈亏 %
  value: { type: "num" },        // 市值（折算币种）；只用来排序 / 求和，模型不知道具体金额
  valued: { type: "bool" },      // 有估值区间
  held: { type: "bool" },        // 已持有（false = 设了目标、计划建仓）
  name: { type: "text" },
  ticker: { type: "text" },
};
export const PFQ_OPS = { enum: ["eq", "ne", "in"], num: ["eq", "ne", "gt", "gte", "lt", "lte"], bool: ["eq"], text: ["eq", "contains"] };
export const PFQ_VIEWS = ["table", "donut", "stat", "none"];
export const PFQ_GROUPS = ["zone", "market", "currency", "account", "driftStatus", "action", "valued"];
export const PFQ_METRICS = ["count", "weight", "value"];
const MAX_FILTERS = 6, MAX_LIMIT = 50;

// 校验并规范化一个查询；cat = { accounts: [名称], currencies: [代码] }。返回 { query } 或 { error }
export function validatePfQuery(q, cat = {}) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return { error: "not an object" };
  if (!PFQ_VIEWS.includes(q.view)) return { error: "bad view" };
  const title = typeof q.title === "string" ? q.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (q.view === "none") return { query: { view: "none", title, say: typeof q.say === "string" ? q.say.trim().slice(0, 200) : "" } };
  const enumValues = (k) => (k === "account" ? (cat.accounts || []) : k === "currency" ? (cat.currencies || []) : PFQ_FIELDS[k].values);
  // 大小写宽松（hk → HK、Over → over），统一成白名单里的写法
  const canon = (k, v) => (typeof v === "string" || typeof v === "number") ? enumValues(k).find((x) => x.toLowerCase() === String(v).trim().toLowerCase()) : undefined;
  const filter = [];
  if (q.filter !== undefined && !Array.isArray(q.filter)) return { error: "bad filter" };
  for (const f of q.filter || []) {
    if (!f || typeof f !== "object") return { error: "bad filter" };
    const def = PFQ_FIELDS[f.field];
    if (!def || !Object.hasOwn(PFQ_FIELDS, f.field)) return { error: "unknown field: " + String(f.field).slice(0, 30) };
    if (!PFQ_OPS[def.type].includes(f.op)) return { error: `bad op ${String(f.op).slice(0, 10)} for ${f.field}` };
    let value;
    if (def.type === "enum") {
      if (f.op === "in") {
        if (!Array.isArray(f.value) || !f.value.length || f.value.length > 10) return { error: "in needs a list" };
        value = [...new Set(f.value.map((v) => canon(f.field, v)))];
        if (value.includes(undefined)) return { error: "unknown value for " + f.field };
      } else { value = canon(f.field, f.value); if (value === undefined) return { error: "unknown value for " + f.field }; }
    } else if (def.type === "num") {
      value = typeof f.value === "string" ? Number(f.value.replace(/[,%\s]/g, "")) : f.value;
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: "bad number for " + f.field };
    } else if (def.type === "bool") {
      value = f.value === true || f.value === "true" ? true : f.value === false || f.value === "false" ? false : null;
      if (value === null) return { error: "bad bool for " + f.field };
    } else {
      value = typeof f.value === "string" ? f.value.trim().slice(0, 40) : "";
      if (!value) return { error: "bad text for " + f.field };
    }
    filter.push({ field: f.field, op: f.op, value });
  }
  if (filter.length > MAX_FILTERS) return { error: "too many filters" };
  const query = { view: q.view, title, filter };
  if (q.sort !== undefined && q.sort !== null) {
    const s = q.sort, def = s && PFQ_FIELDS[s.field];
    if (!def || !Object.hasOwn(PFQ_FIELDS, s.field) || (def.type !== "num" && s.field !== "name")) return { error: "bad sort" };
    query.sort = { field: s.field, dir: s.dir === "asc" ? "asc" : "desc" };
  }
  if (q.limit !== undefined && q.limit !== null) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) return { error: "bad limit" };
    query.limit = Math.min(MAX_LIMIT, n);
  }
  if (q.view === "donut") {
    const g = q.groupBy === undefined || q.groupBy === null ? "zone" : q.groupBy;
    if (!PFQ_GROUPS.includes(g)) return { error: "bad groupBy" };
    query.groupBy = g;
  }
  if (q.view === "stat") {
    const m = q.metric === undefined || q.metric === null ? "count" : q.metric;
    if (!PFQ_METRICS.includes(m)) return { error: "bad metric" };
    query.metric = m;
  }
  return { query };
}

// 在本地行上执行。row = { symbol, name, ticker, zone(键), market, currency, accounts:[名], byAccount:{名:市值},
//   weight, target, drift, driftStatus, action, pnlPct, value, valued, held }
// 默认只看已持有的；过滤条件里提到 held / driftStatus 时以条件为准（这样「计划建仓」也能问到）
const passes = (row, f) => {
  const v = row[f.field];
  if (f.field === "account") {
    const has = (a) => (row.accounts || []).includes(a);
    return f.op === "in" ? f.value.some(has) : f.op === "eq" ? has(f.value) : !has(f.value);
  }
  switch (f.op) {
    case "eq": return typeof f.value === "string" && typeof v === "string" && PFQ_FIELDS[f.field].type === "text" ? v.toLowerCase() === f.value.toLowerCase() : v === f.value;
    case "ne": return Number.isNaN(v) ? false : v !== f.value;
    case "in": return f.value.includes(v);
    case "gt": return Number.isFinite(v) && v > f.value;
    case "gte": return Number.isFinite(v) && v >= f.value;
    case "lt": return Number.isFinite(v) && v < f.value;
    case "lte": return Number.isFinite(v) && v <= f.value;
    case "contains": return typeof v === "string" && v.toLowerCase().includes(f.value.toLowerCase());
    default: return false;
  }
};
export function runPfQuery(query, rows) {
  const filter = query.filter || [];
  const scoped = filter.some((f) => f.field === "held" || f.field === "driftStatus") ? rows : rows.filter((r) => r.held);
  let out = scoped.filter((r) => filter.every((f) => passes(r, f)));
  if (query.sort) {
    const { field, dir } = query.sort, k = dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const x = a[field], y = b[field];
      if (field === "name") return k * String(x || "").localeCompare(String(y || ""));
      const fx = Number.isFinite(x), fy = Number.isFinite(y);
      return fx && fy ? k * (x - y) : fx ? -1 : fy ? 1 : 0; // 没有数值的排最后
    });
  }
  if (query.view === "table") return { view: "table", rows: query.limit ? out.slice(0, query.limit) : out };
  if (query.view === "stat") {
    const sum = (k) => out.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
    const metric = query.metric || "count";
    return { view: "stat", metric, value: metric === "count" ? out.length : sum(metric), n: out.length };
  }
  if (query.view === "donut") {
    const g = query.groupBy || "zone", m = new Map();
    const add = (k, v) => { if (Number.isFinite(v) && v > 0) m.set(k, (m.get(k) || 0) + v); };
    for (const r of out) {
      if (g === "account") for (const [a, v] of Object.entries(r.byAccount || {})) add(a, v);
      else add(String(r[g]), r.value);
    }
    return { view: "donut", groupBy: g, groups: [...m.entries()].sort((a, b) => b[1] - a[1]), n: out.length };
  }
  return { view: "none" };
}

// 去掉一个过滤条件后的新查询（前端的筛选胶囊 ×）
export const dropFilter = (query, i) => ({ ...query, filter: (query.filter || []).filter((_, j) => j !== i) });
