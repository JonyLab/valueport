// Run after applying the SQL migration and deploying the encryption-aware Worker.
// Local: node scripts/encrypt-portfolio.mjs
// Remote: supply ADMIN_PASSWORD through the environment and --url=https://your-site
import { readFile } from "node:fs/promises";

const target = new URL(process.argv.find((a) => a.startsWith("--url="))?.slice(6) || "http://localhost:8787");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
if (!local && target.protocol !== "https:") throw new Error("Remote migration requires HTTPS");
if (target.username || target.password) throw new Error("Do not put credentials in the URL");
let password = process.env.ADMIN_PASSWORD;
if (!password && local) {
  const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
  const raw = vars.match(/^\s*ADMIN_PASSWORD\s*=\s*(.*?)\s*$/m)?.[1];
  if (raw) password = raw.replace(/^(["'])(.*)\1$/, "$2");
}
if (!password) throw new Error("ADMIN_PASSWORD is required; do not pass it as a command argument");
const login = await fetch(new URL("/api/owner/login", target), {
  method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }), signal: AbortSignal.timeout(30000),
});
if (!login.ok) throw new Error(`Owner login failed (${login.status})`);
const cookie = login.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
if (!cookie) throw new Error("Missing owner session");
try {
  for (let batch = 1; batch <= 10000; batch++) {
    const res = await fetch(new URL("/api/owner/portfolio/encrypt", target), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ limit: 50 }), signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Backfill failed (${res.status}); check the schema and CREDENTIALS_KEY`);
    const { migrated, remaining, done } = await res.json();
    if (!Number.isInteger(migrated) || !Number.isInteger(remaining) || typeof done !== "boolean") throw new Error("Invalid migration response");
    console.log(`Batch ${batch}: migrated=${migrated}, remaining=${remaining}`);
    if (done) { console.log("Portfolio encryption backfill complete."); break; }
    if (migrated === 0 || batch === 10000) throw new Error("Backfill incomplete; rerun after checking server status");
  }
} finally {
  await fetch(new URL("/api/owner/logout", target), { method: "POST", redirect: "error", headers: { cookie }, signal: AbortSignal.timeout(10000) }).catch(() => {});
}
