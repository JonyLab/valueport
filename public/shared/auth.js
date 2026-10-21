// 登录 / 注册页共用：左侧产品介绍（复用真实钟摆组件，静态示例数据，不发请求）+ 表单小工具（显示密码、行内错误、加载态）。
// 样式在 /shared/styles.css 的「登录 / 注册」一节。
import { t } from "./i18n.js";
import { Gauge } from "./gauge.js";

const ri = (name) => `<i class="ri-${name}" aria-hidden="true"></i>`;

// 示例标的：合理区间 100–130、安全边际 20%（击球线 80）、泡沫阈值 30%；现价 71.6 落在击球区
const DEMO = { fairLow: 100, fairHigh: 130, mos: 20, ext: 30, price: 71.6, ticker: "DEMO" };

export function mountIntro(host, { strikeZone = false } = {}) {
  if (strikeZone) {
    host.classList.add("ap-intro-strike");
    host.innerHTML = `
      <figure class="ap-strike">
        <img class="ap-strike-image" src="/images/strike-zone-sketch.webp" width="814" height="1042" alt="${t("a_strike_alt")}" fetchpriority="high">
      </figure>
      <div class="ap-strike-copy">
        <h2 class="ap-title"><span>${t("a_strike_heading")}</span><span>${t("a_strike_heading2")}</span></h2>
        <p class="ap-lead">${t("a_strike_lead")}</p>
      </div>`;
    return;
  }
  const feats = [["dashboard-3-line", "a_f_pend"], ["focus-3-line", "a_f_strike"], ["earth-line", "a_f_macro"], ["pie-chart-2-line", "a_f_pf"]];
  host.innerHTML = `
    <p class="ap-eyebrow">${ri("seedling-line")}${t("a_intro_eyebrow")}</p>
    <h2 class="ap-title"><span>${t("a_intro_title1")}</span> <span>${t("a_intro_title2")}</span></h2>
    <p class="ap-lead">${t("a_intro_lead")}</p>
    <figure class="ap-demo">
      <div class="ap-demo-head">
        <span class="ap-demo-name">${t("a_demo_name")} <code>${DEMO.ticker}</code></span>
        <span class="ap-demo-badge"><i></i>${t("zone_deep")}</span>
      </div>
      <div class="ap-gauge"></div>
      <dl class="ap-demo-kv">
        <div><dt>${t("a_demo_price")}</dt><dd>${DEMO.price.toFixed(2)}</dd></div>
        <div><dt>${t("a_demo_fair")}</dt><dd>${DEMO.fairLow} – ${DEMO.fairHigh}</dd></div>
        <div><dt>${t("a_demo_mos")}</dt><dd>${DEMO.mos}%</dd></div>
      </dl>
      <figcaption>${t("a_demo_note")}</figcaption>
    </figure>
    <ul class="ap-feats">${feats.map(([ic, k]) => `<li><span class="ap-ico">${ri(ic)}</span><div><b>${t(k)}</b><span>${t(k + "_d")}</span></div></li>`).join("")}</ul>`;
  const g = new Gauge(host.querySelector(".ap-gauge"));
  g.setName(t("a_demo_name"));
  // 裁掉钟摆四周留白（几何固定：区间带 x 110–490、y 112–302，留 6px 余量；不用 getBBox，英文区间名会把包围盒撑大）
  g.svg.setAttribute("viewBox", "104 104 392 206");
  // 等首帧画出后再摆进来（与看板一致的入场摆动；减少动效时 Gauge 自己直接落位）
  requestAnimationFrame(() => g.set(DEMO));
  return g;
}

// 显示 / 隐藏密码：眼睛按钮切换 input 的 type
export function wirePasswordToggle(input, btn) {
  const sync = () => {
    const shown = input.type === "text";
    btn.innerHTML = ri(shown ? "eye-off-line" : "eye-line");
    btn.setAttribute("aria-label", t(shown ? "a_pw_hide" : "a_pw_show"));
    btn.setAttribute("aria-pressed", shown ? "true" : "false");
  };
  btn.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    sync();
    input.focus();
  });
  sync();
}

// 服务端的错误文案是中文：认得的换成当前语言，并标到对应输入框；认不得的原样显示
const SERVER_ERRORS = [
  ["用户名或密码错误", "a_err_cred", ["p", "u"]], // 先聚焦密码：多半是密码输错
  ["用户名需", "a_err_username_fmt", ["u"]],
  ["密码需", "a_err_password_len", ["p"]],
  ["用户名已被占用", "a_err_username_taken", ["u"]],
  ["激活码无效", "a_err_code_bad", ["c"]],
  ["用户名或网址已被占用", "a_err_retry_taken", ["u"]],
];
export function mapServerError(msg) {
  for (const [needle, key, fields] of SERVER_ERRORS) if (msg && msg.startsWith(needle)) return { text: t(key), fields };
  return { text: msg, fields: [] };
}

// 表单状态：顶部错误条 + 输入框 aria-invalid；按钮加载态
export function formState(form, errEl, btn) {
  const label = btn.querySelector(".ap-btn-label");
  const idle = label.textContent;
  form.addEventListener("input", (e) => e.target.removeAttribute("aria-invalid")); // 改过的字段不再标红
  return {
    clear() {
      errEl.hidden = true; errEl.querySelector("span").textContent = "";
      form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    },
    error(text, fieldIds = []) {
      errEl.querySelector("span").textContent = text; errEl.hidden = false;
      fieldIds.forEach((id) => form.querySelector("#" + id)?.setAttribute("aria-invalid", "true"));
      const first = fieldIds.length && form.querySelector("#" + fieldIds[0]);
      if (first) { first.focus(); if (first.select) first.select(); }
    },
    busy(on, busyText) {
      btn.disabled = on; btn.classList.toggle("is-busy", on); btn.setAttribute("aria-busy", on ? "true" : "false");
      label.textContent = on ? busyText : idle;
    },
  };
}

// 必填项为空：返回第一个空字段 id 与提示
export function firstEmpty(form, checks) {
  for (const [id, key] of checks) if (!form.querySelector("#" + id).value.trim()) return { id, text: t(key) };
  return null;
}
