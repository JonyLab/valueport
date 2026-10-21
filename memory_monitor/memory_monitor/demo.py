from datetime import datetime
from decimal import Decimal
from html import escape
from pathlib import Path
from typing import Iterable, Optional

from memory_monitor.config import MonitorConfig
from memory_monitor.db import connect


DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "demo" / "index.html"


def fmt_decimal(value: object, places: int = 2) -> str:
    if value is None:
        return "-"
    number = Decimal(str(value))
    return f"{number:,.{places}f}"


def fmt_percent(value: object) -> str:
    if value is None:
        return "-"
    return f"{Decimal(str(value)) * Decimal('100'):.2f}%"


def find_spot(rows: Iterable[dict], product_type: str) -> Optional[dict]:
    return next((row for row in rows if row.get("product_type") == product_type), None)


def premium_rate(row: Optional[dict]) -> Optional[Decimal]:
    if not row or row.get("contract_price") in (None, 0):
        return None
    rate = Decimal(str(row["spot_avg_price"])) / Decimal(str(row["contract_price"])) - Decimal("1")
    if rate > Decimal("1.00") or rate < Decimal("-0.80"):
        return None
    return rate


def has_sane_spread(row: dict) -> bool:
    if row.get("price_spread") is None or row.get("contract_price") in (None, 0):
        return False
    return premium_rate(row) is not None


def kpi_class(rate: Optional[Decimal], threshold: Decimal) -> str:
    if rate is None:
        return "neutral"
    return "positive" if rate >= threshold else "watch"


def threshold_class(value: Optional[Decimal], threshold: Decimal) -> str:
    if value is None:
        return "neutral"
    return "positive" if value > threshold else "watch"


def market_view(ddr5_premium: Optional[Decimal], adata_mom: Optional[Decimal]) -> tuple[str, str, str]:
    price_hot = ddr5_premium is not None and ddr5_premium >= Decimal("0.10")
    demand_hot = adata_mom is not None and adata_mom >= Decimal("0.15")
    if price_hot and demand_hot:
        return (
            "偏多观察",
            "价格与模组营收同向偏强",
            "DDR5 现货溢价超过 10%，且威剛月营收 MoM 超过 15%。HBM 分流参数尚未接入，因此还不能触发完整结构性做多信号，但供需温度已经明显抬升。",
        )
    if price_hot:
        return (
            "价格先行",
            "现货价格强于合约基准",
            "DDR5 现货溢价已经越过 10%，但威剛营收确认不足。更像价格端先动，需要等待需求侧复核。",
        )
    if demand_hot:
        return (
            "需求修复",
            "模组厂营收动能较强",
            "威剛月营收 MoM 超过 15%，但 DDR5 现货溢价尚未越过关键阈值。需求改善需要价格确认。",
        )
    return (
        "中性监控",
        "尚未形成共振",
        "当前价格和需求侧信号没有同时越过阈值。继续观察连续性，而不是提前下结论。",
    )


def data_sufficiency_items(spot_rows: list[dict], revenue_rows: list[dict], macro_rows: list[dict]) -> list[tuple[str, str, str]]:
    spot_products = {}
    for row in spot_rows:
        spot_products.setdefault(str(row["product_type"]), set()).add(str(row.get("crawl_date", ""))[:10])
    spot_days = max((len(days) for days in spot_products.values()), default=0)

    revenue_companies = {}
    for row in revenue_rows:
        revenue_companies.setdefault(str(row["company_code"]), set()).add(str(row.get("report_month", "")))
    revenue_months = max((len(months) for months in revenue_companies.values()), default=0)

    sane_spreads = sum(1 for row in spot_rows if has_sane_spread(row))
    hbm_rows = sum(
        1
        for row in macro_rows
        if row.get("hbm_wafer_allocation_pct") is not None and row.get("hbm_die_penalty") is not None
    )

    return [
        (
            "bad" if spot_days < 3 else "ok",
            "现货趋势样本不足" if spot_days < 3 else "现货趋势可读",
            f"当前每个产品最多 {spot_days} 个交易日采样；至少需要 3 天看斜率，5-7 天看加速/阴跌信号。",
        ),
        (
            "bad" if revenue_months < 2 else "ok",
            "营收趋势样本不足" if revenue_months < 2 else "营收趋势可读",
            f"当前每家公司最多 {revenue_months} 个月度点；至少需要 2 个月判断连续转正，3 个月看趋势质量。",
        ),
        (
            "bad" if sane_spreads < 1 else "ok",
            "合约价口径未校准" if sane_spreads < 1 else "价差口径可用",
            f"当前可用同单位价差产品 {sane_spreads} 个；占位合约价会造成千百分比溢价，已禁止驱动观点。",
        ),
        (
            "bad" if hbm_rows < 1 else "ok",
            "HBM 供给参数缺失" if hbm_rows < 1 else "HBM 供给参数可用",
            f"当前 HBM 投片占比/晶圆惩罚样本 {hbm_rows} 条；没有它就不能触发完整结构性做多信号。",
        ),
    ]


