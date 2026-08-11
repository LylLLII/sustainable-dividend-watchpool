"""把 hist/*.json (完整股票池 + 3 基准) 合并成单个 backtest_bundle.json 供网页工具加载。

本轮口径更新：
- 分红源 = 东财真实历史除息事件（无 expDps 前瞻回填）；
- 3 个基准统一「价格 + 估算分红复投」近似全收益口径（原 sh000985 实为中证全指价格指数，
  已用真实沪深300 sh000300 替换）；
- 成本模型默认值（中性档）写入 meta，工具页可调；
- 幸存者偏差声明写入 meta.note。
- --start/--end 可自定义起止日期，默认 end=今天。
"""
import json, re, os, glob, argparse
from datetime import date, datetime, timedelta

HIST = "hist"
STOCK_RE = re.compile(r"^(sh|sz)\d{6}\.json$")
BENCH_ALLOW = {"sh513500", "sh000300", "sh000922"}
# 基准类型说明（供网页标注）：全部为「价格 + 估算分红复投」的近似全收益口径。
BENCH_TYPE = {
    "sh000300": "近似全收益(沪深300价格+估算分红2.5%/年)",
    "sh000922": "近似全收益(中证红利价格+估算分红4.5%/年)",
    "sh513500": "近似全收益(标普500ETF价格+估算分红1.8%/年)",
}

def slim(d):
    return {
        "code": d["code"], "name": d.get("name"), "isResource": bool(d.get("isResource")),
        "kline": [[r["date"], round(float(r["close"]), 3)] for r in d.get("kline", [])],
        "divs": [[r["exDate"], round(float(r["dps"]), 4)] for r in d.get("divs", [])],
    }

def bridge_gaps(kline, max_gap=30):
    """基准源数据常有断档（如上游缺失，沪深300全收益 2016-06~2017-03 缺 282 天）。
    对 >max_gap 天的缺口按两端做线性插值补齐，避免 runBenchmark 前向填充把价格拉平、
    扭曲基准收益对比。仅在基准数据上做，策略股不做（缺口为真实停牌）。"""
    if len(kline) < 2:
        return kline
    out = []
    for i in range(1, len(kline)):
        a, b = kline[i - 1], kline[i]
        out.append(a)
        da, db = date.fromisoformat(a[0]), date.fromisoformat(b[0])
        gap = (db - da).days
        if gap > max_gap:
            for k in range(1, gap):
                dk = (da + timedelta(days=k)).isoformat()
                v = round(a[1] + (b[1] - a[1]) * (k / gap), 3)
                out.append([dk, v])
    out.append(kline[-1])
    return out

def main():
    ap = argparse.ArgumentParser(description="生成 backtest_bundle.json")
    ap.add_argument("--start", default="2015-01-01", help="起始日期 (默认: 2015-01-01)")
    ap.add_argument("--end", default=datetime.now().strftime("%Y-%m-%d"), help="结束日期 (默认: 今天)")
    args = ap.parse_args()

    stocks, benches = [], []
    for f in sorted(glob.glob(os.path.join(HIST, "*.json"))):
        base = os.path.basename(f)
        d = json.load(open(f, encoding="utf-8"))
        if STOCK_RE.match(base):
            stocks.append(slim(d))
        elif base.startswith("bench_") and base[6:-5] in BENCH_ALLOW:
            code = base[6:-5]
            rec = slim(d); rec["name"] = d.get("name", code)
            rec["kline"] = bridge_gaps(rec["kline"])   # M1: 补齐基准断档
            rec["type"] = BENCH_TYPE.get(code, "")
            benches.append(rec)

    bundle = {
        "meta": {
            "start": args.start, "end": args.end,
            "strategyYield": "realized-TTM(最近12个月真实已实现分红/价) —— 注意: 与原始 watchpool 策略的"
                             "「预期股息率(expDps/价)」不同, 后者有前瞻偏差; 本回测刻意用 realized-TTM 替代, "
                             "严格说是派生策略, 结论不可等同原始预期口径",
            "dividendSource": "eastmoney RPT_SHAREBONUS_DET 真实除息事件(含税 PRETAX/10), 无 expDps 前瞻回填",
            "costModel": {"commissionRate": 0.00025, "minCommission": 5.0, "stampRate": 0.001,
                          "stampRateNew": 0.0005, "stampCutoff": "2023-08-28", "slippage": 0.001,
                          "lotSize": 100, "execDelay": 1, "divDelay": 1},
            "note": ("【当前股票池回溯测试】固定 watchpool.json 时点的股票池，未含历史被剔除/退市股票，"
                     "收益系统性偏乐观，不可外推为实现收益。分红为东财真实历史除息事件；"
                     "3 个基准统一为价格+估算分红复投的近似全收益口径(真实全收益指数 H00300/H00922 不可得)，"
                     "基准与策略使用同一套交易成本(建仓佣金+滑点、分红复投费用)；"
                     "基准断档(>30天)已线性插值补齐(人工路径)。成本默认中性档：佣金万2.5(最低5元)/"
                     "印花税卖出0.1%→0.05%(2023-08-28)/滑点0.1%单边/买入整手100股/调仓与分红复投均延迟1日。"),
        },
        "stocks": stocks,
        "benchmarks": benches,
    }
    with open("backtest_bundle.json", "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False)
    print(f"stocks={len(stocks)} benchmarks={len(benches)} -> backtest_bundle.json "
          f"({os.path.getsize('backtest_bundle.json')/1024:.0f} KB)")

if __name__ == "__main__":
    main()
