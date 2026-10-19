// 站长后台 · 使用统计：顶部统计格 + 每日新用户 / AI 请求柱状图 + 热门标的 + 可排序的用户表。
// 数据来自 GET /api/owner/stats（src/usage.js）。自成一块：owner.html 只放一个 #usage 容器并调用 mountUsage()。
import { LANG } from "/shared/i18n.js";

const TXT = {
  zh: { title: "使用统计", refresh: "刷新", users: "用户", today: "今天", week: "本周", active: "近 7 天活跃", codes: "激活码已用",
    issued: "共发出", aiToday: "今日 AI 请求", aiWeek: "近 7 天", items: "自选标的", vals: "估值卡", brokers: "接入券商", accounts: "个账户",
    ownModel: "自带模型", chats: "AI 对话", chatUsers: "人在用", people: "人", newUsers: "每日新用户", aiDaily: "每日 AI 请求", aiAll: "全部请求", own: "其中自带模型",
    activeDaily: "日活", top: "热门标的", topNone: "还没有人添加标的", watchers: "人关注", name: "用户名", joined: "注册", it: "自选", val: "估值卡",
    pf: "券商", ai: "AI 今日", ai7: "AI 7 天", chat: "对话", last: "最近活跃", empty: "暂无用户", err: "统计加载失败", d30: "近 30 天",
    now: "刚刚", min: "分钟前", hr: "小时前", day: "天前", note: "日活与每日 AI 次数从本功能上线后开始记录" },
  en: { title: "Usage", refresh: "Refresh", users: "Users", today: "today", week: "this week", active: "Active (7d)", codes: "Codes used",
    issued: "issued", aiToday: "AI requests today", aiWeek: "last 7d", items: "Watchlist items", vals: "valuation cards", brokers: "Broker linked", accounts: "accounts",
    ownModel: "Own model", chats: "AI chats", chatUsers: "users", people: "users", newUsers: "New users / day", aiDaily: "AI requests / day", aiAll: "all requests", own: "own model",
    activeDaily: "active", top: "Most watched", topNone: "No symbols yet", watchers: "watching", name: "Username", joined: "Joined", it: "Items", val: "Cards",
    pf: "Broker", ai: "AI today", ai7: "AI 7d", chat: "Chats", last: "Last active", empty: "No users", err: "Couldn't load stats", d30: "Last 30 days",
    now: "just now", min: "m ago", hr: "h ago", day: "d ago", note: "Daily active and AI history start from when this panel shipped" },
};
const T = TXT[LANG] || TXT.zh;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();

const CSS = `
.us-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.us-head .card-title{margin-right:auto}
.us-head .us-sub{font-size:12.5px;color:var(--ink-mute)}
.us-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.us-tile{padding:14px 16px;border-radius:var(--r-lg);background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px var(--divider)}
.us-tile.hi{background:var(--dark);color:#fff;box-shadow:none}
.us-tile.hi .us-lab,.us-tile.hi .us-foot{color:rgba(255,255,255,.62)}
.us-lab{font-size:12.5px;color:var(--ink-mute)}
.us-num{font-size:38px;font-weight:400;letter-spacing:-.03em;line-height:1.1;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.us-num small{font-size:.5em;color:var(--ink-mute);letter-spacing:0;margin-left:2px}
.us-tile.hi .us-num small{color:rgba(255,255,255,.55)}
.us-foot{font-size:12px;color:var(--ink-soft)}
.us-foot b{font-weight:500;color:var(--ink)}
.us-tile.hi .us-foot b{color:var(--sun)}
.us-charts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px}
.us-panel{padding:14px 16px;border-radius:var(--r-lg);background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px var(--divider);min-width:0}
.us-panel h4{margin:0 0 2px;font-size:13.5px;font-weight:500}
.us-panel .us-legend{font-size:11.5px;color:var(--ink-mute);display:flex;gap:10px;margin-bottom:6px}
.us-panel .us-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:0}
.us-bars{display:block;width:100%;height:96px}
.us-bars rect.b{fill:var(--dark)}
.us-bars rect.o{fill:var(--sun)}
.us-bars rect.hit{fill:transparent}
.us-bars rect.hit:hover{fill:var(--track)}
.us-bars line{stroke:var(--divider)}
.us-axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--ink-mute);margin-top:2px}
.us-top{list-style:none;margin:4px 0 0;padding:0;font-size:13px}
.us-top li{display:flex;align-items:center;gap:8px;padding:4px 0}
.us-top .tk{font-family:var(--mono);font-size:12px;min-width:56px}
.us-top .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-soft)}
.us-top .bar{width:48px;height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.us-top .bar i{display:block;height:100%;background:var(--sun)}
.us-top .n{font-family:var(--mono);font-size:12px;width:20px;text-align:right}
.us-empty{font-size:12.5px;color:var(--ink-mute);padding:8px 0}
.us-table{overflow-x:auto;margin-top:6px}
.us-table table{min-width:640px}
.us-table th{cursor:pointer;user-select:none;white-space:nowrap}
.us-table th.on{color:var(--ink)}
.us-table th.on::after{content:" ↓";font-size:11px}
.us-table th.on.asc::after{content:" ↑"}
.us-table th.n{text-align:right}
.us-table td.n{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.us-table td.z{color:var(--ink-mute)}
.us-table td.ago{white-space:nowrap;color:var(--ink-soft)}
.us-table td.ago.fresh{color:var(--green)}
.us-note{font-size:11.5px;color:var(--ink-mute);margin-top:10px}
@media (max-width:760px){.us-tiles{grid-template-columns:repeat(2,1fr)}.us-charts{grid-template-columns:1fr}.us-num{font-size:32px}}
`;