def render_sufficiency_panel(items: list[tuple[str, str, str]]) -> str:
    return "\n".join(
        f"<div class=\"check {state}\"><div class=\"check-title\">{escape(title)}</div><div class=\"check-body\">{escape(body)}</div></div>"
        for state, title, body in items
    )


def cycle_clock(ddr5_premium: Optional[Decimal], adata_mom: Optional[Decimal]) -> str:
    width = 560
    height = 360
    mid_x = 280
    mid_y = 180
    plot_w = 440
    plot_h = 260
    left = 60
    top = 50
    x_value = adata_mom - Decimal("0.15") if adata_mom is not None else None
    y_value = ddr5_premium
    labels = (
        '<text x="392" y="82" class="quadrant-title">结构性牛市</text>'
        '<text x="82" y="82" class="quadrant-title">供给窒息</text>'
        '<text x="84" y="306" class="quadrant-title">周期死寂</text>'
        '<text x="374" y="306" class="quadrant-title">需求先行</text>'
    )
    axis = (
        f'<line x1="{left}" y1="{mid_y}" x2="{left + plot_w}" y2="{mid_y}" class="clock-axis"></line>'
        f'<line x1="{mid_x}" y1="{top}" x2="{mid_x}" y2="{top + plot_h}" class="clock-axis"></line>'
        '<text x="344" y="342" class="clock-axis-label">需求侧增速：威刚 MoM - 15%</text>'
        '<text x="14" y="38" class="clock-axis-label">价格侧溢价：Spot Premium</text>'
    )
    if x_value is None or y_value is None:
        reason = "价格轴待校准" if y_value is None else "需求轴缺数据"
        marker = (
            f'<circle cx="{mid_x}" cy="{mid_y}" r="7" fill="#adb5bd"></circle>'
            f'<text x="{mid_x - 62}" y="{mid_y - 14}" class="clock-missing">{reason}</text>'
        )
    else:
        clamped_x = max(Decimal("-0.30"), min(Decimal("0.30"), x_value))
        clamped_y = max(Decimal("-0.30"), min(Decimal("0.30"), y_value))
        cx = mid_x + int(clamped_x / Decimal("0.30") * (Decimal(plot_w) / 2))
        cy = mid_y - int(clamped_y / Decimal("0.30") * (Decimal(plot_h) / 2))
        marker = (
            f'<circle cx="{cx}" cy="{cy}" r="8" fill="#d9480f" stroke="#ffffff" stroke-width="3"></circle>'
            f'<text x="{min(cx + 12, 420)}" y="{max(cy - 10, 24)}" class="clock-marker">'
            f'X {fmt_percent(x_value)} · Y {fmt_percent(y_value)}</text>'
        )
    return (
        '<svg viewBox="0 0 560 360" role="img" aria-label="The Cycle Clock">'
        '<rect x="60" y="50" width="220" height="130" fill="#fff9db"></rect>'
        '<rect x="280" y="50" width="220" height="130" fill="#e9f8ef"></rect>'
        '<rect x="60" y="180" width="220" height="130" fill="#f1f3f5"></rect>'
        '<rect x="280" y="180" width="220" height="130" fill="#e7f5ff"></rect>'
        f"{labels}{axis}{marker}"
        "</svg>"
    )


