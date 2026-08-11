import os, requests, requests.utils
for v in ["HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy","ALL_PROXY","all_proxy"]:
    os.environ.pop(v, None)
requests.utils.getproxies = lambda: {}
_orig = requests.Session.__init__
def _init(self, *a, **k):
    _orig(self, *a, **k); self.trust_env = False
requests.Session.__init__ = _init

import akshare as ak
print("akshare", ak.__version__)
# list dividend-related functions
names = [n for n in dir(ak) if "divid" in n.lower() or "fhps" in n.lower() or "bonus" in n.lower()]
print("div funcs:", names)

df = ak.stock_zh_a_hist(symbol="601088", period="daily", start_date="20150101", end_date="20150112", adjust="")
print("KLINE OK rows", len(df))
print(df.head(2).to_string())
