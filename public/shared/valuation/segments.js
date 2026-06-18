/**
 * valuation/segments.js — PE 分部加总。
 * 各分部 { revenue, growth:{c,o}, netMargin:{c,o} } → 第 n 年合计营收/合计净利,
 * 反解出可回填 PE 模型的 混合增速{c,o} 与 混合净利率{c,o}(与 ΣEᵢ 数学恒等)。
 */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

// 返回 { revenue, growth:{c,o}, netMargin:{c,o}, futRev:{c,o}, futNi:{c,o} } 或 null(输入不足)
export function aggregateSegments(rows, n) {
  const years = Number(n);
  if (!Array.isArray(rows) || rows.length === 0 || !(years > 0)) return null;
  const revOf = (r) => { const v = num(r && r.revenue); return v > 0 ? v : 0; };
  const R0 = rows.reduce((s, r) => s + revOf(r), 0);
  if (!(R0 > 0)) return null;
  const side = (k) => {
    let futRev = 0, futNi = 0;
    for (const r of rows) {
      const rev = revOf(r); if (!(rev > 0)) continue;
      const g = num(r.growth && r.growth[k]); const mg = num(r.netMargin && r.netMargin[k]);
      const fr = rev * Math.pow(1 + (Number.isFinite(g) ? g : 0) / 100, years);
      futRev += fr;
      futNi += fr * (Number.isFinite(mg) ? mg : 0) / 100;
    }
    return { growth: (Math.pow(futRev / R0, 1 / years) - 1) * 100, netMargin: futRev > 0 ? futNi / futRev * 100 : 0, futRev, futNi };
  };
  const c = side("c"), o = side("o");
  return { revenue: R0, growth: { c: c.growth, o: o.growth }, netMargin: { c: c.netMargin, o: o.netMargin }, futRev: { c: c.futRev, o: o.futRev }, futNi: { c: c.futNi, o: o.futNi } };
}
