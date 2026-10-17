// 语言切换（全站共用）：地球图标按钮，悬停 / 键盘聚焦 / 点按弹出「中文 / English」下拉，当前语言后面有暖黄圆点。
// 用法：mountLangMenu(容器) → 返回菜单元素（已追加到容器末尾）。样式在 /shared/styles.css 的 .lang-menu。
import { LANG, setLang } from "./i18n.js";

export function mountLangMenu(host) {
  const wrap = document.createElement("div");
  wrap.className = "lang-menu";
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn icon lang-btn";
  btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", "切换语言 / Switch language");
  const ico = document.createElement("i"); ico.className = "ri-global-line"; ico.setAttribute("aria-hidden", "true");
  btn.appendChild(ico);
  const pop = document.createElement("div");
  pop.className = "lang-pop"; pop.setAttribute("role", "menu"); pop.setAttribute("aria-label", "语言 / Language");
  for (const [code, label] of [["zh", "中文"], ["en", "English"]]) {
    const o = document.createElement("button");
    o.type = "button"; o.className = "lang-opt" + (code === LANG ? " on" : ""); o.textContent = label;
    o.setAttribute("role", "menuitemradio"); o.setAttribute("aria-checked", code === LANG ? "true" : "false");
    o.addEventListener("click", () => { if (code !== LANG) setLang(code); else setOpen(false); });
    pop.appendChild(o);
  }
  wrap.append(btn, pop);
  // 触屏没有 hover：点按图标开合，点菜单外收起
  function setOpen(open) { wrap.classList.toggle("open", open); btn.setAttribute("aria-expanded", open ? "true" : "false"); }
  btn.addEventListener("click", () => setOpen(!wrap.classList.contains("open")));
  wrap.addEventListener("mouseenter", () => btn.setAttribute("aria-expanded", "true"));
  wrap.addEventListener("mouseleave", () => { if (!wrap.classList.contains("open")) btn.setAttribute("aria-expanded", "false"); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) setOpen(false); });
  // navboot.js 首帧放过一个静态占位：原地替换，位置不变、不闪
  const stub = host.querySelector(".lang-menu[data-static]");
  if (stub) stub.replaceWith(wrap); else host.appendChild(wrap);
  return wrap;
}