def spread_chart(rows: list[dict]) -> str:
    if not rows:
        return "<div class=\"empty\">No spot data</div>"
    chart_rows = [row for row in rows if has_sane_spread(row)]
    if not chart_rows:
        return "<div class=\"empty\">Contract baseline needs same-unit calibration before spread can drive a signal.</div>"
    max_abs = max(abs(Decimal(str(row["price_spread"]))) for row in chart_rows) or Decimal("1")
    bars = []
    for index, row in enumerate(chart_rows[:8]):
        spread = Decimal(str(row["price_spread"]))
        width = max(4, int(abs(spread) / max_abs * 360))
        y = 22 + index * 40
        x = 150 if spread >= 0 else 150 - width
        color = "#087f5b" if spread >= 0 else "#c92a2a"
        label = escape(str(row["product_type"]))
        bars.append(
            f"<text x=\"0\" y=\"{y + 16}\" class=\"axis-label\">{label}</text>"
            f"<rect x=\"{x}\" y=\"{y}\" width=\"{width}\" height=\"20\" rx=\"3\" fill=\"{color}\"></rect>"
            f"<text x=\"{x + width + 8 if spread >= 0 else x - 58}\" y=\"{y + 15}\" class=\"bar-label\">{fmt_decimal(spread, 4)}</text>"
        )
    height = 42 + len(chart_rows[:8]) * 40
    return f"<svg viewBox=\"0 0 560 {height}\" role=\"img\" aria-label=\"Spot contract spread chart\"><line x1=\"150\" y1=\"10\" x2=\"150\" y2=\"{height - 10}\" stroke=\"#9aa4ad\" stroke-dasharray=\"3 4\"></line>{''.join(bars)}</svg>"


def revenue_mom_chart(rows: list[dict]) -> str:
    if not rows:
        return "<div class=\"empty\">No revenue data</div>"
    chart_rows = sorted(
        [row for row in rows if row.get("mom_growth") is not None],
        key=lambda row: Decimal(str(row["mom_growth"])),
        reverse=True,
    )
    if not chart_rows:
        return "<div class=\"empty\">No MoM data</div>"
    max_abs = max(abs(Decimal(str(row["mom_growth"]))) for row in chart_rows) or Decimal("1")
    bars = []
    for index, row in enumerate(chart_rows[:8]):
        mom = Decimal(str(row["mom_growth"]))
        width = max(4, int(abs(mom) / max_abs * 360))
        y = 22 + index * 40
        x = 150 if mom >= 0 else 150 - width
        color = "#1c7ed6" if mom >= 0 else "#c92a2a"
        label = escape(f"{row['company_code']} {row['company_name']}")
        bars.append(
            f"<text x=\"0\" y=\"{y + 16}\" class=\"axis-label\">{label}</text>"
            f"<rect x=\"{x}\" y=\"{y}\" width=\"{width}\" height=\"20\" rx=\"3\" fill=\"{color}\"></rect>"
            f"<text x=\"{x + width + 8 if mom >= 0 else x - 58}\" y=\"{y + 15}\" class=\"bar-label\">{fmt_percent(mom)}</text>"
        )
    height = 42 + len(chart_rows[:8]) * 40
    return f"<svg viewBox=\"0 0 560 {height}\" role=\"img\" aria-label=\"Revenue MoM chart\"><line x1=\"150\" y1=\"10\" x2=\"150\" y2=\"{height - 10}\" stroke=\"#9aa4ad\" stroke-dasharray=\"3 4\"></line>{''.join(bars)}</svg>"


def _line_points(
    values: list[Decimal],
    width: int = 460,
    height: int = 180,
    low: Optional[Decimal] = None,
    high: Optional[Decimal] = None,
) -> list[tuple[int, int]]:
    if not values:
        return []
    low = min(values) if low is None else low
    high = max(values) if high is None else high
    span = high - low or Decimal("1")
    points = []
    for index, value in enumerate(values):
        x = 58 + int(index / max(1, len(values) - 1) * width)
        y = 24 + int((high - value) / span * height)
        points.append((x, y))
    return points


