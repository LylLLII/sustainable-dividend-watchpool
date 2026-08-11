# -*- coding: utf-8 -*-
"""拉取完整股票池历史主要财务指标（东财 datacenter RPT_F10_FINANCE_MAINFINADATA）。

用途: v2 实验的「质量过滤」——ROE/毛利率/每股经营现金流/资产负债率/EPS,
含 NOTICE_DATE(公告日) 实现 point-in-time 无前视。

口径:
- ROEJQ   加权净资产收益率(%)
- XSMLL   销售毛利率(%)
- MGJYXJJE 每股经营现金流(元)
- ZCFZL   资产负债率(%)
- EPSJB   基本每股收益(元)
- 只保留年度(12-31)与中期(06-30)报告期(季报季节性噪声大, 质量判断用年报+中报)

输出: data/financials.json
  {"meta": {"fetched_at","source"}, "stocks": {code: [{reportDate,noticeDate,roe,grossMargin,ocps,debtRatio,eps}]}}
"""
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "financials.json")
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
_wp = json.load(open(os.path.join(HERE, "data", "watchpool.json"), encoding="utf-8"))
CORE = [s["code"] for s in _wp["stocks"]]

for v in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(v, None)
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE
_OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "Chrome/124.0 Safari/537.36")


def curl(url, tries=5):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            d = _OP.open(req, timeout=25).read().decode("utf-8", "ignore")
            if d.strip():
                return d
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(0.6 * (i + 1))
    print(f"  [WARN] 请求失败: {url[:90]}... err={last}", file=sys.stderr)
    return None


def fetch_stock(code):
    code6 = code[2:]  # 剥离 sh/sz 前缀
    secu = f"{code6}.SH" if code6.startswith(("6", "9")) else f"{code6}.SZ"
    params = urllib.parse.urlencode({
        "reportName": "RPT_F10_FINANCE_MAINFINADATA",
        "columns": "ALL",
        "filter": f'(SECUCODE="{secu}")',
        "pageNumber": "1", "pageSize": "80",
        "sortTypes": "-1", "sortColumns": "REPORT_DATE",
    })
    txt = curl(f"{API}?{params}")
    if txt is None:
        return []
    try:
        d = json.loads(txt)
        rows = ((d.get("result") or {}).get("data")) or []
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in rows:
        rd = (r.get("REPORT_DATE") or "")[:10]
        if not rd or rd[5:7] not in ("12", "06"):   # 只留年报+中报
            continue
        nd = (r.get("NOTICE_DATE") or "")[:10]
        out.append({
            "reportDate": rd,
            "noticeDate": nd or rd,
            "roe": r.get("ROEJQ"),
            "grossMargin": r.get("XSMLL"),
            "ocps": r.get("MGJYXJJE"),
            "debtRatio": r.get("ZCFZL"),
            "eps": r.get("EPSJB"),
        })
    out.sort(key=lambda e: e["reportDate"])
    return out


def main():
    if not os.path.exists(os.path.join(HERE, "data")):
        os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    result = {}
    print(f"{'代码':<10}{'报告期数':>6}  {'最早':<11}{'最晚':<11}")
    for code in CORE:
        rows = fetch_stock(code)
        result[code] = rows
        if rows:
            print(f"{code:<10}{len(rows):>6}  {rows[0]['reportDate']:<11}{rows[-1]['reportDate']:<11}")
        else:
            print(f"{code:<10}{0:>6}  拉取失败!")
        time.sleep(0.15)
    meta = {
        "fetched_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "eastmoney datacenter RPT_F10_FINANCE_MAINFINADATA",
        "fields": "roe=ROEJQ, grossMargin=XSMLL, ocps=MGJYXJJE(每股经营现金流), "
                  "debtRatio=ZCFZL, eps=EPSJB; 仅年报(12-31)+中报(06-30)",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "stocks": result}, f, ensure_ascii=False, indent=1)
    n_fail = sum(1 for c in CORE if not result.get(c))
    print(f"\nDONE -> {OUT}  (拉取失败: {n_fail}/{len(CORE)})")
    if n_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
