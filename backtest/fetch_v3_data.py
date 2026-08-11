# -*- coding: utf-8 -*-
"""拉取 v3 候选池(中证红利 99 只成分)数据: K线(腾讯) + 真实分红(东财) + 财务(东财)。
输出 v3data/kline.json / v3data/divs.json / v3data/fin.json (精简, 供 experiment_v3.mjs)。
复用 fetch_tencent.fetch_kline / fetch_real_divs.fetch_stock / fetch_financials.fetch_stock。
"""
import json
import os
import time

import fetch_tencent
import fetch_real_divs
import fetch_financials

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "v3data")
os.makedirs(OUT, exist_ok=True)

COMP = json.load(open(os.path.join(HERE, "data", "csi_dividend_components.json"), encoding="utf-8"))
CODES = [c["code"] for c in COMP["components"]]
NAMES = {c["code"]: c["name"] for c in COMP["components"]}
INCLUDE = {c["code"]: c["includeDate"] for c in COMP["components"]}


def main():
    kline = {}
    divs = {}
    fin = {}
    n_ok = {"kline": 0, "divs": 0, "fin": 0}
    print(f"候选池 {len(CODES)} 只, 开始拉取...")
    for i, code in enumerate(CODES):
        code6 = code[2:]
        # K 线(腾讯)
        raw = fetch_tencent.fetch_kline(code, "")
        if raw:
            kline[code] = [[r[0], float(r[2])] for r in raw]
            n_ok["kline"] += 1
        else:
            print(f"  [WARN] {code} K线失败")
        time.sleep(0.1)
        # 分红(东财)
        evs = fetch_real_divs.fetch_stock(code6)
        if evs:
            divs[code] = evs
            n_ok["divs"] += 1
        # 财务(东财)
        fs = fetch_financials.fetch_stock(code)
        if fs:
            fin[code] = fs
            n_ok["fin"] += 1
        if (i + 1) % 20 == 0:
            print(f"  ... {i + 1}/{len(CODES)} 完成 (kline={n_ok['kline']} divs={n_ok['divs']} fin={n_ok['fin']})")
        time.sleep(0.1)

    meta = {"source": "tencent kline + eastmoney RPT_SHAREBONUS_DET + RPT_F10_FINANCE_MAINFINADATA",
            "pool": "中证红利000922成分(2026-08-08, 99只)", "count": len(CODES)}
    json.dump({"meta": meta, "codes": CODES, "names": NAMES, "include": INCLUDE, "kline": kline},
              open(os.path.join(OUT, "kline.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"meta": meta, "divs": divs},
              open(os.path.join(OUT, "divs.json"), "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"meta": meta, "fin": fin},
              open(os.path.join(OUT, "fin.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"\nDONE -> v3data/ (kline={n_ok['kline']}/{len(CODES)}, divs={n_ok['divs']}, fin={n_ok['fin']})")


if __name__ == "__main__":
    main()
