# -*- coding: utf-8 -*-
"""[P1 修复] 给「价格口径」基准补充分红，使其变成近似全收益，与含分红复投的策略可比。

背景：原 3 个基准中，中证红利(价格) sh000922 与 标普500 ETF(价格) sh513500 是价格口径
（divs=0，不含分红），却与「含分红复投」的策略直接对比，系统性低估了基准、放大了策略优势。
原 sh000985 被标注为"沪深300全收益"，但经核实其数据实为**中证全指(价格指数)**（腾讯 sh000985
报价即中证全指），同样不含分红 —— 故本轮用真实沪深300价格指数 sh000300 替换，并统一按
「价格 + 估算分红复投」处理。

做法：对每个价格基准，按「每年一个除息日、dps = 当日收盘价 × 年化股息率」注入分红事件。
双引擎（dividend_backtest.simulate_hold / backtest_engine.simulateHold）本就会对已注入的
divs 做 DRIP（分红复投），因此基准净值自动变为「价格 + 估算分红复投」的近似全收益。

年化股息率为公开历史区间的近似假设（已写入 generate_bundle.py 的 BENCH_TYPE 标注）：
  - 中证红利：约 4.5%/年
  - 沪深300：约 2.5%/年
  - 标普500 ETF：约 1.8%/年
真实全收益指数（H00922 中证红利全收益 / H00300 沪深300全收益）经探测腾讯/东财均不可得，
故维持估算口径并明确标注；这些是近似值，让对比口径统一可比，非精确复盘。
"""
import json
import os

HIST = "hist"
# 价格口径基准 -> 年化股息率（近似假设，用于合成分红复投使基准可比）
BENCH_YIELD = {
    "sh000922": 0.045,   # 中证红利 价格 -> 近似全收益
    "sh000300": 0.025,   # 沪深300 价格 -> 近似全收益
    "sh513500": 0.018,   # 标普500 ETF 价格 -> 近似全收益
}

def pdate(s):
    return __import__("datetime").date.fromisoformat(s)

def main():
    for code, yld in BENCH_YIELD.items():
        path = os.path.join(HIST, f"bench_{code}.json")
        if not os.path.exists(path):
            print("跳过(无基准文件):", code); continue
        rec = json.load(open(path, encoding="utf-8"))
        kline = rec.get("kline", [])
        if not kline:
            print("跳过(无kline):", code); continue
        closes = {r["date"]: float(r["close"]) for r in kline}
        years = sorted({pdate(d).year for d in closes})
        synth = []
        for Y in years:
            # 取该年 7 月首个交易日作为除息日锚点（规避年初/年末边界）
            cand = [d for d in closes if pdate(d).year == Y and pdate(d).month >= 7]
            ex = cand[0] if cand else f"{Y}-12-31"
            px = closes[ex]
            synth.append([ex, round(px * yld, 4)])
        synth.sort()
        rec["divs"] = [{"exDate": ex, "dps": dps} for ex, dps in synth]
        rec["divSource"] = f"synthetic(price+{yld*100:.1f}%/yr DRIP, 近似全收益)"
        json.dump(rec, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"{code} {rec.get('name',''):<12} 注入 {len(synth):>3} 笔估算分红 (yield={yld*100:.1f}%/年) -> 近似全收益")
    print("DONE -> 价格基准已补估算分红，双引擎将自动 DRIP 成近似全收益")

if __name__ == "__main__":
    main()
