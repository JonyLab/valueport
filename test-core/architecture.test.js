import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize, relative, resolve } from "node:path";
import * as acorn from "acorn";
import { LOCAL_KEYS, SESSION_KEYS } from "../public/shared/storage-keys.js";
import { activeAiModel } from "../public/shared/ai-common.js";
import { utcToday, utcDaysAgo, readBoundedBytes, scheduleEdgeCachePut } from "../src/lib/runtime.js";

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

function resolveSpec(fromFile, spec) {
  if (!spec) return null;
  if (spec.startsWith(".")) return normalize(join(dirname(fromFile), spec));
  if (spec.startsWith("/shared/")) return normalize(join(ROOT, "public", spec));
  return null;
}

function localDeps(full) {
  const txt = readFileSync(full, "utf8");
  const deps = [];
  for (const m of txt.matchAll(IMPORT_RX)) {
    const spec = m[1] || m[2];
    const target = resolveSpec(full, spec);
    if (target) deps.push({ spec, target });
  }
  return deps;
}

function collectPatternNames(node, out) {
  if (!node) return;
  if (node.type === "Identifier") out.add(node.name);
  else if (node.type === "ObjectPattern") {
    for (const p of node.properties) collectPatternNames(p.type === "RestElement" ? p.argument : p.value, out);
  } else if (node.type === "ArrayPattern") {
    for (const el of node.elements) collectPatternNames(el, out);
  } else if (node.type === "AssignmentPattern") collectPatternNames(node.left, out);
  else if (node.type === "RestElement") collectPatternNames(node.argument, out);
}

const srcJs = walk(join(ROOT, "src"), [".js"]);
const pubJs = walk(join(ROOT, "public"), [".js"]);
const allJs = [...srcJs, ...pubJs];

const parsedCache = new Map();
function parseAst(full) {
  if (!parsedCache.has(full)) {
    const code = readFileSync(full, "utf8");
    parsedCache.set(full, { code, ast: acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) });
  }
  return parsedCache.get(full);
}

