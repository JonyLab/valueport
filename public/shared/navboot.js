// 顶部导航首帧就绪（普通同步脚本，紧跟在 </header> 后面引入，在首次绘制前执行）：
// 页面主脚本是 module，要等加载完才跑；在那之前导航会先缺 tab、显示英文占位、没有语言按钮，切页时就会「消失再出现」。
// 这里先把三件事做掉：① tab 文案按当前语言 ② 上次确认过是本看板主人就先显示主人导航 ③ 放一个静态的语言按钮占位（mountLangMenu 会原地替换）。
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
    ["appNav", "btnShare", "btnSettings"].forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.remove("hidden"); });
  }
  var host = document.getElementById("topActions");
  if (host && !host.querySelector(".lang-menu")) {
    var w = document.createElement("div"); w.className = "lang-menu"; w.setAttribute("data-static", "");
    w.innerHTML = '<button type="button" class="btn icon lang-btn" aria-label="切换语言 / Switch language"><i class="ri-global-line" aria-hidden="true"></i></button>';
    host.appendChild(w);
  }
})();
