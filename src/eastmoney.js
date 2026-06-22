// 东方财富 F10「主要指标」—— 取最新年报「扣除非经常性损益净利润」(KCFJCXSYJLR)。
// 仅 A 股(沪/深/北);免费、无鉴权。调用方按日缓存。失败一律返回 null,不抛。

// 把本项目的标的代码(如 sh688981)转成东财 SECUCODE(688981.SH);非 A 股返回 null。
export function symbolToSecucode(symbol) {
  const m = /^(sh|sz|bj)(\d{4,6})$/i.exec(symbol || "");
  return m ? `${m[2]}.${m[1].toUpperCase()}` : null;
}

// 从 RPT_F10_FINANCE_MAINFINADATA 响应取最新年报(REPORT_DATE 落在 12-31)的扣非净利润;取不到为 null。
export function parseDeducted(json) {
  const rows = json && json.result && json.result.data;
  if (!Array.isArray(rows)) return null;
  const annual = rows
    .filter((r) => r && typeof r.REPORT_DATE === "string" && r.REPORT_DATE.slice(0, 10).endsWith("-12-31"))
    .sort((a, b) => (a.REPORT_DATE < b.REPORT_DATE ? 1 : -1)); // 最新年报在前
  for (const r of annual) {
    const raw = r.KCFJCXSYJLR;
    if (raw == null || raw === "") continue; // 空值跳过(Number(null)=0 会误判)
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// 拉取最新年报扣非净利润(仅 A 股)。非 A 股 / 失败 → null。
export async function fetchDeductedNetIncome(symbol) {
  const secu = symbolToSecucode(symbol);
  if (!secu) return null;
  const url = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
    + "?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL"
    + `&filter=(SECUCODE%3D%22${secu}%22)&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=20&source=HSF10&client=PC`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/" } });
    if (!res.ok) return null;
    return parseDeducted(await res.json());
  } catch { return null; }
}
