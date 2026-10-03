#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
可转债双低监控 · 数据更新脚本
体系来源：MR Dang《地阶功法卷十九》可转债实操指南
  双低值 = 转债价格 + 转股溢价率(%) × 100
  全市场双低均值 < 200 开始建仓，< 180 逐步加仓（均值高企=便宜券消失，耐心等待）
  黄金区：价格 < 120 且 溢价率 < 20%（放宽线：价格 < 125 且溢价 < 30%）
  排雷前置：评级 ≥ AA、剔除正股 ST，放在双低值之前

数据源：东方财富债券列表（转股价/评级/到期日）+ 腾讯行情（转债价/正股价）
用法：python tools/update_cb.py   → 生成 data/cb_monitor.json，git push 后页面即更新
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "cb_monitor.json")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def http_get(url, timeout=20, retries=3, decode="utf-8"):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode(decode, errors="ignore")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"请求失败 {url[:80]}: {last}")


def market_prefix(code):
    """转债：11x=沪 12x=深；正股：6 开头=沪，其余=深"""
    if code.startswith("11"):
        return "sh" + code
    if code.startswith("12"):
        return "sz" + code
    return ("sh" if code.startswith("6") else "sz") + code


def fetch_bond_list():
    """东财在市转债列表：转股价/评级/到期日/规模"""
    url = (
        "https://datacenter-web.eastmoney.com/api/data/v1/get"
        "?reportName=RPT_BOND_CB_LIST"
        "&columns=SECURITY_CODE,SECURITY_NAME_ABBR,CONVERT_STOCK_CODE,SECURITY_SHORT_NAME,"
        "TRANSFER_VALUE,RATING,ACTUAL_ISSUE_SCALE,EXPIRE_DATE,DELIST_DATE"
        "&pageSize=500&pageNumber=1&sortColumns=SECURITY_CODE&sortTypes=1"
        '&filter=(EXPIRE_DATE%3E%27{today}%27)'
    ).format(today=datetime.now().strftime("%Y-%m-%d"))
    d = json.loads(http_get(url))
    out = []
    for x in d["result"]["data"]:
        if x.get("DELIST_DATE") or not x.get("TRANSFER_VALUE"):
            continue
        out.append(x)
    return out


def fetch_prices(codes):
    """腾讯行情批量拉最新价，返回 {6位代码: 价格}"""
    pref = sorted({market_prefix(c) for c in codes})
    prices = {}
    for i in range(0, len(pref), 50):
        batch = pref[i : i + 50]
        t = http_get("https://qt.gtimg.cn/q=" + ",".join(batch), decode="gbk")
        for line in t.split(";"):
            if "~" not in line:
                continue
            parts = line.split("~")
            if len(parts) > 3:
                try:
                    prices[parts[2].strip()] = float(parts[3])
                except ValueError:
                    pass
        time.sleep(0.4)
    return prices


def is_disqualified(rating, stock_name):
    """评级 <AA 或 正股ST → 一票否决（先排雷，再排序）"""
    base = (rating or "").replace("sti", "")
    if "sti" in (rating or ""):
        return True
    if "ST" in (stock_name or "").upper():
        return True
    return base not in ("AAA", "AAA+", "AA+")


def main():
    print("[1/3] 拉取在市转债列表（东财）...")
    bonds = fetch_bond_list()
    print(f"      在市转债 {len(bonds)} 只")
    print("[2/3] 拉取行情（腾讯）...")
    all_codes = set()
    for b in bonds:
        all_codes.add(b["SECURITY_CODE"])
        all_codes.add(b["CONVERT_STOCK_CODE"])
    prices = fetch_prices(all_codes)
    print(f"      行情取到 {len(prices)}/{len(all_codes)}")

    print("[3/3] 计算双低值与筛选...")
    records, dual_lows = [], []
    for b in bonds:
        code = b["SECURITY_CODE"]
        bp = prices.get(code)            # 转债价
        sp = prices.get(b["CONVERT_STOCK_CODE"])  # 正股价
        tp = b.get("TRANSFER_VALUE")     # 转股价
        if not bp or not sp or not tp or tp <= 0:
            continue
        cv = 100.0 * sp / tp             # 转股价值
        prem = (bp / cv - 1) * 100       # 转股溢价率%
        dual = bp + prem                 # 双低值
        dual_lows.append(dual)
        records.append(
            {
                "code": code,
                "name": b["SECURITY_NAME_ABBR"],
                "bond_price": round(bp, 3),
                "prem": round(prem, 2),
                "cv": round(cv, 2),
                "dual_low": round(dual, 2),
                "rating": b.get("RATING") or "-",
                "scale": b.get("ACTUAL_ISSUE_SCALE"),
                "expire": (b.get("EXPIRE_DATE") or "")[:10],
                "stock_code": b["CONVERT_STOCK_CODE"],
                "stock_name": b["SECURITY_SHORT_NAME"],
                "stock_price": sp,
                "transfer_price": tp,
            }
        )

    dual_lows.sort()
    n = len(dual_lows)
    avg = sum(dual_lows) / n if n else 0
    median = dual_lows[n // 2] if n else 0
    trimmed = dual_lows[: int(n * 0.9)] if n >= 20 else dual_lows  # 剔除双高尾部10%
    trimmed_avg = sum(trimmed) / len(trimmed) if trimmed else 0

    if avg < 180:
        sig, sig_text = "add", "加仓区 · 便宜券遍地，逐步加仓"
    elif avg < 200:
        sig, sig_text = "build", "建仓区 · 开始建仓"
    elif avg < 220:
        sig, sig_text = "wait", "偏贵区间 · 耐心等待，严格标准，不追高"
    else:
        sig, sig_text = "hot", "高热 · 便宜券消失，多留现金"

    ok = [r for r in records if not is_disqualified(r["rating"], r["stock_name"])]
    golden = sorted(
        (r for r in ok if r["bond_price"] < 120 and r["prem"] < 20),
        key=lambda r: r["dual_low"],
    )
    relaxed = sorted(
        (r for r in ok if 120 <= r["bond_price"] < 125 and 20 <= r["prem"] < 30),
        key=lambda r: r["dual_low"],
    )
    top = sorted(ok, key=lambda r: r["dual_low"])[:30]

    out = {
        "meta": {
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "total_bonds": len(records),
            "avg_dual_low": round(avg, 2),
            "median_dual_low": round(median, 2),
            "trimmed_avg_dual_low": round(trimmed_avg, 2),
            "signal": sig,
            "signal_text": sig_text,
            "golden_strict_count": len(golden),
            "golden_relaxed_extra": len(relaxed),
            "rule": "双低值=转债价+溢价率%×100；均值<200建仓，<180加仓；黄金区=价格<120且溢价<20%（放宽125/30）；评级≥AA、剔ST前置",
            "source": "东财债券列表 + 腾讯行情；体系：MR Dang《地阶功法卷十九》",
        },
        "golden": golden,
        "relaxed": relaxed,
        "top_dual_low": top,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(
        f"[OK] {OUT}\n"
        f"     在市 {len(records)} | 双低均值 {avg:.1f}（截尾 {trimmed_avg:.1f} / 中位 {median:.1f}）"
        f" | 信号 {sig_text}\n"
        f"     黄金区（严格 {len(golden)} + 放宽新增 {len(relaxed)}）"
    )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        sys.exit(1)
