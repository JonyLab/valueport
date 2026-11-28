// Cloudflare Worker composition root: mounts route registrars, static SPA assets, and scheduled daily jobs.
import { Hono } from "hono";
import { registerMarketRoutes, getQuotes } from "./routes/market.js";
import { registerAuthRoutes, registerBoardRoutes, currentUserId } from "./routes/account.js";
import { registerOwnerRoutes } from "./routes/owner.js";
import { registerPortfolio } from "./portfolio.js";
import { PortfolioStorageError } from "./portfolio-storage.js";
import { registerAi } from "./ai.js";
import { registerJev } from "./jev.js";
import { registerAiChats } from "./ai-chats.js";
import { registerResearch } from "./research.js";
import { registerManagementResearch } from "./management-research.js";
import { registerBusinessReports } from "./business-report.js";
import { registerMacro, refreshIfStale } from "./macro.js";
import { registerFeedback } from "./feedback.js";
import { fetchLongbridgeAssets } from "./brokers/longbridge-assets.js";
import { fetchIbkrFlex } from "./brokers/ibkr-flex.js";
import { fetchTigerAssets } from "./brokers/tiger.js";
import { fetchSchwabAssets, schwabAuthorizeUrl, schwabExchangeCode } from "./brokers/schwab.js";
import { fetchEtradeAssets, etradeStart, etradeFinish } from "./brokers/etrade.js";
import { fetchWebullAssets } from "./brokers/webull.js";
import { parseHoldingsCsv } from "./brokers/csv.js";

const app = new Hono();
app.onError((error, c) => {
  if (error instanceof PortfolioStorageError) {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: false, error: "portfolio_storage_unavailable" }, 503);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

/* ---------- Public market & user auth/session ---------- */
registerMarketRoutes(app);
registerAuthRoutes(app); // mounts /api/config, /api/register, /api/login, /api/logout, /api/me, and /api/my/* guard

/* ---------- Feature modules (/api/my/* & public research/macro) ---------- */
registerAi(app);
registerJev(app);
registerAiChats(app);
registerResearch(app);
registerManagementResearch(app);
registerBusinessReports(app);
registerMacro(app);
registerFeedback(app);
const portfolio = registerPortfolio(app, {
  adapters: {
    longbridge: (cr) => fetchLongbridgeAssets(cr),
    ibkr: (cr) => fetchIbkrFlex(cr),
    tiger: (cr) => fetchTigerAssets(cr),
    schwab: (cr) => fetchSchwabAssets(cr),
    etrade: (cr) => fetchEtradeAssets(cr),
    webull: (cr) => fetchWebullAssets(cr),
    oauth: {
      schwab: {
        start: (cr, { redirectUri, state }) => ({ url: schwabAuthorizeUrl(cr.appKey, redirectUri, state) }),
        finish: (cr, { code }, { redirectUri }) => schwabExchangeCode(cr, code, redirectUri),
      },
      etrade: {
        start: async (cr) => { const r = await etradeStart(cr); return { url: r.url, verifier: true, pending: { requestToken: r.requestToken, requestSecret: r.requestSecret } }; },
        finish: (cr, { verifier }) => etradeFinish(cr, verifier),
      },
    },
    csv: (text) => parseHoldingsCsv(text),
  },
  getQuotes,
});
registerBoardRoutes(app);
registerOwnerRoutes(app);

/* ---------- Static HTML & SPA entry routes ---------- */
const serveAsset = (pathname) => (c) => {
  const url = new URL(c.req.url);
  url.pathname = pathname;
  return c.env.ASSETS.fetch(new Request(url, { method: "GET" }));
};

app.get("/app", async (c) => {
  const uid = await currentUserId(c);
  if (uid) {
    const u = await c.env.DB.prepare("SELECT board_slug FROM users WHERE id=?").bind(uid).first();
    if (u) return c.redirect("/b/" + u.board_slug, 302);
  }
  return c.redirect("/login", 302);
});
app.get("/b/:slug", serveAsset("/"));
app.get("/b/:slug/:code", serveAsset("/"));
app.get("/portfolio", serveAsset("/portfolio.html"));
app.get("/macro", serveAsset("/macro.html"));
app.get("/valuation", serveAsset("/valuation.html"));
app.all("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "not found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  // 每日：同步券商账户 + 记资产快照；宏观序列超过 7 天没刷新就顺带刷新一次
  scheduled: (event, env, ctx) => ctx.waitUntil(Promise.all([
    portfolio.runDaily(env),
    refreshIfStale(env).catch((e) => console.error("macro refresh failed:", e && e.message)),
  ])),
};