const exportCache = new Map();
function moduleExports(full, visiting = new Set()) {
  if (exportCache.has(full)) return exportCache.get(full);
  if (visiting.has(full) || !existsSync(full)) return new Set();
  visiting.add(full);
  const { ast } = parseAst(full);
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") {
      names.add("default");
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        if (node.declaration.id) names.add(node.declaration.id.name);
        else if (node.declaration.declarations) {
          for (const d of node.declaration.declarations) collectPatternNames(d.id, names);
        }
      }
      for (const s of node.specifiers || []) {
        names.add(s.exported.name ?? s.exported.value);
      }
    } else if (node.type === "ExportAllDeclaration") {
      if (node.exported) {
        names.add(node.exported.name ?? node.exported.value);
      } else {
        const target = resolveSpec(full, node.source?.value);
        if (target) {
          for (const n of moduleExports(target, visiting)) {
            if (n !== "default") names.add(n);
          }
        }
      }
    }
  }
  exportCache.set(full, names);
  return names;
}

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

  it("resolves every local ES import/re-export file and exported symbol in src/ and public/", () => {
    const missingFiles = [];
    const missingSymbols = [];
    for (const f of allJs) {
      const { ast } = parseAst(f);
      for (const node of ast.body) {
        const spec = (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration")
          ? node.source?.value
          : null;
        if (!spec) continue;
        const target = resolveSpec(f, spec);
        if (!target) continue;
        if (!existsSync(target)) {
          missingFiles.push(`${rel(f)} -> ${spec}`);
          continue;
        }
        const targetExports = moduleExports(target);
        if (node.type === "ImportDeclaration") {
          for (const s of node.specifiers) {
            if (s.type === "ImportDefaultSpecifier" && !targetExports.has("default")) {
              missingSymbols.push(`${rel(f)} imports missing default from ${rel(target)}`);
            } else if (s.type === "ImportSpecifier") {
              const name = s.imported.name ?? s.imported.value;
              if (!targetExports.has(name)) {
                missingSymbols.push(`${rel(f)} imports missing '${name}' from ${rel(target)}`);
              }
            }
          }
        } else if (node.type === "ExportNamedDeclaration") {
          for (const s of node.specifiers) {
            const name = s.local.name ?? s.local.value;
            if (!targetExports.has(name)) {
              missingSymbols.push(`${rel(f)} re-exports missing '${name}' from ${rel(target)}`);
            }
          }
        }
      }
    }
    expect(missingFiles).toEqual([]);
    expect(missingSymbols).toEqual([]);
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
    const checkOnlyIn = (rx) =>
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

  it("has zero unused ES imports (single-line and multi-line) across src/ and public/", () => {
    const unused = [];
    for (const f of allJs) {
      const { code, ast } = parseAst(f);
      const importRanges = [];
      const bindings = [];
      for (const node of ast.body) {
        if (node.type !== "ImportDeclaration") continue;
        importRanges.push([node.start, node.end]);
        for (const s of node.specifiers) {
          bindings.push(s.local.name);
        }
      }
      if (!bindings.length) continue;
      let rest = "";
      let cursor = 0;
      for (const [start, end] of importRanges) {
        rest += code.slice(cursor, start) + " ";
        cursor = end;
      }
      rest += code.slice(cursor);
      for (const name of bindings) {
        const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!rx.test(rest)) unused.push(`${rel(f)} ${name}`);
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

  it("has no unreferenced JS modules in src/ or public/ (exact resolved path graph)", () => {
    const referenced = new Set(["src/index.js"]);
    const jsImporters = [...allJs, ...walk(join(ROOT, "test"), [".js"]), ...walk(join(ROOT, "test-core"), [".js"])];
    for (const f of jsImporters) {
      for (const { target } of localDeps(f)) {
        if (target !== f) referenced.add(rel(target));
      }
    }
    for (const htmlFile of walk(join(ROOT, "public"), [".html"])) {
      const html = readFileSync(htmlFile, "utf8");
      for (const m of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
        const target = resolveSpec(htmlFile, m[1]);
        if (target) referenced.add(rel(target));
      }
      for (const [, code] of html.matchAll(/<script\s+type=["']module["']>([\s\S]*?)<\/script>/g)) {
        for (const m of code.matchAll(IMPORT_RX)) {
          const target = resolveSpec(htmlFile, m[1] || m[2]);
          if (target) referenced.add(rel(target));
        }
      }
    }
    const unreferenced = allJs.map(rel).filter((r) => !referenced.has(r));
    expect(unreferenced).toEqual([]);
  });
});

describe("src/lib/runtime.js", () => {
  it("formats UTC dates and enforces bounded byte limits, content-length, and abort signals", async () => {
    const fixed = Date.UTC(2026, 9, 20, 12, 0, 0);
    expect(utcToday(fixed)).toBe("2026-10-20");
    expect(utcDaysAgo(5, fixed)).toBe("2026-10-15");

    const okRes = new Response("hello world", { status: 200 });
    const bytes = await readBoundedBytes(okRes, 32);
    expect(new TextDecoder().decode(bytes)).toBe("hello world");

    const bigRes = new Response("0123456789abcdef", { status: 200 });
    await expect(readBoundedBytes(bigRes, 8, { tooLargeError: "too_big" })).rejects.toThrow("too_big");

    const headerBigRes = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "999" }),
      body: { cancel: vi.fn().mockRejectedValue(new Error("cancel_boom")) },
    };
    await expect(readBoundedBytes(headerBigRes, 32, { tooLargeError: "header_too_big" }))
      .rejects.toThrow("header_too_big");

    const errRes = {
      ok: false,
      status: 503,
      headers: new Headers(),
      body: { cancel: vi.fn().mockRejectedValue(new Error("cancel_boom")) },
    };
    await expect(readBoundedBytes(errRes, 32, { failedError: "upstream_fail", attachStatus: true }))
      .rejects.toMatchObject({ message: "upstream_fail", status: 503 });

    const ac = new AbortController();
    ac.abort(new Error("aborted_read"));
    await expect(readBoundedBytes(new Response("abc", { status: 200 }), 32, { signal: ac.signal }))
      .rejects.toThrow("aborted_read");
  });

  it("treats scheduleEdgeCachePut as best-effort across waitUntil, fallback, and cache errors", async () => {
    const origCaches = globalThis.caches;
    try {
      const waitUntil = vi.fn();
      globalThis.caches = { default: { put: vi.fn().mockRejectedValue(new Error("cache_down")) } };
      scheduleEdgeCachePut({ executionCtx: { waitUntil } }, new Request("https://example.com/a"), new Response("ok"));
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();

      // Fallback when executionCtx getter throws (non-Worker runtime)
      const fallbackTask = scheduleEdgeCachePut(
        { get executionCtx() { throw new Error("no_ctx"); } },
        new Request("https://example.com/b"),
        new Response("ok"),
      );
      await expect(fallbackTask).resolves.toBeUndefined();

      // Synchronous throw from cache.put is swallowed cleanly
      globalThis.caches = { default: { put: vi.fn(() => { throw new Error("sync_cache_err"); }) } };
      expect(() => scheduleEdgeCachePut({ executionCtx: { waitUntil } }, new Request("https://example.com/c"), new Response("ok")))
        .not.toThrow();
    } finally {
      if (origCaches === undefined) delete globalThis.caches;
      else globalThis.caches = origCaches;
    }
  });
});

describe("public/shared/ai-common.js", () => {
  it("resolves the active model across site, workers, siteKey, and custom groups with safe fallback", () => {
    expect(activeAiModel(null)).toBeNull();
    expect(activeAiModel({})).toBeNull();
    const models = {
      active: "custom-1",
      site: { id: "site", name: "Default" },
      workers: [{ id: "w-1", name: "Workers" }],
      siteKey: [{ id: "free-1", name: "Free" }],
      custom: [{ id: "custom-1", name: "My Model" }],
    };
    expect(activeAiModel(models)).toEqual({ id: "custom-1", name: "My Model" });
    expect(activeAiModel({ ...models, active: "unknown" })).toEqual({ id: "site", name: "Default" });
  });
});