function ago(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  if (iso.length === 10) { const d = Math.max(0, Math.round(ms / 86400000)); return d === 0 ? T.today : d + " " + T.day; }
  const m = Math.floor(ms / 60000);
  if (m < 2) return T.now;
  if (m < 60) return m + " " + T.min;
  if (m < 1440) return Math.floor(m / 60) + " " + T.hr;
  return Math.floor(m / 1440) + " " + T.day;
}

// 每日柱状图；over 是叠在柱底的暖黄子集（自带模型的请求），可选
function bars(series, key, over) {
  const W = 300, H = 96, n = series.length, gap = 2, bw = (W - gap * (n - 1)) / n;
  const max = Math.max(1, ...series.map((s) => s[key]));
  let svg = `<svg class="us-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"><line x1="0" y1="${H - .5}" x2="${W}" y2="${H - .5}"/>`;
  series.forEach((s, i) => {
    const x = i * (bw + gap), v = s[key], h = v ? Math.max(2, (v / max) * (H - 6)) : 0;
    if (h) svg += `<rect class="b" x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="1.5"/>`;
    if (over && s[over]) { const oh = Math.max(2, (s[over] / max) * (H - 6)); svg += `<rect class="o" x="${x}" y="${H - oh}" width="${bw}" height="${oh}" rx="1.5"/>`; }
    const tip = `${s.day} · ${fmt(v)}` + (over ? ` (${T.own} ${fmt(s[over])})` : "") + (key === "ai" ? ` · ${T.activeDaily} ${fmt(s.active)}` : "");
    svg += `<rect class="hit" x="${x}" y="0" width="${bw + gap}" height="${H}"><title>${esc(tip)}</title></rect>`;
  });
  return svg + `</svg><div class="us-axis"><span>${series[0].day.slice(5)}</span><span>${series[n - 1].day.slice(5)}</span></div>`;
}

const COLS = [
  { k: "username", l: "name" }, { k: "joined", l: "joined" }, { k: "items", l: "it", n: 1 }, { k: "valuations", l: "val", n: 1 },
  { k: "accounts", l: "pf", n: 1 }, { k: "aiToday", l: "ai", n: 1 }, { k: "ai7d", l: "ai7", n: 1 }, { k: "chats", l: "chat", n: 1 }, { k: "lastActive", l: "last" },
];

