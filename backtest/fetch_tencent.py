import os, json, time, sys, ssl, urllib.request, argparse
from datetime import datetime, timedelta

for v in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]:
    os.environ.pop(v, None)
_CTX = ssl.create_default_context(); _CTX.check_hostname = False; _CTX.verify_mode = ssl.CERT_NONE
_OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
# 从 watchpool.json 动态读取完整股票池（名称 + isResource）
_wp = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "watchpool.json"), encoding="utf-8"))
CORE = {s["code"]: s["name"] for s in _wp["stocks"]}
IS_RES = {s["code"] for s in _wp["stocks"] if s.get("isResource")}
DEFAULT_START = "2015-01-01"
DEFAULT_END = datetime.now().strftime("%Y-%m-%d")  # 默认取今天
START, END = DEFAULT_START, DEFAULT_END  # 可被 main() 的 argparse 覆写
os.makedirs("hist", exist_ok=True)

def curl(url, tries=5):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            data = _OP.open(req, timeout=25).read().decode("utf-8", "ignore")
            if data.strip():
                return data
        except Exception as e:
            last = e
        time.sleep(1.0 * (i + 1))
    if last:
        print("  curl err:", repr(last), flush=True)
    return None

def fetch_kline(code, adj):
    # adj: '' (raw) or 'hfq'；腾讯单笔 limit 上限 2000，按 END 向前翻页覆盖到 START
    suf = f",{adj}" if adj else ""
    key = "hfqday" if adj == "hfq" else "day"
    rows = []
    seen = set()
    end = END
    for _ in range(6):
        url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
               f"?param={code},day,{START},{end},2000{suf},")
        txt = curl(url)
        if not txt:
            break
        try:
            node = json.loads(txt)["data"][code]
        except Exception:
            break
        chunk = node.get(key) or []
        if not chunk:
            break
        for r in chunk:
            if r[0] not in seen:
                seen.add(r[0]); rows.append(r)
        first = chunk[0][0]
        if first <= START:
            break
        # 再往前翻一页
        end = (datetime.strptime(first, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        time.sleep(0.3)
    rows.sort(key=lambda r: r[0])
    return rows if rows else None

def parse(d):
    return datetime.strptime(d, "%Y-%m-%d").date()

def derive_divs(raw_map, hfq_map):
    """从 不复权/后复权 收盘价之比 g=hfq/raw 派生每股分红。

    g 是阶梯函数：正常日恒为常量，仅在除息日因 raw 跳跌而永久抬升。
    难点：(1) 真实除息常被腾讯拆成多个相邻小台阶（单日跳幅<2%）；(2) 日常取整噪声
    也会产生小跳。判别方法：
      - 先以较低日跳幅(0.3%)捕捉可能被拆碎的真实台阶；
      - 再用「未来20日 g 累计抬升≥2%」确认：真实台阶会累积，噪声会回落归零；
      - 最后把 45 天内的候选聚为一笔，用累计 g 比值还原总额（避免碎片化多计/少计）。
    """
    from collections import defaultdict
    dates = sorted(set(raw_map) & set(hfq_map))
    g = {}
    for d in dates:
        r = raw_map[d]; h = hfq_map[d]
        g[d] = (h / r) if (r > 0 and h) else None
    n = len(dates)
    cand = []
    for i in range(1, n):
        gp = g.get(dates[i - 1]); gc = g.get(dates[i])
        if not (gp and gc and gp > 0):
            continue
        if gc / gp - 1.0 < 0.003:            # 低日跳幅门槛：捕捉被拆碎的台阶
            continue
        j = min(i + 20, n - 1)               # 累计确认：未来20日 g 是否永久抬升
        gj = g.get(dates[j])
        if not (gj and gp):
            continue
        if gj / gp - 1.0 < 0.02:             # 累计<2% -> 噪声回落，剔除
            continue
        cand.append(i)
    # 聚类：45 天内相邻候选合并为一笔，用累计 g 比值还原真实分红总额
    clusters = []
    for i in cand:
        if clusters and (parse(dates[i]) - parse(dates[clusters[-1][-1]])).days < 45:
            clusters[-1].append(i)
        else:
            clusters.append([i])
    by_year = defaultdict(list)
    for cl in clusters:
        i0, i1 = cl[0], cl[-1]
        k = min(i1 + 20, n - 1)
        gp = g.get(dates[i0 - 1]); gk = g.get(dates[k])
        prev_raw = raw_map[dates[i0 - 1]]
        if gp and gk and gk > gp:
            D = prev_raw * (1 - gp / gk)
        else:
            D = 0.0
        if not (0.01 <= D <= 0.4 * prev_raw):
            continue
        by_year[parse(dates[i1]).year].append((dates[i1], D))
    out = []
    for y, evs in by_year.items():
        evs.sort(key=lambda x: -x[1])
        for d, D in evs[:3]:                  # 每年最多 3 笔（年+中+特别）
            out.append({"exDate": d, "dps": round(D, 4)})
    out.sort(key=lambda x: x["exDate"])
    return out

def main():
    ap = argparse.ArgumentParser(description="拉取股票 K 线数据（腾讯行情）")
    ap.add_argument("--start", default=DEFAULT_START, help=f"起始日期 (默认: {DEFAULT_START})")
    ap.add_argument("--end", default=DEFAULT_END, help=f"结束日期 (默认: 今天 {DEFAULT_END})")
    ap.add_argument("--force", action="store_true", help="强制重拉所有股票（跳过已有的）")
    args = ap.parse_args()
    global START, END
    START = args.start; END = args.end
    print(f"K 线拉取范围: {START} ~ {END}  (--start/--end 可自定义)")
    summary = {}
    for code, name in CORE.items():
        path = f"hist/{code}.json"
        if not args.force and os.path.exists(path):
            try:
                old = json.load(open(path, encoding="utf-8"))
                if old.get("kline") and old.get("divs") is not None:
                    print(f"-- {code} {name} (已有, 跳过; --force 可重拉)", flush=True)
                    summary[code] = {"name": name, "kline": len(old["kline"]), "divs": len(old.get("divs", []))}
                    continue
            except Exception:
                pass
        print(f"== {code} {name}", flush=True)
        raw = fetch_kline(code, "")
        hfq = fetch_kline(code, "hfq")
        if not raw:
            print("  !! raw 拉取失败", flush=True); continue
        raw_map = {r[0]: float(r[2]) for r in raw}        # close
        hfq_map = {r[0]: float(r[2]) for r in hfq} if hfq else {}
        kline = [{"date": dt, "close": raw_map[dt]} for dt in sorted(raw_map)]
        divs = derive_divs(raw_map, hfq_map) if hfq else []
        rec = {"code": code, "name": name, "isResource": code in IS_RES,
               "kline": kline, "divs": divs}
        with open(f"hist/{code}.json", "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False)
        print(f"  kline={len(kline)} divs={len(divs)} "
              f"({divs[0]['exDate'] if divs else '-'}..{divs[-1]['exDate'] if divs else '-'})", flush=True)
        # 校验：打印近两年派生分红
        recent = [x for x in divs if x["exDate"] >= "2024-06-01"]
        print("  近2年派生DPS:", [(x["exDate"], x["dps"]) for x in recent], flush=True)
        summary[code] = {"name": name, "kline": len(kline), "divs": len(divs)}
        time.sleep(0.4)
    with open("hist/_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("DONE -> hist/_summary.json", flush=True)

if __name__ == "__main__":
    main()
