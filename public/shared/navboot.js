// 顶部导航首帧就绪（普通同步脚本，紧跟在 </header> 后面引入，在首次绘制前执行）：
// 页面主脚本是 module，要等加载完才跑；在那之前导航会先缺 tab、显示英文占位、没有语言按钮，切页时就会「消失再出现」。
// 这里先把几件事做掉：① tab 文案按当前语言 ② 上次确认过是本看板主人就先显示主人导航 ③ 放一个静态的语言按钮占位（mountLangMenu 会原地替换）。
(function () {
  var lang;
  try { var saved = localStorage.getItem("pendulum_lang"); if (saved === "zh" || saved === "en") lang = saved; } catch (e) { /* 存储不可用 */ }
  if (!lang) lang = (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  var TX = { zh: { nav_portfolio: "资产", nav_watchlist: "自选", nav_macro: "宏观看板" }, en: { nav_portfolio: "Portfolio", nav_watchlist: "Watchlist", nav_macro: "Macro" } }[lang];
  var nav = document.querySelector(".topnav");
  if (!nav) return;
  nav.querySelectorAll("[data-i18n]").forEach(function (el) { var v = TX[el.getAttribute("data-i18n")]; if (v) el.textContent = v; });
  var m = location.pathname.match(/^\/b\/([^/]+)/);
  var ownerSlug = null; try { ownerSlug = sessionStorage.getItem("owner_slug"); } catch (e) { /* ignore */ }
  if (m && ownerSlug && ownerSlug === decodeURIComponent(m[1])) {
    ["appNav", "btnSettings"].forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.remove("hidden"); });
  }
  // ④ 本次会话有这页的缓存：页面脚本会先直接画缓存，首帧就不画骨架（骨架只给第一次、需要完全加载的时候）
  try {
    var hasCache = false;
    if (m) hasCache = !!sessionStorage.getItem("board_cache_" + decodeURIComponent(m[1]));
    else if (location.pathname === "/portfolio") {
      var u = sessionStorage.getItem("pf_user"), b = localStorage.getItem("pf_base") || (lang === "zh" ? "CNY" : "USD");
      if (["USD", "HKD", "CNY"].indexOf(b) < 0) b = "USD";
      hasCache = !!(u && sessionStorage.getItem("pf_cache_" + u + "_" + b));
    }
    if (hasCache) document.documentElement.classList.add("has-cache");
  } catch (e) { /* ignore */ }
  var host = document.getElementById("topActions");
  // ⑤ 资产 / 宏观等一级页也放设置按钮（设置页在自选看板里：/b/<slug>#settings）；身份稍后才知道的页面调 __mountSettingsBtn(slug)
  window.__mountSettingsBtn = function (slug) {
    if (!host || !slug || document.getElementById("btnSettings")) return;
    var a = document.createElement("a"); a.className = "btn icon"; a.id = "btnSettings";
    a.href = "/b/" + encodeURIComponent(slug) + "#settings";
    var t = lang === "zh" ? "设置" : "Settings"; a.title = t; a.setAttribute("aria-label", t);
    a.innerHTML = '<i class="ri-equalizer-line" aria-hidden="true"></i>';
    host.insertBefore(a, host.firstChild);
  };
  if (!m && ownerSlug) window.__mountSettingsBtn(ownerSlug);
  if (host && !host.querySelector(".lang-menu")) {
    var w = document.createElement("div"); w.className = "lang-menu"; w.setAttribute("data-static", "");
    w.innerHTML = '<button type="button" class="btn icon lang-btn" aria-label="切换语言 / Switch language"><i class="ri-global-line" aria-hidden="true"></i></button>';
    host.appendChild(w);
  }
})();
