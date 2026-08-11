# -*- coding: utf-8 -*-
"""用东财真实历史分红重建回测用的每股分红流（修复前视偏差）。

背景: 旧版本用 watchpool 当前 expDps 回填 divHist 未覆盖的历史年份
（如中国神华 2015–2024 全部被回填成 2.01 元/股, 而真实 2016 年只有 0.32 元/股），
等于用今天的信息重写过去的股息率信号和分红复投 → 系统性抬高回测收益。

本版本:
- 分红完全来自东财真实除息事件（data/real_divs.json, fetch_real_divs.py 拉取）;
- 不做任何前瞻回填; 当年尚未宣布的分红, 当年就没有对应事件（这正是"当时可知"口径）;
- 分红源缺失/为空时明确报错退出, 绝不静默用旧数据。

口径: dps = 含税每股分红（PRETAX_BONUS_RMB/10）, 与策略 expDps/price 的"预期股息率"
在量级上可比; 回测信号的 ttmDPS = 最近12个月真实含税分红合计。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
HIST = "hist"
# 从 watchpool.json 动态读取完整股票池
_wp = json.load(open(os.path.join(HERE, "data", "watchpool.json"), encoding="utf-8"))
CORE = [s["code"] for s in _wp["stocks"]]
REAL_DIVS = os.path.join(HERE, "data", "real_divs.json")
# 覆盖回测起始(2015-01-05)的 TTM 窗口(向前365天)所需的最早 exDate
EARLIEST_EX = "2014-01-01"


def pdate(s):
    return datetime.strptime(s, "%Y-%m-%d")


def main():
    if not os.path.exists(REAL_DIVS):
        sys.exit(
            f"[apply_watchpool_divs] 找不到真实分红源: {REAL_DIVS}\n"
            f"  请先运行: python fetch_real_divs.py"
        )
    real = json.load(open(REAL_DIVS, encoding="utf-8"))
    stocks = real.get("stocks") or {}

    print(f"{'代码':<10}{'名称':<8}{'事件数':>5}  {'首条':<11}{'末条':<11}{'期末TTM(至26-08-07)':>16}")
    n_fail = 0
    for code in CORE:
        path = os.path.join(HIST, f"{code}.json")
        if not os.path.exists(path):
            print("跳过(无行情文件):", code)
            continue
        rec = json.load(open(path, encoding="utf-8"))
        events = [e for e in (stocks.get(code) or []) if e["exDate"] >= EARLIEST_EX]
        if not events:
            print(f"{code} {rec['name']:<6} 真实分红为空!! 请检查 data/real_divs.json")
            n_fail += 1
            continue
        divs = [{"exDate": e["exDate"], "dps": float(e["dps"])} for e in events]
        rec["divs"] = divs
        rec["divSource"] = "eastmoney-real(PRETAX/10 含税, 无前瞻回填)"
        json.dump(rec, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        # 动态计算 TTM 窗口（最近12个月）
        today = datetime.now().strftime("%Y-%m-%d")
        year_ago = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        ttm = sum(d["dps"] for d in divs if year_ago < d["exDate"] <= today)
        print(f"{code:<10}{rec['name']:<8}{len(divs):>5}  "
              f"{divs[0]['exDate']:<11}{divs[-1]['exDate']:<11}{ttm:>16.4f}")
    if n_fail:
        print(f"[WARN] {n_fail} 只股票真实分红为空, 请检查 data/real_divs.json (已处理的部分仍写入)")
    print(f"DONE -> 已用东财真实分红重写 {len(CORE) - n_fail}/{len(CORE)} 只股票的 hist/*.json divs（无 expDps 回填）")


if __name__ == "__main__":
    main()