def _polyline(points: list[tuple[int, int]]) -> str:
    return " ".join(f"{x},{y}" for x, y in points)


def spot_trend_chart(rows: list[dict]) -> str:
    series: dict[str, list[dict]] = {}
    for row in reversed(rows):
        series.setdefault(str(row["product_type"]), []).append(row)
    usable = {key: value for key, value in series.items() if value}
    if not usable:
        return "<div class=\"empty\">No spot history yet.</div>"
    colors = ["#087f5b", "#1c7ed6", "#9a6700"]
    lines = []
    legends = []
    for index, (product, product_rows) in enumerate(list(usable.items())[:3]):
        values = [Decimal(str(row["spot_avg_price"])) for row in product_rows]
        points = _line_points(values)
        color = colors[index % len(colors)]
        if len(points) == 1:
            x, y = points[0]
            lines.append(f"<circle cx=\"{x}\" cy=\"{y}\" r=\"5\" fill=\"{color}\"></circle>")
        else:
            lines.append(
                f"<polyline points=\"{_polyline(points)}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></polyline>"
            )
        legends.append(f"<span><i style=\"background:{color}\"></i>{escape(product)}</span>")
    note = "" if max(len(value) for value in usable.values()) > 1 else "<div class=\"trend-note\">当前只有一个采样点；调度运行几天后，这里会显示上扬/下行斜率。</div>"
    return f"<div class=\"legend\">{''.join(legends)}</div><svg viewBox=\"0 0 560 240\" role=\"img\" aria-label=\"Spot price trend\"><line x1=\"58\" y1=\"204\" x2=\"530\" y2=\"204\" stroke=\"#d8dee4\"></line><line x1=\"58\" y1=\"20\" x2=\"58\" y2=\"204\" stroke=\"#d8dee4\"></line>{''.join(lines)}</svg>{note}"


def revenue_trend_chart(rows: list[dict]) -> str:
    series: dict[str, list[dict]] = {}
    for row in reversed(rows):
        label = f"{row['company_code']} {row['company_name']}"
        series.setdefault(label, []).append(row)
    usable = {key: value for key, value in series.items() if value}
    if not usable:
        return "<div class=\"empty\">No revenue history yet.</div>"
    colors = ["#1c7ed6", "#087f5b", "#9a6700", "#7048e8"]
    lines = []
    legends = []
    all_values = [
        Decimal(str(row["mom_growth"]))
        for row in rows
        if row.get("mom_growth") is not None
    ]
    threshold = Decimal("0.15")
    domain_low = min(all_values + [threshold]) if all_values else Decimal("0")
    domain_high = max(all_values + [threshold]) if all_values else Decimal("1")
    threshold_y = _line_points([threshold], low=domain_low, high=domain_high)[0][1]
    for index, (company, company_rows) in enumerate(list(usable.items())[:4]):
        values = [Decimal(str(row["mom_growth"])) for row in company_rows if row.get("mom_growth") is not None]
        if not values:
            continue
        points = _line_points(values, low=domain_low, high=domain_high)
        color = colors[index % len(colors)]
        if len(points) == 1:
            x, y = points[0]
            lines.append(f"<circle cx=\"{x}\" cy=\"{y}\" r=\"5\" fill=\"{color}\"></circle>")
        else:
            lines.append(
                f"<polyline points=\"{_polyline(points)}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></polyline>"
            )
        legends.append(f"<span><i style=\"background:{color}\"></i>{escape(company)}</span>")
    note = "" if max(len(value) for value in usable.values()) > 1 else "<div class=\"trend-note\">当前只有一个月度点；连续月份入库后，这里会显示需求动能拐点。</div>"
    threshold_line = (
        f"<line x1=\"58\" y1=\"{threshold_y}\" x2=\"530\" y2=\"{threshold_y}\" "
        f"stroke=\"#8c959f\" stroke-dasharray=\"6 6\"></line>"
        f"<text x=\"432\" y=\"{max(14, threshold_y - 7)}\" class=\"threshold-label\">MoM 15% threshold</text>"
    )
    return f"<div class=\"legend\">{''.join(legends)}</div><svg viewBox=\"0 0 560 240\" role=\"img\" aria-label=\"Revenue MoM trend\"><line x1=\"58\" y1=\"204\" x2=\"530\" y2=\"204\" stroke=\"#d8dee4\"></line><line x1=\"58\" y1=\"20\" x2=\"58\" y2=\"204\" stroke=\"#d8dee4\"></line>{threshold_line}{''.join(lines)}</svg>{note}"


