// Canonical browser DOM, icon, escaping, number formatting, and stock-logo helpers.

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function ri(name) {
  const i = document.createElement("i");
  i.className = "ri-" + name;
  i.setAttribute("aria-hidden", "true");
  return i;
}

export const riHtml = (name) => `<i class="ri-${name}" aria-hidden="true"></i>`;

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// 大号数字：小数点及之后（含 % 等后缀）缩小显示，"343.46" → 343<span class="num-dec">.46</span>
export function setNum(node, text) {
  const s = String(text ?? "");
  const i = s.search(/\.\d/);
  node.textContent = i < 0 ? s : s.slice(0, i);
  if (i >= 0) node.appendChild(el("span", "num-dec", s.slice(i)));
}

// 标的 logo：先放首字母占位，/api/logo 图片加载成功再替换；失败（404 / 网络）保留首字母
export function mountStockLogo(node, symbol, fallbackLabel) {
  node.textContent = (fallbackLabel || symbol || "?").trim().slice(0, 1).toUpperCase();
  node.classList.remove("has-img");
  if (!symbol) return;
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.onload = () => {
    node.replaceChildren(img);
    node.classList.add("has-img");
  };
  img.src = "/api/logo?symbol=" + encodeURIComponent(symbol);
}
