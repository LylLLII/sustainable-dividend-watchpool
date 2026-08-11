import os, json, time, ssl, urllib.request
for v in ["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"]:
    os.environ.pop(v, None)
_CTX=ssl.create_default_context(); _CTX.check_hostname=False; _CTX.verify_mode=ssl.CERT_NONE
_OP=urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
def curl(url):
    try:
        req=urllib.request.Request(url, headers={"User-Agent":UA,"Referer":"https://quote.eastmoney.com/"})
        return _OP.open(req, timeout=25).read().decode("utf-8","ignore")
    except Exception as e:
        return f"ERR:{e}"
for secid in ["100.IVX","100.SPX","100.DJIA","100.NDX","101.IVX"]:
    url=(f"https://push2his.eastmoney.com/api/qt/stock/kline/get"
         f"?secid={secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56"
         f"&klt=101&fqt=0&beg=20240101&end=20241231")
    t=curl(url)
    try:
        j=json.loads(t)
        d=j.get("data")
        if d and d.get("klines"):
            print(f"{secid}: OK  name={d.get('name')}  rows={len(d['klines'])}  last={d['klines'][-1][:40]}")
        else:
            print(f"{secid}: no klines  rc={j.get('rc')}  raw={t[:100]}")
    except Exception as e:
        print(f"{secid}: err {e}  raw={t[:100]}")
    time.sleep(0.3)
