import os, time, json, requests, requests.utils

# ---- 强制不走系统/注册表代理（与 curl 一样直连）----
for v in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]:
    os.environ.pop(v, None)
requests.utils.getproxies = lambda: {}
_orig = requests.Session.__init__
def _init(self, *a, **k):
    _orig(self, *a, **k); self.trust_env = False
requests.Session.__init__ = _init

import akshare as ak

CORE = {
    "sh601088": "中国神华", "sh600900": "长江电力", "sh601398": "工商银行",
    "sh601939": "建设银行", "sh601288": "农业银行", "sh600028": "中国石化",
    "sh601006": "大秦铁路", "sz000895": "双汇发展", "sz000651": "格力电器",
    "sh600941": "中国移动", "sh601225": "陕西煤业", "sh601919": "中远海控",
    "sh600585": "海螺水泥",
}
# 资源/周期类标记（来自 watchpool.json，用于策略决策引擎）
IS_RES = {"sh601088", "sh600028", "sh601225", "sh601919", "sh600585", "sz000651"}
START = "2015-01-01"
END = "2026-08-07"
os.makedirs("hist", exist_ok=True)

def retry(func, *a, attempts=8, **k):
    last = None
    for i in range(attempts):
        try:
            return func(*a, **k)
        except Exception as e:
            last = e
            time.sleep(1.2 * (i + 1))
    print(f"  !! {func.__name__} 失败: {last}")
    return None

def fetch_kline(code):
    num = code[2:]
    df = retry(ak.stock_zh_a_hist, symbol=num, period="daily",
               start_date=START.replace("-", ""), end_date=END.replace("-", ""), adjust="")
    if df is None or df.empty:
        return []
    out = []
    for _, r in df.iterrows():
        out.append({"date": str(r["日期"]), "close": float(r["收盘"])})
    return out

def _dps_from_row(row, cols):
    """从一行里尽量取出 每股分红(元) 和 除权除息日"""
    ex = None
    for c in cols:
        if "除权除息日" in c or "除息日" in c:
            v = row[c]
            if v and str(v) != "nan":
                ex = str(v)[:10]; break
    dps = None
    # 优先 '每股分红'
    for key in ["每股分红", "分红(每股)", "10派(税前)", "分红"]:
        if key in cols:
            v = row[key]
            try:
                x = float(v)
            except Exception:
                x = None
            if x is not None:
                # 10派X元 -> 实际每股 = X/10
                if key == "10派(税前)":
                    x = x / 10.0
                dps = x; break
    return ex, dps

def fetch_divs(code):
    num = code[2:]
    dv = retry(ak.stock_fhps_em, symbol=num)   # 东财分红派息
    if dv is None or (hasattr(dv, "empty") and dv.empty):
        dv = retry(ak.stock_history_dividend, symbol=num)
    if dv is None or (hasattr(dv, "empty") and dv.empty):
        return []
    cols = list(dv.columns)
    out = []
    for _, r in dv.iterrows():
        ex, dps = _dps_from_row(r, cols)
        if ex and dps is not None and dps > 0:
            out.append({"exDate": ex, "dps": round(dps, 4)})
    # 去重 + 排序
    seen = set(); uniq = []
    for d in sorted(out, key=lambda x: x["exDate"]):
        k = (d["exDate"], d["dps"])
        if k in seen: continue
        seen.add(k); uniq.append(d)
    return uniq

def main():
    summary = {}
    for code, name in CORE.items():
        print(f"拉取 {code} {name} ...")
        kline = fetch_kline(code)
        divs = fetch_divs(code)
        rec = {"code": code, "name": name, "isResource": code in IS_RES,
               "kline": kline, "divs": divs}
        with open(f"hist/{code}.json", "w") as f:
            json.dump(rec, f, ensure_ascii=False)
        print(f"  kline={len(kline)} 条, divs={len(divs)} 笔 "
              f"({divs[0]['exDate'] if divs else '-'} ~ {divs[-1]['exDate'] if divs else '-'})")
        summary[code] = {"name": name, "kline": len(kline), "divs": len(divs)}
    with open("hist/_summary.json", "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("全部完成 -> hist/_summary.json")

if __name__ == "__main__":
    main()
