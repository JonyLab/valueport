// Custom AI models settings panel inside board Settings (alongside jev-settings.js).
import { LANG } from "../i18n.js";
import { el } from "../dom.js";
import { armSafeClick } from "../ui-toast.js";

const AI_TEMPLATES = [
  { zh: "智谱 GLM-4.7-Flash（免费）", en: "Zhipu GLM-4.7-Flash (free)", provider: "openai", name: "智谱 GLM-4.7-Flash", model: "glm-4.7-flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    noteZh: "免费模型：在 open.bigmodel.cn 注册后到「API Keys」创建一个 Key 填进来即可。", noteEn: "Free model: sign up at open.bigmodel.cn and create a key under API Keys." },
  { zh: "DeepSeek", en: "DeepSeek", provider: "openai", name: "DeepSeek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1",
    noteZh: "在 platform.deepseek.com 创建 Key，按用量计费。", noteEn: "Create a key at platform.deepseek.com; billed per use." },
];

export async function mountAiSettings() {
  const zh = LANG === "zh", T = (a, b) => (zh ? a : b);
  document.getElementById("aiCfgName").textContent = T("AI 模型", "AI models");
  const body = document.getElementById("aiCfgBody"), saveEl = document.getElementById("aiSave");
  const setState = (cls, text) => { saveEl.className = "save-state " + (cls || ""); saveEl.textContent = text || ""; };
  const KIND = { openai: T("OpenAI 兼容", "OpenAI-compatible"), anthropic: "Anthropic" };
  let info = null, editing = null;
  async function refresh() {
    try { info = await fetch("/api/my/ai/models").then((r) => r.json()); } catch { body.textContent = T("加载失败", "Failed to load"); return; }
    draw();
  }
  function draw() {
    body.innerHTML = "";
    const others = [...info.workers.filter((w) => !(info.site.provider === "workers-ai" && w.model === info.site.model)), ...(info.siteKey || [])].map((w) => w.name);
    body.appendChild(el("p", "quote-note ai-intro", T(`不用配置就能用：站点默认（${info.site.name}）和 ${others.join("、")}。下面添加你自己的模型，之后在 AI 面板顶部切换用哪个。`,
      `Ready without setup: the site default (${info.site.name}) and ${others.join(", ")}. Add your own models below, then switch between them at the top of the AI panel.`)));
    const lim = info.dailyLimit || 100, wa = info.site.provider === "workers-ai";
    body.appendChild(el("p", "quote-note ai-intro", wa
      ? T(`这几个都用站点的 Cloudflare 免费额度：全站共用，每天北京时间早上 8 点重置，当天用完就要等到第二天；另外每人每天最多 ${lim} 次。你自己的模型用你自己的 Key，不受这两个限制。`,
        `These run on the site's free Cloudflare allowance, shared by everyone and reset daily at 00:00 UTC; once it's used up AI stops until the next day. Each person also gets at most ${lim} requests a day. Your own models use your own key and skip both limits.`)
      : T(`站点默认每人每天最多 ${lim} 次；你自己的模型用你自己的 Key，不受这个限制。`, `The site default allows ${lim} requests per person per day; your own models use your own key and skip this limit.`)));
    if ((info.siteKey || []).length) body.appendChild(el("p", "quote-note ai-intro", T(`${info.siteKey.map((m) => m.name).join("、")} 用站点在智谱申请的免费 Key，不占 Cloudflare 额度，同样每人每天最多 ${lim} 次；智谱对免费模型有并发限制，用的人多时可能要稍后重试。`,
      `${info.siteKey.map((m) => m.name).join(", ")} use the site's free Zhipu key — no Cloudflare allowance, still ${lim} requests per person per day; Zhipu limits concurrency on free models, so retry if it's busy.`)));
    const defLab = el("label", "field ai-default");
    defLab.appendChild(el("span", "f-lab", T("默认模型", "Default model")));
    const sel = el("select", "input ai-default-sel");
    const addGroup = (label, items) => {
      if (!items.length) return;
      const g = document.createElement("optgroup"); g.label = label;
      for (const [id, name] of items) { const o = document.createElement("option"); o.value = id; o.textContent = name; g.appendChild(o); }
      sel.appendChild(g);
    };
    addGroup(T("站点提供（免配置）", "Provided by the site"), [
      [info.site.id, T(`站点默认 · ${info.site.name}`, `Site default · ${info.site.name}`)],
      ...info.workers.filter((w) => !(info.site.provider === "workers-ai" && w.model === info.site.model)).map((w) => [w.id, w.name]),
      ...(info.siteKey || []).map((m) => [m.id, m.name]),
    ]);
    addGroup(T("我的模型", "My models"), info.custom.map((m) => [m.id, m.name]));
    sel.value = info.active;
    if (sel.value !== info.active) sel.value = "default";
    sel.addEventListener("change", async () => {
      setState("", T("保存中…", "Saving…"));
      try {
        const r = await fetch("/api/my/ai/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sel.value }) });
        if (!r.ok) throw new Error(r.status);
        info.active = sel.value; setState("ok", T("已保存", "Saved")); draw();
      } catch { setState("bad", T("保存失败", "Couldn't save")); sel.value = info.active; }
    });
    defLab.appendChild(sel);
    defLab.appendChild(el("span", "ai-default-hint", T("打开 AI 面板时默认用它；在面板顶部临时切换也会改这里。", "Used whenever the AI panel opens; switching at the top of the panel updates it too.")));
    body.appendChild(defLab);
    const list = el("div", "ai-mlist");
    for (const m of info.custom) {
      if (editing === m.id) { list.appendChild(form(m)); continue; }
      const row = el("div", "ai-mrow");
      const id = el("div", "ai-mid");
      id.append(el("div", "ai-mname", m.name), el("div", "ai-mmeta", `${KIND[m.kind] || m.kind} · ${m.model}${m.baseUrl ? " · " + m.baseUrl.replace(/^https:\/\//, "") : ""} · Key ${m.keyHint || "••••"}`));
      if (info.active === m.id) id.firstChild.appendChild(el("span", "ai-inuse", T("默认", "Default")));
      const edit = el("button", "btn sm", T("编辑", "Edit")); edit.type = "button"; edit.addEventListener("click", () => { editing = m.id; draw(); });
      const del = el("button", "btn sm ghost", T("删除", "Delete")); del.type = "button";
      armSafeClick(del, async () => {
        await fetch("/api/my/ai/models/" + m.id.slice(2), { method: "DELETE" }); setState("ok", T("已删除", "Deleted")); refresh();
      }, LANG);
      row.append(id, edit, del); list.appendChild(row);
    }
    if (editing === "new") list.appendChild(form(null));
    body.appendChild(list);
    if (editing === null) {
      const add = el("button", "pf-add-lite"); add.type = "button"; add.textContent = T("＋ 添加模型", "+ Add a model");
      add.addEventListener("click", () => { editing = "new"; draw(); });
      body.appendChild(add);
    }
  }
  function form(m) {
    const st = m ? { provider: m.kind, name: m.name, model: m.model, baseUrl: m.baseUrl } : { provider: "openai", name: "", model: "", baseUrl: "" };
    const box = el("div", "ai-form");
    const segs = el("div", "ai-provs");
    const grid = el("div", "cfg-grid ai-fields"), note = el("p", "quote-note");
    let keyIn = null;
    const field = (label, key, { ph = "", type = "text", full = false } = {}) => {
      const l = el("label", "field" + (full ? " full" : "")); l.appendChild(el("span", "f-lab", label));
      const i = el("input", "plain"); i.type = type; i.autocomplete = "off"; i.spellcheck = false; i.placeholder = ph;
      if (key) { i.value = st[key] || ""; i.addEventListener("input", () => { st[key] = i.value; }); }
      l.appendChild(i); grid.appendChild(l); return i;
    };
    const fields = () => {
      grid.innerHTML = "";
      segs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.provider));
      field(T("名称", "Name"), "name", { ph: st.provider === "openai" ? "DeepSeek" : "Claude" });
      field(T("模型", "Model"), "model", { ph: st.provider === "openai" ? "deepseek-chat" : "claude-sonnet-5-5" });
      field(st.provider === "openai" ? T("接口地址", "Base URL") : T("接口地址（可选）", "Base URL (optional)"), "baseUrl", { ph: st.provider === "openai" ? "https://api.deepseek.com/v1" : "https://api.anthropic.com", full: true });
      keyIn = field("API Key", null, { ph: m && m.kind === st.provider ? T(`已保存 ${m.keyHint}，留空则沿用`, `Saved ${m.keyHint}; leave blank to keep`) : "sk-…", type: "password", full: true });
      note.textContent = (st.provider === "openai"
        ? T("任何兼容 OpenAI /chat/completions 的服务都可以（OpenAI、DeepSeek、通义、Kimi、OpenRouter 等），接口地址填到 /v1 这一级。", "Any OpenAI /chat/completions-compatible service (OpenAI, DeepSeek, OpenRouter, …); the base URL ends at /v1.")
        : T("Anthropic Messages API；接口地址留空即官方地址。", "Anthropic Messages API; leave the base URL blank for the official endpoint."))
        + T(" Key 加密保存，只用于你自己的 AI 请求，不会再显示明文；用自己的 Key 不占站点每日额度，费用由该服务商按用量计。", " The key is stored encrypted, used only for your requests and never shown again; it doesn't count toward the site quota and is billed by that provider.");
    };
    if (!m) {
      const tpl = el("div", "ai-tpls"); tpl.appendChild(el("span", "f-lab", T("常用模板", "Templates")));
      for (const t of AI_TEMPLATES) {
        const b = el("button", "ai-tpl", zh ? t.zh : t.en); b.type = "button";
        b.addEventListener("click", () => { Object.assign(st, { provider: t.provider, name: t.name, model: t.model, baseUrl: t.baseUrl }); fields(); note.textContent = (zh ? t.noteZh : t.noteEn) + " " + note.textContent; });
        tpl.appendChild(b);
      }
      box.appendChild(tpl);
    }
    for (const [k, lab] of Object.entries(KIND)) {
      const b = el("button", "ai-prov", lab); b.type = "button"; b.dataset.k = k;
      b.addEventListener("click", () => { if (st.provider !== k) { st.provider = k; fields(); } });
      segs.appendChild(b);
    }
    fields();
    const acts = el("div", "ai-acts"), result = el("span", "ai-result");
    const payload = () => ({ provider: st.provider, name: st.name || "", model: st.model || "", baseUrl: st.baseUrl || "", ...(keyIn.value ? { apiKey: keyIn.value } : {}), ...(m ? { id: m.id } : {}) });
    const test = el("button", "btn", T("测试连接", "Test connection")); test.type = "button";
    test.addEventListener("click", async () => {
      test.disabled = true; result.className = "ai-result"; result.textContent = T("测试中…", "Testing…");
      try {
        const r = await fetch("/api/my/ai/models/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { result.className = "ai-result ok"; result.textContent = T(`连接成功 · ${j.ms} ms`, `Connected · ${j.ms} ms`); }
        else { result.className = "ai-result bad"; result.textContent = T("连接失败：", "Failed: ") + (j.error || r.status); }
      } catch { result.className = "ai-result bad"; result.textContent = T("网络错误", "Network error"); }
      finally { test.disabled = false; }
    });
    const save = el("button", "btn primary", T("保存", "Save")); save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true; setState("", T("保存中…", "Saving…"));
      try {
        const { id, ...bodyData } = payload();
        const r = await fetch(m ? "/api/my/ai/models/" + m.id.slice(2) : "/api/my/ai/models", { method: m ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyData) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setState("err", T("保存失败：", "Save failed: ") + (j.error || r.status)); return; }
        setState("ok", T("已保存，可在 AI 面板顶部切换使用", "Saved — switch to it at the top of the AI panel")); editing = null; refresh();
      } catch { setState("err", T("网络错误", "Network error")); }
      finally { save.disabled = false; }
    });
    const cancel = el("button", "btn ghost", T("取消", "Cancel")); cancel.type = "button"; cancel.addEventListener("click", () => { editing = null; draw(); });
    acts.append(test, save, cancel, result);
    box.append(segs, grid, note, acts);
    return box;
  }
  refresh();
}
