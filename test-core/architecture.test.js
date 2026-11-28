import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize, relative, resolve } from "node:path";
import { LOCAL_KEYS, SESSION_KEYS } from "../public/shared/storage-keys.js";
import { utcToday, utcDaysAgo, readBoundedBytes } from "../src/lib/runtime.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const IMPORT_RX = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, exts) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => ent.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function rel(full) {
  return relative(ROOT, full).replace(/\\/g, "/");
}

function localDeps(full) {
  const txt = readFileSync(full, "utf8");
  const deps = [];
  for (const m of txt.matchAll(IMPORT_RX)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    let target = null;
    if (spec.startsWith(".")) target = normalize(join(dirname(full), spec));
    else if (spec.startsWith("/shared/")) target = normalize(join(ROOT, "public", spec));
    else continue;
    deps.push({ spec, target });
  }
  return deps;
}

const srcJs = walk(join(ROOT, "src"), [".js"]);
const pubJs = walk(join(ROOT, "public"), [".js"]);
const allJs = [...srcJs, ...pubJs];

describe("architecture fitness checks", () => {
  it("has zero circular dependencies across src/ and public/", () => {
    const adj = new Map(allJs.map((f) => [f, [...new Set(localDeps(f).map((d) => d.target))]]));
    const state = new Map();
    const cycles = [];
    function dfs(u, stack) {
      state.set(u, 1);
      stack.push(u);
      for (const v of adj.get(u) || []) {
        if (state.get(v) === 1) cycles.push(stack.slice(stack.indexOf(v)).concat(v).map(rel).join(" -> "));
        else if (!state.get(v) && adj.has(v)) dfs(v, stack);
      }
      stack.pop();
      state.set(u, 2);
    }
    for (const f of allJs) if (!state.get(f)) dfs(f, []);
    expect(cycles).toEqual([]);
  });

  it("resolves every local ES import in src/ and public/ to an existing file", () => {
    const missing = [];
    for (const f of allJs) {
      for (const { spec, target } of localDeps(f)) {
        if (!existsSync(target)) missing.push(`${rel(f)} -> ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("enforces layer direction: public/ never imports src/, and src/ only imports DOM-free shared modules", () => {
    const badPublicImports = [];
    for (const f of pubJs) {
      for (const { spec, target } of localDeps(f)) {
        if (rel(target).startsWith("src/")) badPublicImports.push(`${rel(f)} -> ${spec}`);
      }
    }
    expect(badPublicImports).toEqual([]);

    const domApiRx = /\b(?:document\.(?:createElement|querySelector|getElementById|body)|window\.addEventListener|(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem))\b/;
    const sharedDomViolations = [];
    for (const f of srcJs) {
      for (const { target } of localDeps(f)) {
        if (rel(target).startsWith("public/")) {
          const code = readFileSync(target, "utf8");
          if (domApiRx.test(code)) sharedDomViolations.push(`${rel(f)} -> ${rel(target)}`);
        }
      }
    }
    expect(sharedDomViolations).toEqual([]);
  });

  it("enforces Single Source of Truth for canonical backend primitives", () => {
    const checkOnlyIn = (rx, allowed) =>
      srcJs.filter((f) => rx.test(readFileSync(f, "utf8"))).map(rel).sort();

    expect(checkOnlyIn(/LONGBRIDGE_APP_KEY\s*&&\s*(?:c\.)?env\.LONGBRIDGE_APP_SECRET/)).toEqual(["src/longbridge.js"]);
    expect(checkOnlyIn(/\bcaches\.default\b/)).toEqual(["src/lib/runtime.js"]);
    expect(checkOnlyIn(/(?:const|function)\s+normCur\b/)).toEqual(["src/brokers/common.js"]);
    expect(checkOnlyIn(/function\s+authError\s*\(/)).toEqual(["src/brokers/common.js"]);
    expect(checkOnlyIn(/function\s+b64ToBytes\s*\(/)).toEqual(["src/crypto.js"]);
  });

  it("enforces Single Source of Truth for canonical frontend primitives", () => {
    const pubFiles = [...pubJs, ...walk(join(ROOT, "public"), [".html"])];
    const checkOnlyIn = (rx) =>
      pubFiles.filter((f) => rx.test(readFileSync(f, "utf8"))).map(rel).sort();

    expect(checkOnlyIn(/(?:function\s+ri\s*\(|const\s+ri\s*=)/)).toEqual(["public/shared/dom.js"]);
    expect(checkOnlyIn(/(?:function\s+el\s*\(\s*tag,\s*cls,\s*(?:text|value)\s*\)|const\s+el\s*=\s*\(\s*tag,\s*cls,\s*(?:text|value)\s*\))/)).toEqual(["public/shared/dom.js"]);
    expect(checkOnlyIn(/(?:function\s+esc\s*\(|const\s+esc\s*=)/)).toEqual(["public/shared/dom.js"]);
    expect(checkOnlyIn(/function\s+setNum\s*\(/)).toEqual(["public/shared/dom.js"]);
    expect(checkOnlyIn(/export\s+function\s+aiErrorText\s*\(/)).toEqual(["public/shared/ai-common.js"]);
    expect(checkOnlyIn(/\bwireSafeDelete\b.*export|export\s+\{[^}]*\bwireSafeDelete\b|export\s+function\s+wireSafeDelete\s*\(/)).toEqual([]);
  });

  it("has zero unused named ES imports across src/ and public/", () => {
    const unused = [];
    for (const f of allJs) {
      const lines = readFileSync(f, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
        if (!m) continue;
        const names = m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
          const parts = s.split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        });
        const rest = lines.filter((_, idx) => idx !== i).join("\n");
        for (const n of names) {
          const rx = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
          if (!rx.test(rest)) unused.push(`${rel(f)}:${i + 1} ${n}`);
        }
      }
    }
    expect(unused).toEqual([]);
  });

  it("keeps synchronous navboot.js storage keys strictly synced with storage-keys.js", () => {
    const navboot = readFileSync(join(ROOT, "public/shared/navboot.js"), "utf8");
    const knownLocal = new Set(Object.values(LOCAL_KEYS));
    const knownSession = new Set(Object.values(SESSION_KEYS));
    for (const m of navboot.matchAll(/localStorage\.getItem\(\s*"([^"]+)"/g)) {
      expect(knownLocal.has(m[1])).toBe(true);
    }
    for (const m of navboot.matchAll(/sessionStorage\.getItem\(\s*"([^"]+)"/g)) {
      expect(knownSession.has(m[1])).toBe(true);
    }
  });

  it("prevents monolithic inline CSS or JS from creeping back into primary HTML pages", () => {
    for (const page of ["index.html", "portfolio.html", "macro.html"]) {
      const html = readFileSync(join(ROOT, "public", page), "utf8");
      const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
      expect(styleBlocks.length, `${page} should use external CSS`).toBe(0);
      const inlineScriptLines = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)]
        .reduce((sum, m) => sum + m[1].trim().split("\n").filter(Boolean).length, 0);
      expect(inlineScriptLines, `${page} inline script lines`).toBeLessThanOrEqual(30);
    }
    expect(existsSync(join(ROOT, "public/admin.html"))).toBe(false);
  });

  it("has no unreferenced JS modules in src/ or public/shared/", () => {
    const allRefsCorpus = [
      ...allJs,
      ...walk(join(ROOT, "public"), [".html"]),
      ...walk(join(ROOT, "test"), [".js"]),
      ...walk(join(ROOT, "test-core"), [".js"]),
    ].map((f) => ({ f, txt: readFileSync(f, "utf8") }));
    const entryPoints = new Set(["src/index.js", "public/shared/navboot.js"]);
    const unreferenced = [];
    for (const f of allJs) {
      const r = rel(f);
      if (entryPoints.has(r)) continue;
      const base = r.split("/").pop();
      const referenced = allRefsCorpus.some((c) => c.f !== f && c.txt.includes(base));
      if (!referenced) unreferenced.push(r);
    }
    expect(unreferenced).toEqual([]);
  });
});

describe("src/lib/runtime.js", () => {
  it("formats UTC dates and enforces bounded byte limits", async () => {
    const fixed = Date.UTC(2026, 9, 20, 12, 0, 0);
    expect(utcToday(fixed)).toBe("2026-10-20");
    expect(utcDaysAgo(5, fixed)).toBe("2026-10-15");

    const okRes = new Response("hello world", { status: 200 });
    const bytes = await readBoundedBytes(okRes, 32);
    expect(new TextDecoder().decode(bytes)).toBe("hello world");

    const bigRes = new Response("0123456789abcdef", { status: 200 });
    await expect(readBoundedBytes(bigRes, 8, { tooLargeError: "too_big" })).rejects.toThrow("too_big");

    const errRes = new Response("nope", { status: 503 });
    await expect(readBoundedBytes(errRes, 32, { failedError: "upstream_fail", attachStatus: true }))
      .rejects.toMatchObject({ message: "upstream_fail", status: 503 });
  });
});
