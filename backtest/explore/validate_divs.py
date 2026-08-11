"""校验：用派生分红计算的「近12个月实际DPS(ttm)」对比 watchpool 的 2026 预期每股分红(expDps)。
若两者量级一致，说明 derive_divs 的分红派生可信。"""
import json, os
from datetime import datetime, timedelta

WP = r"C:\Users\57328\WorkBuddy\2026-08-06-21-53-40\sustainable-dividend-watchpool\data\watchpool.json"
HIST = "hist"
END = datetime(2026, 8, 7).date()

def pdate(s):
    return datetime.strptime(s, "%Y-%m-%d").date()

# 读 watchpool expDps
wp = json.load(open(WP))
stocks = wp.get("stocks") or []
exp = {s["code"]: float(s.get("expDps") or 0) for s in stocks}

print(f"{'代码':<10}{'名称':<8}{'派生ttmDPS':>12}{'watchpool预期':>14}{'偏差%':>9}")
print("-" * 56)
for fn in sorted(os.listdir(HIST)):
    if not (fn.startswith("sh") or fn.startswith("sz")) or not fn.endswith(".json"):
        continue
    rec = json.load(open(os.path.join(HIST, fn)))
    code = rec["code"]
    if code not in exp:
        continue
    divs = [(pdate(d["exDate"]), float(d["dps"])) for d in rec["divs"]]
    lo = END - timedelta(days=365)
    ttm = sum(dps for ex, dps in divs if lo < ex <= END)
    e = exp[code]
    if e > 0:
        bias = (ttm - e) / e * 100
        flag = "" if abs(bias) < 60 else "  <-- 偏差较大"
        print(f"{code:<10}{rec['name']:<8}{ttm:>12.3f}{e:>14.3f}{bias:>8.1f}%{flag}")
