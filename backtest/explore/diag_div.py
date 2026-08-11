import os, json, time, ssl, urllib.request
from datetime import datetime, timedelta
for v in ["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"]:
    os.environ.pop(v, None)
_CTX = ssl.create_default_context(); _CTX.check_hostname=False; _CTX.verify_mode=ssl.CERT_NONE
_OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
START="2015-01-01"; END="2026-08-07"

def curl(url, tries=5):
    last=None
    for i in range(tries):
        try:
            req=urllib.request.Request(url, headers={"User-Agent":UA})
            d=_OP.open(req, timeout=25).read().decode("utf-8","ignore")
            if d.strip(): return d
        except Exception as e: last=e
        time.sleep(0.5*(i+1))
    return None

def fetch_kline(code, adj):
    suf=f",{adj}" if adj else ""
    key="hfqday" if adj=="hfq" else "day"
    rows=[]; seen=set(); end=END
    for _ in range(6):
        url=(f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
             f"?param={code},day,{START},{end},2000{suf},")
        txt=curl(url)
        if not txt: break
        try: node=json.loads(txt)["data"][code]
        except Exception: break
        chunk=node.get(key) or []
        if not chunk: break
        for r in chunk:
            if r[0] not in seen: seen.add(r[0]); rows.append(r)
        first=chunk[0][0]
        if first<=START: break
        end=(datetime.strptime(first,"%Y-%m-%d")-timedelta(days=1)).strftime("%Y-%m-%d")
        time.sleep(0.2)
    rows.sort(key=lambda r:r[0])
    return rows

def analyze(code, name):
    print(f"\n===== {code} {name} =====")
    raw=fetch_kline(code,""); hfq=fetch_kline(code,"hfq")
    raw_map={r[0]:float(r[2]) for r in raw}
    hfq_map={r[0]:float(r[2]) for r in hfq}
    dates=sorted(set(raw_map)&set(hfq_map))
    jumps=[]
    prev_g=None; prev_r=None
    for d in dates:
        r=raw_map[d]; h=hfq_map[d]
        g=(h/r) if (r>0 and h) else None
        if prev_g and g and prev_r>0:
            ratio=g/prev_g
            jumps.append((d, ratio-1.0, prev_r))
        prev_g=g; prev_r=r
    jumps.sort(key=lambda x:x[1])
    n=len(jumps)
    print(f"交易日={len(dates)} 非None跳跃={n}")
    # 分位数
    import statistics
    vals=[j[1] for j in jumps]
    q=lambda p: vals[int(p*(n-1))]
    print(f"min={min(vals):.6f} p50={q(0.5):.6f} p90={q(0.9):.6f} p99={q(0.99):.6f} p999={q(0.999):.6f} max={max(vals):.6f}")
    for thr in [0.0008,0.001,0.003,0.005,0.01,0.02,0.03,0.05]:
        c=sum(1 for v in vals if v>thr)
        print(f"  ratio跳>{thr*100:.2f}% : {c} 次  -> 占{n}的{c/max(n,1)*100:.1f}%")
    # 看几个最大的真实候选
    top=sorted(jumps,key=lambda x:-x[1])[:10]
    print("  最大10个跳跃(日期,跳幅,前收):")
    for d,frac,pr in top:
        D=pr*frac
        print(f"    {d}  +{frac*100:.3f}%  前收={pr:.2f}  D≈{D:.4f}")

for code,name in [("sh601088","中国神华(高价)"),("sh601919","中远海控(低价)"),("sh600941","中国移动(近年上市)")]:
    analyze(code,name)
    time.sleep(0.4)
print("\nDONE")