def render_dashboard(
    spot_rows: list[dict],
    revenue_rows: list[dict],
    generated_at: str,
    macro_rows: Optional[list[dict]] = None,
) -> str:
    macro_rows = macro_rows or []
    ddr5 = find_spot(spot_rows, "DDR5_16Gb_5600") or find_spot(spot_rows, "DDR5_16Gb_4800")
    ddr5_premium = premium_rate(ddr5)
    adata = next((row for row in revenue_rows if row.get("company_code") == "3260"), None)
    adata_mom = Decimal(str(adata["mom_growth"])) if adata and adata.get("mom_growth") is not None else None
    view_badge, view_title, view_body = market_view(ddr5_premium, adata_mom)
    sufficiency_items = data_sufficiency_items(spot_rows, revenue_rows, macro_rows)

    spot_table = "\n".join(
        "<tr>"
        f"<td>{escape(str(row['product_type']))}</td>"
        f"<td>{fmt_decimal(row.get('spot_avg_price'), 4)}</td>"
        f"<td>{fmt_decimal(row.get('contract_price'), 4)}</td>"
        f"<td>{fmt_decimal(row.get('price_spread'), 4)}</td>"
        f"<td>{escape(str(row.get('crawl_date', '-')))}</td>"
        "</tr>"
        for row in spot_rows
    )
    revenue_table = "\n".join(
        "<tr>"
        f"<td>{escape(str(row['report_month']))}</td>"
        f"<td>{escape(str(row['company_code']))}</td>"
        f"<td>{escape(str(row['company_name']))}</td>"
        f"<td>{fmt_decimal(row.get('current_month_revenue'), 0)}</td>"
        f"<td>{fmt_percent(row.get('mom_growth'))}</td>"
        f"<td>{fmt_percent(row.get('yoy_growth'))}</td>"
        "</tr>"
        for row in revenue_rows
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Supply-Demand Monitor Demo</title>
  <style>
    :root {{
      color-scheme: light;
      --ink: #172026;
      --muted: #66727c;
      --line: #d8dee4;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --green: #087f5b;
      --amber: #9a6700;
      --blue: #1c5d99;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }}
    header {{
      padding: 28px 32px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }}
    h1 {{ margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }}
    .meta {{ color: var(--muted); font-size: 14px; }}
    main {{ padding: 24px 32px 36px; display: grid; gap: 22px; }}
    .kpis {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }}
    .view {{
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(260px, .65fr);
      gap: 16px;
      align-items: stretch;
    }}
    .thesis {{
      background: #102033;
      color: #f7fbff;
      border-radius: 8px;
      padding: 22px;
      min-height: 168px;
    }}
    .badge {{
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: #d3f9d8;
      color: #075f43;
      font-size: 13px;
      font-weight: 700;
    }}
    .thesis h2 {{
      margin: 16px 0 10px;
      padding: 0;
      border: 0;
      color: #ffffff;
      font-size: 26px;
    }}
    .thesis p {{ margin: 0; color: #d8e2eb; line-height: 1.65; }}
    .signals {{
      display: grid;
      gap: 10px;
    }}
    .signal {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-left: 5px solid var(--amber);
      border-radius: 8px;
      padding: 14px;
    }}
    .signal.positive {{
      border-left-color: var(--green);
      background: #e9f8ef;
      color: #075f43;
    }}
    .signal.neutral {{
      border-left-color: #adb5bd;
      background: #f1f3f5;
      color: #495057;
    }}
    .signal.watch {{
      background: #fff9db;
      color: #7c5a00;
    }}
    .signal .name {{ color: var(--muted); font-size: 13px; }}
    .signal .status {{ margin-top: 5px; font-weight: 700; }}
    .checks {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      padding: 16px;
    }}
    .check {{
      border: 1px solid var(--line);
      border-left: 5px solid #c92a2a;
      border-radius: 8px;
      padding: 13px 14px;
      background: #fffafa;
    }}
    .check.ok {{
      border-left-color: var(--green);
      background: #fbfffc;
    }}
    .check-title {{ font-weight: 800; }}
    .check-body {{ margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.5; }}
    .kpi {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }}
    .kpi .label {{ color: var(--muted); font-size: 13px; }}
    .kpi .value {{ margin-top: 8px; font-size: 30px; font-weight: 700; }}
    .positive .value {{ color: var(--green); }}
    .watch .value {{ color: var(--amber); }}
    .neutral .value {{ color: var(--blue); }}
    section {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }}
    .charts {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }}
    .cycle {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }}
    .cycle .chart-body {{ padding: 8px 16px 18px; }}
    .chart {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }}
    .chart-body {{ padding: 14px 16px 18px; }}
    svg {{ width: 100%; height: auto; display: block; }}
    .legend {{ display: flex; flex-wrap: wrap; gap: 10px 16px; padding-bottom: 8px; color: var(--muted); font-size: 13px; }}
    .legend span {{ display: inline-flex; align-items: center; gap: 6px; }}
    .legend i {{ width: 10px; height: 10px; border-radius: 50%; display: inline-block; }}
    .trend-note {{ color: var(--muted); font-size: 13px; padding-top: 4px; }}
    .axis-label {{ font-size: 13px; fill: #4d5963; }}
    .bar-label {{ font-size: 13px; fill: #172026; font-weight: 700; }}
    .threshold-label {{ font-size: 12px; fill: #6a737d; font-weight: 700; }}
    .quadrant-title {{ font-size: 15px; fill: #172026; font-weight: 800; }}
    .clock-axis {{ stroke: #343a40; stroke-width: 1.4; stroke-dasharray: 5 5; }}
    .clock-axis-label {{ font-size: 12px; fill: #59636d; font-weight: 700; }}
    .clock-marker {{ font-size: 13px; fill: #a33a00; font-weight: 800; }}
    .clock-missing {{ font-size: 14px; fill: #59636d; font-weight: 800; }}
    .empty {{ padding: 20px; color: var(--muted); }}
    h2 {{ margin: 0; padding: 16px 18px; font-size: 17px; border-bottom: 1px solid var(--line); }}
    table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
    th, td {{ padding: 11px 14px; border-bottom: 1px solid #edf0f2; text-align: left; }}
    th {{ color: var(--muted); font-weight: 600; background: #fafbfc; }}
    tr:last-child td {{ border-bottom: 0; }}
    @media (max-width: 680px) {{
      header, main {{ padding-left: 16px; padding-right: 16px; }}
      .view {{ grid-template-columns: 1fr; }}
      table {{ display: block; overflow-x: auto; white-space: nowrap; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Memory Supply-Demand Monitor</h1>
    <div class="meta">本地 demo · Generated at {escape(generated_at)}</div>
  </header>
  <main>
    <div class="view">
      <div class="thesis">
        <span class="badge">{escape(view_badge)}</span>
        <h2>Market View</h2>
        <p><strong>{escape(view_title)}</strong>。{escape(view_body)}</p>
      </div>
      <div class="signals">
        <div class="signal {threshold_class(ddr5_premium, Decimal('0.10'))}">
          <div class="name">价格确认</div>
          <div class="status">DDR5 溢价阈值 10% · 当前 {fmt_percent(ddr5_premium)}</div>
        </div>
        <div class="signal {threshold_class(adata_mom, Decimal('0.15'))}">
          <div class="name">需求确认</div>
          <div class="status">威剛 MoM 阈值 15% · 当前 {fmt_percent(adata_mom)}</div>
        </div>
        <div class="signal neutral">
          <div class="name">供给确认</div>
          <div class="status">HBM 分流率未接入 · 暂不触发完整做多预警</div>
        </div>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi {kpi_class(ddr5_premium, Decimal('0.10'))}">
        <div class="label">DDR5 Spot Premium</div>
        <div class="value">{fmt_percent(ddr5_premium)}</div>
      </div>
      <div class="kpi {kpi_class(adata_mom, Decimal('0.15'))}">
        <div class="label">威剛 Revenue MoM</div>
        <div class="value">{fmt_percent(adata_mom)}</div>
      </div>
      <div class="kpi neutral">
        <div class="label">Spot Rows</div>
        <div class="value">{len(spot_rows)}</div>
      </div>
      <div class="kpi neutral">
        <div class="label">Revenue Rows</div>
        <div class="value">{len(revenue_rows)}</div>
      </div>
    </div>
    <section class="cycle">
      <h2>The Cycle Clock</h2>
      <div class="chart-body">{cycle_clock(ddr5_premium, adata_mom)}</div>
    </section>
    <section>
      <h2>Data Sufficiency</h2>
      <div class="checks">{render_sufficiency_panel(sufficiency_items)}</div>
    </section>
    <div class="charts">
      <div class="chart">
        <h2>Spot Price Trend</h2>
        <div class="chart-body">{spot_trend_chart(spot_rows)}</div>
      </div>
      <div class="chart">
        <h2>Revenue MoM Trend</h2>
        <div class="chart-body">{revenue_trend_chart(revenue_rows)}</div>
      </div>
      <div class="chart">
        <h2>Spot-Contract Spread</h2>
        <div class="chart-body">{spread_chart(spot_rows)}</div>
      </div>
      <div class="chart">
        <h2>Revenue MoM Pulse</h2>
        <div class="chart-body">{revenue_mom_chart(revenue_rows)}</div>
      </div>
    </div>
    <section>
      <h2>Spot Prices</h2>
      <table>
        <thead><tr><th>Product</th><th>Spot Avg</th><th>Contract</th><th>Spread</th><th>Crawled</th></tr></thead>
        <tbody>{spot_table}</tbody>
      </table>
    </section>
    <section>
      <h2>Taiwan Supply Chain Revenue</h2>
      <table>
        <thead><tr><th>Month</th><th>Code</th><th>Name</th><th>Revenue</th><th>MoM</th><th>YoY</th></tr></thead>
        <tbody>{revenue_table}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
"""


def fetch_demo_rows(database_url: str) -> tuple[list[dict], list[dict], list[dict]]:
    with connect(database_url) as conn:
        spot_columns = ["product_type", "spot_avg_price", "contract_price", "price_spread", "crawl_date"]
        revenue_columns = [
            "report_month",
            "company_code",
            "company_name",
            "current_month_revenue",
            "mom_growth",
            "yoy_growth",
        ]
        macro_columns = ["record_date", "hbm_wafer_allocation_pct", "hbm_die_penalty", "gpu_lead_time_weeks"]
        spot_rows = conn.execute(
            """
            SELECT product_type, spot_avg_price, contract_price, price_spread, crawl_date
            FROM memory_spot_prices
            ORDER BY crawl_date DESC, id DESC
            LIMIT 20
            """
        ).fetchall()
        revenue_rows = conn.execute(
            """
            SELECT report_month, company_code, company_name, current_month_revenue, mom_growth, yoy_growth
            FROM taiwan_supply_chain_revenue
            ORDER BY report_month DESC, company_code ASC
            LIMIT 20
            """
        ).fetchall()
        macro_rows = conn.execute(
            """
            SELECT record_date, hbm_wafer_allocation_pct, hbm_die_penalty, gpu_lead_time_weeks
            FROM memory_macro_indicators
            ORDER BY record_date DESC, id DESC
            LIMIT 20
            """
        ).fetchall()
    return (
        [dict(zip(spot_columns, row)) for row in spot_rows],
        [dict(zip(revenue_columns, row)) for row in revenue_rows],
        [dict(zip(macro_columns, row)) for row in macro_rows],
    )


def write_demo(output_path: Path = DEFAULT_OUTPUT) -> Path:
    config = MonitorConfig.from_env()
    spot_rows, revenue_rows, macro_rows = fetch_demo_rows(config.require_database_url())
    html = render_dashboard(spot_rows, revenue_rows, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), macro_rows)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    return output_path


def main() -> None:
    path = write_demo()
    print(path)


if __name__ == "__main__":
    main()
