export function mountJevSettings(host, lang) {
  const t = (zh, en) => lang === "en" ? en : zh;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag); node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const form = el("form", "ai-form jev-settings"), heading = el("h3", "", t("Jev 判断引擎", "Jev decision engine"));
  const note = el("p", "quote-note", t("保存你的 Typesafe API Key。密钥加密保存，仅用于你的账户。Jev 辅助判断估值方法适配度、核对引用，并检查问题是否已被回答；文字模型负责提问和解释，最终由你确认。", "Save your Typesafe API key, encrypted for your account. Jev assists with method fit, citation checks and answer coverage. Your language model asks questions and explains; you confirm the choices."));
  const label = el("label", "field"), input = el("input", "input");
  input.type = "password"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 500;
  input.placeholder = t("填入 Typesafe API Key", "Enter your Typesafe API key");
  label.append(el("span", "f-lab", "Jev API Key"), input);
  const test = el("button", "btn", t("测试连接", "Test connection")); test.type = "button"; test.hidden = true;
  const actions = el("div", "ai-acts"), save = el("button", "btn primary", t("保存 Key", "Save key")), remove = el("button", "btn ghost", t("移除 Key", "Remove key"));
  save.type = "submit"; remove.type = "button"; remove.hidden = true;
  const status = el("span", "ai-result"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  actions.append(save, test, remove, status); form.append(heading, note, label, actions); host.replaceChildren(form);
  let busy = false;
  function locked(value) { busy = value; input.disabled = save.disabled = remove.disabled = test.disabled = value; }
  function configured(value) {
    remove.hidden = test.hidden = !value;
    input.placeholder = value ? t("已保存；填入新 Key 可替换", "Saved; enter a new key to replace it") : t("填入 Typesafe API Key", "Enter your Typesafe API key");
  }
  const message = (text, bad = false) => { status.className = `ai-result${bad ? " bad" : ""}`; status.textContent = text; };
  async function load() {
    locked(true);
    try {
      const r = await fetch("/api/my/ai/jev", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error();
      configured(j.configured); message(j.configured ? t("已保存", "Saved") : t("未配置", "Not configured"));
    } catch { message(t("读取失败，可重新填写并保存", "Could not load; enter and save a key"), true); }
    finally { locked(false); }
  }
  async function update(method) {
    if (busy) return;
    const apiKey = input.value.trim();
    if (method === "PUT" && (!apiKey || /\s/.test(apiKey))) { message(t("请填写有效的 API Key", "Enter a valid API key"), true); input.focus(); return; }
    locked(true); message(t("保存中…", "Saving…"));
    try {
      const r = await fetch("/api/my/ai/jev", { method, headers: { "content-type": "application/json" }, ...(method === "PUT" ? { body: JSON.stringify({ apiKey }) } : {}) });
      if (!r.ok) throw new Error();
      input.value = ""; configured(method === "PUT");
      message(method === "PUT" ? t("已加密保存", "Saved encrypted") : t("已移除", "Removed"));
    } catch { message(t("保存失败，请重试", "Could not save. Try again"), true); }
    finally { locked(false); }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); update("PUT"); });
  remove.addEventListener("click", () => update("DELETE"));
  test.addEventListener("click", async () => {
    if (busy) return;
    if (input.value.trim()) { message(t("请先保存新 Key，再测试连接", "Save your new key before testing"), true); return; }
    locked(true); message(t("正在测试…", "Testing…"));
    try {
      const r = await fetch("/api/my/ai/jev/test", { method: "POST" }); const j = await r.json();
      if (!r.ok) { message(j.error === "invalid_credentials" ? t("Key 无效或没有访问权限，请替换后重试", "Invalid key or access denied. Replace it and retry") : t("连接未成功，请稍后重试或检查 Key", "Could not connect. Retry later or check your key"), true); return; }
      message(t("连接成功 · ", "Connected · ") + j.model);
    } catch { message(t("网络错误，请重试", "Network error. Try again"), true); }
    finally { locked(false); }
  });
  load();
}
