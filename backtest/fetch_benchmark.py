"""基准指数抓取：沪深300 / 中证红利 / 标普500(人民币ETF·博时)
复用 fetch_tencent 的 urllib 无代理通道与 derive_divs 分红派生逻辑。
基准以「买入持有 + 分红复投」计算总收益，与策略做公平对比。
注意: 只抓价格 K 线; 估算分红由 apply_benchmark_divs.py 注入(近似全收益)。
"""
import os, json, time
from fetch_tencent import fetch_kline, derive_divs

BENCH = {
    "sh513500": "标普500(人民币ETF·博时·价格)",
    "sh000300": "沪深300(价格)",
    "sh000922": "中证红利(价格)",
}
os.makedirs("hist", exist_ok=True)

def main():
    for code, name in BENCH.items():
        print(f"== {code} {name}", flush=True)
        raw = fetch_kline(code, "")
        hfq = fetch_kline(code, "hfq")
        if not raw:
            print("  !! raw 拉取失败", flush=True); continue
        raw_map = {r[0]: float(r[2]) for r in raw}
        hfq_map = {r[0]: float(r[2]) for r in hfq} if hfq else {}
        kline = [{"date": d, "close": raw_map[d]} for d in sorted(raw_map)]
        divs = derive_divs(raw_map, hfq_map) if hfq else []
        rec = {"code": code, "name": name, "isResource": False,
               "kline": kline, "divs": divs, "bench": True}
        with open(f"hist/bench_{code}.json", "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        print(f"  kline={len(kline)} divs={len(divs)} "
              f"({divs[0]['exDate'] if divs else '-'}..{divs[-1]['exDate'] if divs else '-'})", flush=True)
        time.sleep(0.4)
    print("DONE -> hist/bench_*.json", flush=True)

if __name__ == "__main__":
    main()
