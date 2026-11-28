import { describe, it, expect, beforeEach } from "vitest";

// 极简 DOM 桩，用于验证 langmenu.js 的键盘 / 点击展开收起状态机与事件传播
function makeDom() {
  const docListeners = new Map();
  let active = null;
  function makeNode(tag) {
    const classes = new Set();
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parentNode: null,
      textContent: "",
      type: "",
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
      },
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      append(...cs) { cs.forEach((c) => this.appendChild(c)); },
      contains(target) {
        let cur = target;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
      },
      focus() { active = this; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const cls = sel.startsWith(".") ? sel.slice(1) : null;
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (cls && c.classList.contains(cls)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        const event = {
          type,
          target: this,
          stopped: false,
          prevented: false,
          stopPropagation() { this.stopped = true; },
          preventDefault() { this.prevented = true; },
          ...ev,
        };
        let cur = this;
        while (cur && !event.stopped) {
          for (const fn of (cur._listeners.get(type) || [])) fn(event);
          cur = cur.parentNode;
        }
        if (!event.stopped) {
          for (const fn of (docListeners.get(type) || [])) fn(event);
        }
        return event;
      },
      _listeners: listeners,
    };
    return node;
  }
  const document = {
    get activeElement() { return active; },
    createElement: (tag) => makeNode(tag),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    documentElement: { lang: "zh-CN" },
  };
  return { document, makeNode, getActive: () => active };
}

describe("langmenu keyboard & state interactions", () => {
  let dom, host, mountLangMenu;

  beforeEach(async () => {
    dom = makeDom();
    globalThis.document = dom.document;
    globalThis.localStorage = { getItem: () => "zh", setItem: () => {} };
    globalThis.location = { reload: () => {} };
    host = dom.makeNode("div");
    ({ mountLangMenu } = await import("../public/shared/langmenu.js"));
  });

  it("does not swallow Escape when closed, and closes + restores focus when open", () => {
    const wrap = mountLangMenu(host);
    const btn = wrap.querySelector(".lang-btn");
    btn.focus();

    const closedEsc = btn.dispatch("keydown", { key: "Escape" });
    expect(closedEsc.stopped).toBe(false);
    expect(wrap.classList.contains("open")).toBe(false);

    btn.dispatch("click");
    expect(wrap.classList.contains("open")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");

    const openEsc = btn.dispatch("keydown", { key: "Escape" });
    expect(openEsc.stopped).toBe(true);
    expect(wrap.classList.contains("open")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(dom.getActive()).toBe(btn);
  });

  it("opens on ArrowDown, cycles options, and closes when clicking the active language", () => {
    const wrap = mountLangMenu(host);
    const btn = wrap.querySelector(".lang-btn");
    const opts = wrap.querySelectorAll(".lang-opt");
    btn.focus();

    btn.dispatch("keydown", { key: "ArrowDown" });
    expect(wrap.classList.contains("open")).toBe(true);
    expect(dom.getActive()).toBe(opts[0]);

    opts[0].dispatch("keydown", { key: "ArrowDown" });
    expect(dom.getActive()).toBe(opts[1]);

    // 点击当前已选语言（zh）应收起菜单并同步 aria-expanded
    opts[0].dispatch("click");
    expect(wrap.classList.contains("open")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(dom.getActive()).toBe(btn);
  });
});