export function mountUsage(root) {
  if (!document.getElementById("us-css")) { const st = document.createElement("style"); st.id = "us-css"; st.textContent = CSS; document.head.appendChild(st); }
  let data = null, sortKey = "lastActive", asc = false;

  function table() {
    const list = [...data.list].sort((a, b) => {
      const x = a[sortKey] ?? "", y = b[sortKey] ?? "";
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
    if (!list.length) return `<div class="us-empty">${esc(T.empty)}</div>`;
    const fresh = Date.now() - 86400000;
    return `<div class="us-table"><table><tr>${COLS.map((c) => `<th data-k="${c.k}" class="${c.n ? "n " : ""}${c.k === sortKey ? "on" + (asc ? " asc" : "") : ""}">${esc(T[c.l])}</th>`).join("")}</tr>` +
      list.map((u) => `<tr><td>${esc(u.username)}</td><td class="mono">${esc((u.joined || "").slice(0, 10))}</td>` +
        ["items", "valuations", "accounts", "aiToday", "ai7d", "chats"].map((k) => `<td class="n${u[k] ? "" : " z"}">${fmt(u[k])}</td>`).join("") +
        `<td class="ago${u.lastActive && new Date(u.lastActive) > fresh && u.lastActive.length > 10 ? " fresh" : ""}" title="${esc(u.lastActive || "")}">${esc(ago(u.lastActive))}</td></tr>`).join("") +
      `</table></div>`;
  }

  function render() {
    const s = data, top = s.topSymbols, topMax = Math.max(1, ...top.map((x) => x.users));
    const tile = (lab, num, foot, hi) => `<div class="us-tile${hi ? " hi" : ""}"><div class="us-lab">${esc(lab)}</div><div class="us-num">${num}</div><div class="us-foot">${foot}</div></div>`;
    root.innerHTML = `
      <div class="us-head"><span class="card-title">${esc(T.title)}</span><span class="us-sub">${esc(T.d30)}</span><button class="btn sm" data-act="refresh">${esc(T.refresh)}</button></div>
      <div class="us-tiles">
        ${tile(T.users, fmt(s.users.total), `<b>+${fmt(s.users.today)}</b> ${esc(T.today)} · <b>+${fmt(s.users.week)}</b> ${esc(T.week)}`, true)}
        ${tile(T.active, `${fmt(s.users.active7d)}<small>/ ${fmt(s.users.total)}</small>`, `${esc(T.activeDaily)} <b>${fmt(s.series.at(-1).active)}</b> ${esc(T.today)}`)}
        ${tile(T.codes, `${fmt(s.codes.used)}<small>/ ${fmt(s.codes.issued)}</small>`, `${esc(T.issued)} <b>${fmt(s.codes.issued)}</b>`)}
        ${tile(T.aiToday, fmt(s.ai.today), `${esc(T.aiWeek)} <b>${fmt(s.ai.week)}</b>`)}
        ${tile(T.items, fmt(s.content.items), `<b>${fmt(s.content.valuations)}</b> ${esc(T.vals)}`)}
        ${tile(T.brokers, `${fmt(s.content.brokerUsers)}<small>${esc(T.people)}</small>`, `<b>${fmt(s.content.accounts)}</b> ${esc(T.accounts)}`)}
        ${tile(T.ownModel, `${fmt(s.ai.ownModelUsers)}<small>${esc(T.people)}</small>`, `/ ${fmt(s.users.total)} ${esc(T.people)}`)}
        ${tile(T.chats, fmt(s.ai.chats), `<b>${fmt(s.ai.chatUsers)}</b> ${esc(T.chatUsers)}`)}
      </div>
      <div class="us-charts">
        <div class="us-panel"><h4>${esc(T.newUsers)}</h4><div class="us-legend">${esc(T.d30)} · ${fmt(s.users.month)}</div>${bars(s.series, "newUsers")}</div>
        <div class="us-panel"><h4>${esc(T.aiDaily)}</h4><div class="us-legend"><span><i style="background:var(--dark)"></i>${esc(T.aiAll)}</span><span><i style="background:var(--sun)"></i>${esc(T.own)}</span></div>${bars(s.series, "ai", "aiOwn")}</div>
        <div class="us-panel"><h4>${esc(T.top)}</h4>${top.length ? `<ul class="us-top">${top.map((x) =>
          `<li title="${esc(x.symbol)} · ${x.users} ${esc(T.watchers)}"><span class="tk">${esc(x.ticker || x.symbol)}</span><span class="nm">${esc(x.name)}</span><span class="bar"><i style="width:${(x.users / topMax) * 100}%"></i></span><span class="n">${x.users}</span></li>`).join("")}</ul>`
          : `<div class="us-empty">${esc(T.topNone)}</div>`}</div>
      </div>
      <div data-slot="table">${table()}</div>
      <div class="us-note">${esc(T.note)}</div>`;
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-act=refresh]")) return load();
    const th = e.target.closest("th[data-k]");
    if (!th || !data) return;
    if (sortKey === th.dataset.k) asc = !asc; else { sortKey = th.dataset.k; asc = sortKey === "username"; }
    root.querySelector("[data-slot=table]").innerHTML = table();
  });

  async function load() {
    try {
      const r = await fetch("/api/owner/stats");
      if (!r.ok) throw new Error(r.status);
      data = await r.json(); render();
    } catch { root.innerHTML = `<div class="us-empty">${esc(T.err)}</div>`; }
  }
  return load();
}
