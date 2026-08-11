import os, json, time, ssl, urllib.request
for v in ["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"]:
    os.environ.pop(v, None)
_CTX=ssl.create_default_context(); _CTX.check_hostname=False; _CTX.verify_mode=ssl.CERT_NONE
_OP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
def curl(url):
    try:
        req=urllib.request.Request(url, headers={"User-Agent":UA})
        return _OP.open(req, timeout=25).read().decode("utf-8","ignore")
    except Exception as e:
        return f"ERR:{e}"
for code in ["usSPX","usINX","usDJI","sh000300","sh000922","sh000905"]:
    url=(f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
         f"?param={code},day,2024-01-01,2024-12-31,10,")
    t=curl(url)
    try:
        j=json.loads(t)
        node=j.get("data",{}).get(code)
        if node:
            k=node.get("day") or node.get("qfqday") or []
            print(f"{code}: OK  rows={len(k)}  last={k[-1][:2] if k else None}  name={node.get('name')}")
        else:
            print(f"{code}: no node  raw={t[:120]}")
    except Exception as e:
        print(f"{code}: parse err {e}  raw={t[:120]}")
    time.sleep(0.3)
