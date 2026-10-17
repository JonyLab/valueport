import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

// 每个页面 <head> 里的 modulepreload 必须正好覆盖它的整棵模块依赖树（线上每个文件都要回源校验，漏了就会退回逐层串行加载）
const ROOT = new URL("../public", import.meta.url).pathname;
const RX = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
function walk(path, seen) {
  if (seen.has(path)) return;
  seen.add(path);
  for (const m of readFileSync(ROOT + path, "utf8").matchAll(RX)) {
    let dep = m[1] || m[2];
    if (dep.startsWith(".")) dep = posix.normalize(posix.join(posix.dirname(path), dep));
    if (dep.startsWith("/")) walk(dep, seen);
  }
}
function graph(page) {
  const html = readFileSync(`${ROOT}/${page}`, "utf8"), seen = new Set();
  for (const [, code] of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g))
    for (const m of code.matchAll(RX)) { const d = m[1] || m[2]; if (d.startsWith("/")) walk(d, seen); }
  const preloaded = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]));
  return { needed: [...seen].sort(), preloaded: [...preloaded].sort() };
}

describe("modulepreload", () => {
  for (const page of ["index.html", "portfolio.html"]) {
    it(`${page} preloads exactly its module graph`, () => {
      const { needed, preloaded } = graph(page);
      expect(preloaded).toEqual(needed);
    });
  }
});
