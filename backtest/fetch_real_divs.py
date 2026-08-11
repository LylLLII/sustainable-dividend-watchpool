# -*- coding: utf-8 -*-
"""拉取完整股票池的真实历史分红（东财 datacenter RPT_SHAREBONUS_DET）。

背景: 旧口径用 watchpool 当前 expDps 回填历史缺失年份, 造成严重前视偏差
(如中国神华 2016 年真实分红 0.32 元/股, 却被回填成 2.01)。
本脚本用东财权威分红数据替换, 只保留真实除息事件, 不做任何前瞻回填。

口径:
- dps = PRETAX_BONUS_RMB / 10   (10派X元 -> 每股 X/10 元, 含税)
- 与 watchpool divHist 的 dps 口径一致(已验证: 神华 2024年报 2.26 / 2025中报 0.98 / 2025年报 1.03 全部吻合)
- 只取有 EX_DIVIDEND_DATE 且现金分红 > 0 的事件

输出: data/real_divs.json
  {"meta": {"fetched_at","source","note"}, "stocks": {"sh601088": [{"exDate","dps","reportDate"}...]}}
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
OUT = os.path.join(HERE, "data", "real_divs.json")
API = "https://datacenter-web.eastmoney.com/api/data/v1/get"
# 从 watchpool.json 动态读取完整股票池
_wp = json.load(open(os.path.join(HERE, "data", "watchpool.json"), encoding="utf-8"))
CORE = [s["code"] for s in _wp["stocks"]]

# 绕过系统代理 + 不校验证书（国内数据源, 与 fetch_tencent.py 同策略）
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
    print(f"  [WARN] 请求失败(重试{tries}次): {url[:90]}... err={last}", file=sys.stderr)
    return None


def fetch_stock(code6):
    rows = []
    page = 1
    while True:
        params = urllib.parse.urlencode({
            "reportName": "RPT_SHAREBONUS_DET",
            "columns": "ALL",
            "filter": f'(SECURITY_CODE="{code6}")',
            "pageNumber": str(page),
            "pageSize": "100",
            "sortTypes": "1",
            "sortColumns": "EX_DIVIDEND_DATE",
        })
        txt = curl(f"{API}?{params}")
        if txt is None:
            break
        try:
            d = json.loads(txt)
            data = ((d.get("result") or {}).get("data")) or []
            total = ((d.get("result") or {}).get("count")) or len(data)
        except Exception:  # noqa: BLE001
            print(f"  [WARN] {code6} 响应解析失败 page={page}", file=sys.stderr)
            break
        if not data:
            break
        rows.extend(data)
        if len(rows) >= total:
            break
        page += 1
        time.sleep(0.15)

    events = []
    for r in rows:
        ex = (r.get("EX_DIVIDEND_DATE") or "")[:10]
        pre = r.get("PRETAX_BONUS_RMB")
        if not ex or pre is None:
            continue
        dps = float(pre) / 10.0
        if dps <= 0:
            continue
        rep = (r.get("REPORT_DATE") or "")[:7]
        # 预案公告日(当时点可得的分红信息); 缺失时回退除权除息公告日, 再回退除息日(保守)
        plan = (r.get("PLAN_NOTICE_DATE") or "").strip() or (r.get("NOTICE_DATE") or "").strip() or (r.get("EX_DIVIDEND_DATE") or "")
        plan = plan[:10] if plan else ex
        events.append({"exDate": ex, "dps": round(dps, 4), "reportDate": rep,
                       "planDate": plan})
    events.sort(key=lambda e: e["exDate"])
    return events


def main():
    if not os.path.exists(os.path.join(HERE, "data")):
        os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    # 加载已有数据（增量拉取：跳过已有股票）
    force = "--force" in sys.argv
    result = {}
    if not force and os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
            result = old.get("stocks") or {}
            print(f"(增量模式: 已有 {len(result)} 只, --force 可全量重拉)")
        except Exception:
            result = {}
    todo = [c for c in CORE if c not in result]
    print(f"待拉取: {len(todo)}/{len(CORE)} 只")
    print(f"{'代码':<10}{'名称':<8}{'事件数':>5}  {'首条exDate':<12}{'末条exDate':<12}{'2015以来年数':>8}")
    for code in todo:
        code6 = code[2:]
        events = fetch_stock(code6)
        result[code] = events
        if not events:
            print(f"{code:<10}{'-':<8}{0:>5}  拉取失败/无分红记录 !!")
            continue
        years = {e["exDate"][:4] for e in events if e["exDate"] >= "2015-01-01"}
        print(f"{code:<10}{'-':<8}{len(events):>5}  "
              f"{events[0]['exDate']:<12}{events[-1]['exDate']:<12}{len(years):>8}")
        time.sleep(0.15)

    # 与 watchpool divHist 做一致性抽查（仅打印）
    wp_path = os.path.join(HERE, "data", "watchpool.json")
    if os.path.exists(wp_path):
        wp = json.load(open(wp_path, encoding="utf-8"))
        by_code = {s["code"]: s for s in wp.get("stocks", [])}
        print("\n=== 与 watchpool divHist 一致性抽查 (dps) ===")
        for code in CORE:
            events = result.get(code) or []
            s = by_code.get(code)
            if not s:
                continue
            dh = {h["exDate"]: float(h["dps"]) for h in (s.get("divHist") or [])}
            for e in events:
                if e["exDate"] in dh:
                    ok = abs(e["dps"] - dh[e["exDate"]]) < 1e-9
                    print(f"  {code} {e['exDate']} 东财={e['dps']:.4f} "
                          f"watchpool={dh[e['exDate']]:.4f} {'OK' if ok else '<- 不一致!'}")

    meta = {
        "fetched_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "eastmoney RPT_SHAREBONUS_DET",
        "dps_calc": "PRETAX_BONUS_RMB/10 (含税, 每股)",
        "note": "真实除息事件, 无前瞻回填; exDate>=2014-01-01 的事件在 apply 阶段保留以覆盖 2015 年初 TTM 窗口",
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "stocks": result}, f, ensure_ascii=False, indent=1)
    n_fail = sum(1 for c in todo if not result.get(c))
    print(f"\nDONE -> {OUT}  (共 {len(result)}/{len(CORE)} 只, 本次拉取失败/无分红: {n_fail}/{len(todo)})")
    if n_fail:
        print("[WARN] 部分股票拉取失败或无分红记录，请检查上方输出。", file=sys.stderr)


if __name__ == "__main__":
    main()
