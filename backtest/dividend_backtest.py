# -*- coding: utf-8 -*-
"""
高股息价值策略 · 回测引擎（真实分红口径 + 交易成本 + 标准风险指标）
================================================================
策略：sustainable-dividend-watchpool（MR Dang 股息率触发 + 分红复投）
资金模式：一次性建仓，逐月按「预期股息率档位」再平衡目标权重，分红自动复投。

本轮修复（独立评审第 4 轮）：
- [去前视] 分红完全来自东财真实历史除息事件（apply_watchpool_divs.py + data/real_divs.json），
  不再用当前 expDps 回填历史 → 历史 ttmDPS 与当时的真实分红一致。
- [交易成本] 佣金/印花税/滑点/整数手/执行延迟/分红复投延迟，全部参数化（默认中性档）。
- [指标] 夏普改标准日度超额收益口径；新增 Sortino / Calmar / 年化换手 / 月度胜率 / 年度收益分解。
- [幸存者偏差] 本回测是「当前股票池回溯测试」：固定 watchpool.json 时点的股票池，
  未含历史被剔除/退市的股票，收益会系统性偏乐观 —— 结论不可外推为策略可实现收益。

关键设计（避免未来函数）：
- 历史时点 t 的「股息率」用 t 时点已知的最近12个月实际分红(ttmDPS_t)。
- 双闸门（基本面/ DPS确认）历史无数据，跑两个版本给区间：
    mode=optimistic  -> 忽略闸门（乐观上界）
    mode=conservative-> 仅当 ttmDPS 未低于去年才允许买入（保守下界）
- 调仓：信号日收盘计算目标权重，默认次日收盘执行（execDelay=1，T+1）。
- 分红复投：除息日入账，默认次一交易日收盘复投（divDelay=1）。

目标权重（与 index.html decOf 一致）：
  非资源 buy=5 add=6 deep=7 ext=8；资源 +2（7/8/9/10）
  对应目标仓位：buy 3% / add 8% / deep 12% / ext 20%，单票上限 20%
  持有区(滞回带)：维持当前权重不减仓；减仓/退出区：目标权重 0

数据格式（hist/<code>.json）：
  {"code","name","isResource","kline":[{"date","close"}...],"divs":[{"exDate","dps"}...]}
"""
import argparse, glob, json, os, re, statistics
from datetime import date, datetime, timedelta

RF = 0.017  # 无风险利率（年化），用于夏普/索提诺

# ---------------- 交易成本模型（默认中性档，全部可调） ----------------
COST_DEFAULT = {
    "commissionRate": 0.00025,   # 佣金 万2.5
    "minCommission": 5.0,        # 单笔最低佣金 5 元
    "stampRate": 0.001,          # 印花税（卖出侧）2023-08-28 前 0.1%
    "stampRateNew": 0.0005,      # 印花税（卖出侧）2023-08-28 起 0.05%
    "stampCutoff": "2023-08-28",
    "slippage": 0.001,           # 滑点 0.1% 单边（买提价/卖压价）
    "lotSize": 100,              # 买入整手 100 股（卖出可零股）
    "execDelay": 1,              # 调仓执行延迟（交易日）：1 = 次日收盘执行
    "divDelay": 1,               # 分红复投延迟（交易日）：1 = 除息次一交易日收盘复投
}


def parse(d):
    return datetime.strptime(d, "%Y-%m-%d").date()


def load_stock(path):
    with open(path, encoding="utf-8") as f:
        s = json.load(f)
    kline = sorted([(parse(r["date"]), float(r["close"])) for r in s["kline"]])
    divs = sorted([(parse(r["exDate"]), float(r["dps"])) for r in s["divs"]])
    return s["code"], s["name"], bool(s.get("isResource")), kline, divs


def ttm_dps(divs, t):
    """t 时点已知的最近12个月实际分红合计（除息日在 (t-365, t] 内）"""
    lo = t - timedelta(days=365)
    return sum(dps for ex, dps in divs if lo < ex <= t)


def stamp_rate(d, cost):
    return cost["stampRateNew"] if d >= parse(cost["stampCutoff"]) else cost["stampRate"]


# ---------------- 决策引擎（复刻 index.html decOf） ----------------
def target_weight(y, is_res, gate_ok=True):
    if y is None or not (y >= 0):
        return None  # 无信号
    buy, add, deep, ext = (7, 8, 9, 10) if is_res else (5, 6, 7, 8)
    if not gate_ok:  # 保守闸门：不允许新买入，仅维持现有
        if y >= buy:
            return "hold"
        return 0.0
    if y >= ext:
        return 0.20
    if y >= deep:
        return 0.12
    if y >= add:
        return 0.08
    if y >= buy:
        return 0.03
    sell = buy - 0.8
    clear = buy - 1.2
    if y >= sell:
        return "hold"     # 滞回带：维持当前权重
    if y >= clear:
        return "reduce"   # 评估减仓：减半
    return 0.0            # 退出区：清仓


def build_panel(stocks, start, end):
    all_dates = set()
    for _, _, _, kline, _ in stocks:
        for d, _ in kline:
            if start <= d <= end:
                all_dates.add(d)
    dates = sorted(all_dates)
    if not dates:
        return [], {}
    panel = {}
    for code, name, is_res, kline, divs in stocks:
        closes = {d: c for d, c in kline if start <= d <= end}
        filled, last = {}, None
        for d in dates:
            if d in closes:
                last = closes[d]
            filled[d] = last
        ttm = {d: ttm_dps(divs, d) for d in dates}
        panel[code] = {"name": name, "is_res": is_res, "close": filled, "ttm": ttm, "divs": divs}
    return dates, panel


def simulate(dates, panel, mode, cost=None, drip=True):
    """策略模拟：逐月按目标权重再平衡（信号日收盘定权重，默认次日收盘执行）+ 分红复投 + 交易成本。"""
    cost = dict(COST_DEFAULT if cost is None else {**COST_DEFAULT, **cost})
    codes = list(panel.keys())
    cash = 1_000_000.0
    shares = {c: 0.0 for c in codes}
    n = len(dates)

    div_events = sorted((ex, c, dps) for c in codes for ex, dps in panel[c]["divs"])
    di = 0
    pending_q = []  # 待复投分红队列 [{"due_idx", "c", "amt"}], 按入账顺序, due_idx = 入账日索引 + divDelay

    month_ends = set()
    prev = None
    for d in dates:
        if prev is None or d.month != prev:
            month_ends.add(d)
            prev = d.month

    pending_reb = None  # (due_index, des)
    eq, weights_hist = [], []
    buy_notional_total = 0.0

    def exec_reb(i, des):
        nonlocal cash, buy_notional_total
        d = dates[i]
        px = {c: panel[c]["close"][d] or 0.0 for c in codes}
        tot = cash + sum(shares[c] * px[c] for c in codes)
        buys, sells = [], []
        for c in codes:
            p = px[c]
            if p <= 0:
                continue
            tgt_val = tot * des[c]
            cur_val = shares[c] * p
            if tgt_val >= cur_val:
                buy_px = p * (1 + cost["slippage"])
                lot = cost["lotSize"] if cost["lotSize"] > 0 else 1
                tsh = int(tgt_val / buy_px / lot) * lot
                if tsh < shares[c]:
                    tsh = shares[c]  # 整手下限：不小于现有持仓，避免碎片卖出
                if tsh - shares[c] > 0:
                    buys.append((c, tsh, (tsh - shares[c]) * buy_px))
            else:
                sell_px = p * (1 - cost["slippage"])
                tsh = tgt_val / sell_px if sell_px > 0 else 0.0
                if tsh < shares[c] - 1e-9:
                    sells.append((c, tsh, (shares[c] - tsh) * sell_px))
        fee_buy = sum(max(nl * cost["commissionRate"], cost["minCommission"]) for _, _, nl in buys)
        fee_sell = sum(max(nl * cost["commissionRate"], cost["minCommission"]) + nl * stamp_rate(d, cost)
                       for _, _, nl in sells)
        sell_proc = sum(nl for _, _, nl in sells)
        buy_cost = sum(nl for _, _, nl in buys) + fee_buy
        budget = cash + sell_proc - fee_sell
        if buy_cost > budget and buy_cost > 0:  # 现金不足：按比例削减买入（整手向下取整）
            k = budget / buy_cost
            buys2 = []
            for c, _, _ in buys:
                p = px[c]
                buy_px = p * (1 + cost["slippage"])
                lot = cost["lotSize"] if cost["lotSize"] > 0 else 1
                nb = tot * des[c] * k  # 同比例缩目标
                tsh = int(nb / buy_px / lot) * lot
                if tsh < shares[c]:
                    tsh = shares[c]
                if tsh - shares[c] > 0:
                    buys2.append((c, tsh, (tsh - shares[c]) * buy_px))
            buys = buys2
        for c, tsh, nl in buys:
            fee = max(nl * cost["commissionRate"], cost["minCommission"])
            shares[c] = tsh
            cash -= nl + fee
            buy_notional_total += nl
        for c, tsh, nl in sells:
            fee = max(nl * cost["commissionRate"], cost["minCommission"]) + nl * stamp_rate(d, cost)
            shares[c] = tsh
            cash += nl - fee
        tot2 = cash + sum(shares[c] * px[c] for c in codes)
        if tot2 > 0:
            weights_hist.append((d, {c: (shares[c] * px[c]) / tot2 for c in codes}))

    for i, d in enumerate(dates):
        px = {c: panel[c]["close"][d] or 0.0 for c in codes}
        # 1) 复投到期的分红（入账后 N 个交易日, N=cost["divDelay"]；计佣金+滑点, 与基准/再平衡同口径）
        if cost["divDelay"] >= 1:
            while pending_q and pending_q[0]["due_idx"] <= i:
                item = pending_q.pop(0)
                c, amt = item["c"], item["amt"]
                p = px[c]
                buy_px = p * (1 + cost["slippage"])
                if buy_px > 0:
                    fee = max(amt * cost["commissionRate"], cost["minCommission"])
                    invest = amt - fee
                    if invest > 0:
                        shares[c] += invest / buy_px
                        # 分红 amt 全部用于复投(invest 买股 + fee 佣金), cash 不变
                    else:
                        cash += amt  # 分红太小不足支付最低佣金 -> 留现金
                else:
                    cash += amt
        # 2) 入账今日除息分红（以除息日当日持股计）
        while di < len(div_events) and div_events[di][0] <= d:
            ex, c, dps = div_events[di]
            if shares[c] > 0:
                if not drip:
                    cash += shares[c] * dps          # DRIP 关闭: 分红沉淀为现金(不复投)
                elif cost["divDelay"] == 0 and px[c] > 0:
                    amt = shares[c] * dps            # 当日立即复投（旧口径）, 计佣金+滑点
                    buy_px = px[c] * (1 + cost["slippage"])
                    fee = max(amt * cost["commissionRate"], cost["minCommission"])
                    invest = amt - fee
                    if invest > 0:
                        shares[c] += invest / buy_px
                        # 分红 amt 全部用于复投(invest 买股 + fee 佣金), cash 不变
                    else:
                        cash += amt
                else:
                    pending_q.append({"due_idx": i + cost["divDelay"], "c": c,
                                      "amt": shares[c] * dps})
            di += 1
        # 3) 执行到期调仓
        if pending_reb is not None and pending_reb[0] == i:
            exec_reb(i, pending_reb[1])
            pending_reb = None
        # 4) 信号日：计算目标权重（收盘数据），按 execDelay 调度执行
        if d in month_ends:
            tot = cash + sum(shares[c] * px[c] for c in codes)
            if tot > 0:
                des = {}
                for c in codes:
                    p = px[c]
                    ttm = panel[c]["ttm"][d]
                    y = (ttm / p * 100) if (p and ttm > 0) else None
                    if mode == "conservative":
                        gate_ok = ttm >= ttm_dps(panel[c]["divs"], d - timedelta(days=365)) * 0.99
                        tw = target_weight(y, panel[c]["is_res"], gate_ok)
                    else:
                        tw = target_weight(y, panel[c]["is_res"], True)
                    cur_w = (shares[c] * p) / tot
                    if tw is None:
                        des[c] = cur_w
                    elif tw == "hold":
                        des[c] = cur_w
                    elif tw == "reduce":
                        des[c] = cur_w * 0.5
                    else:
                        des[c] = min(tw, 0.20)
                s = sum(des.values())
                if s > 1.0:
                    for c in des:
                        des[c] /= s
                if cost["execDelay"] > 0:
                    pending_reb = (min(i + cost["execDelay"], n - 1), des)
                else:
                    exec_reb(i, des)  # 当日收盘执行（旧口径）
        tot = cash + sum(shares[c] * px[c] for c in codes)
        pending_sum = sum(p["amt"] for p in pending_q)
        eq.append((d, tot + pending_sum))  # 净值含待复投分红(等价现金池); 调仓预算 tot 仍不含 pending
    return eq, weights_hist, buy_notional_total


def simulate_hold(dates, close_map, divs, start_cash=1_000_000.0, cost=None):
    """基准：建仓日买入并持有，分红再投入（DRIP）。
    与策略使用同一套成本模型(初始建仓佣金+滑点, 每次分红复投计佣金+滑点)和分红复投延迟
    (divDelay: 0=除息日当日复投, >=1=入账待复投现金 N 个交易日后复投)，与策略 simulate 语义一致。"""
    cost = dict(COST_DEFAULT if cost is None else {**COST_DEFAULT, **cost})
    first_d = next((d for d in dates if close_map.get(d)), None)
    px0 = close_map.get(first_d) or 0
    buy_px0 = px0 * (1 + cost["slippage"])
    fee0 = max(start_cash * cost["commissionRate"], cost["minCommission"]) if start_cash > 0 else 0.0
    shares = (start_cash - fee0) / buy_px0 if (buy_px0 > 0 and first_d) else 0.0
    if shares < 0:
        shares = 0.0
    cash = 0.0  # 佣金残余等现金
    pending_q = []  # 待复投分红队列 [{"due_idx", "amt"}], 按入账顺序, due_idx=入账日索引+divDelay
    ev = sorted(divs)
    di = 0
    if first_d:
        # 建仓日(含)之前的除息分红不归属投资者: 投资者尚未持有, 不能获得
        while di < len(ev) and ev[di][0] <= first_d:
            di += 1
    eq = []
    for i, d in enumerate(dates):
        # 1) 复投到期的待复投现金（入账后 N 个交易日, N=cost["divDelay"]）
        if cost["divDelay"] >= 1:
            while pending_q and pending_q[0]["due_idx"] <= i:
                amt = pending_q.pop(0)["amt"]
                px = close_map.get(d) or 0
                buy_px = px * (1 + cost["slippage"])
                if buy_px > 0:
                    fee = max(amt * cost["commissionRate"], cost["minCommission"])
                    invest = amt - fee
                    if invest > 0:
                        shares += invest / buy_px
                        # 分红 amt 全部用于复投(invest 买股 + fee 佣金), cash 不变
                    else:
                        cash += amt  # 分红太小不足支付最低佣金 -> 留现金
                else:
                    cash += amt
        # 2) 入账今日除息分红
        while di < len(ev) and ev[di][0] <= d:
            ex, dps = ev[di]
            if shares > 0:
                div_cash = shares * dps
                if cost["divDelay"] == 0:
                    # 除息日当日立即复投(旧口径)
                    px = close_map.get(d) or 0
                    buy_px = px * (1 + cost["slippage"])
                    if buy_px > 0:
                        fee = max(div_cash * cost["commissionRate"], cost["minCommission"])
                        invest = div_cash - fee
                        if invest > 0:
                            shares += invest / buy_px
                        else:
                            cash += div_cash  # 分红太小不足支付最低佣金 -> 留现金
                    else:
                        cash += div_cash
                else:
                    pending_q.append({"due_idx": i + cost["divDelay"], "amt": div_cash})
            di += 1
        px = close_map.get(d) or 0
        pending_sum = sum(p["amt"] for p in pending_q)
        eq.append((d, shares * px + cash + pending_sum))
    return eq


def metrics(dates, eq, buy_notional=None):
    """标准风险指标：日度超额收益夏普 / Sortino / Calmar / 换手 / 月度胜率 / 年度分解。"""
    eq = [(d, v) for d, v in eq if v is not None and v > 0]
    if len(eq) < 2:
        return {}
    d0, v0 = eq[0]
    d1, v1 = eq[-1]
    yrs = (d1 - d0).days / 365.25
    total_ret = v1 / v0 - 1
    cagr = (v1 / v0) ** (1 / yrs) - 1 if yrs > 0 else 0
    peak = eq[0][1]
    mdd = 0.0
    for _, v in eq:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    rets = [eq[i + 1][1] / eq[i][1] - 1 for i in range(len(eq) - 1)]
    rf_d = RF / 252.0
    excess = [r - rf_d for r in rets]
    vol = statistics.pstdev(rets) * (252 ** 0.5) if len(rets) > 1 else 0.0
    mean_ex = statistics.mean(excess) if excess else 0.0
    sd_ex = statistics.pstdev(excess) if len(excess) > 1 else 0.0
    sharpe = mean_ex / sd_ex * (252 ** 0.5) if sd_ex > 0 else 0.0
    downside = (sum(min(e, 0.0) ** 2 for e in excess) / len(excess)) ** 0.5 if excess else 0.0
    sortino = mean_ex / downside * (252 ** 0.5) if downside > 0 else 0.0
    calmar = cagr / (-mdd) if mdd < 0 else 0.0
    # 月度胜率
    by_month = {}
    for d, v in eq:
        by_month.setdefault((d.year, d.month), []).append(v)
    mrets, prev = [], None
    for k in sorted(by_month):
        vals = by_month[k]
        if prev is not None:
            mrets.append(vals[-1] / prev - 1)
        prev = vals[-1]
    win_rate = (sum(1 for m in mrets if m > 0) / len(mrets)) if mrets else 0.0
    # 年度收益分解（年内首末净值变化）
    by_year = {}
    for d, v in eq:
        by_year.setdefault(d.year, []).append(v)
    yearly = {str(y): round((vals[-1] / vals[0] - 1) * 100, 2) for y, vals in sorted(by_year.items())}
    m = {
        "start": d0.isoformat(), "end": d1.isoformat(), "years": round(yrs, 2),
        "final": round(v1), "total_ret": round(total_ret * 100, 2),
        "cagr": round(cagr * 100, 2), "mdd": round(mdd * 100, 2),
        "vol": round(vol * 100, 2), "sharpe": round(sharpe, 2),
        "sortino": round(sortino, 2), "calmar": round(calmar, 2),
        "win_rate": round(win_rate * 100, 1), "yearly": yearly,
    }
    if buy_notional:
        avg_eq = statistics.mean(v for _, v in eq) if eq else 0
        m["turnover"] = round(buy_notional / avg_eq / yrs, 3) if (avg_eq > 0 and yrs > 0) else 0.0
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hist", default="hist")
    ap.add_argument("--start", default="2015-01-01", help="回测起始日期 (默认: 2015-01-01)")
    ap.add_argument("--end", default=datetime.now().strftime("%Y-%m-%d"), help="回测结束日期 (默认: 今天)")
    ap.add_argument("--mode", default="both", choices=["optimistic", "conservative", "both"])
    args = ap.parse_args()
    start, end = parse(args.start), parse(args.end)

    files = sorted(glob.glob(os.path.join(args.hist, "*.json")))
    base = lambda f: os.path.basename(f)
    stock_files = [f for f in files if re.match(r"^(sh|sz)\d{6}\.json$", base(f))]
    ALLOWED_BENCH = {"sh513500", "sh000300", "sh000922"}
    bench_files = [f for f in files if base(f).startswith("bench_") and base(f)[6:-5] in ALLOWED_BENCH]
    stocks = [(c, n, r, k, d) for c, n, r, k, d in (load_stock(f) for f in stock_files) if k]
    benches = [(c, n, r, k, d) for c, n, r, k, d in (load_stock(f) for f in bench_files) if k]
    print(f"策略股票 {len(stocks)} 只：{[c for c, _, _, _, _ in stocks]}")
    print(f"基准 {len(benches)} 个：{[n for _, n, _, _, _ in benches]}")

    dates, panel = build_panel(stocks, start, end)
    print(f"交易日轴：{len(dates)} 天，{dates[0]} ~ {dates[-1]}")
    print(f"成本模型：佣金万{COST_DEFAULT['commissionRate']*10000:.1f}(最低{COST_DEFAULT['minCommission']:.0f}元) "
          f"印花税卖出{COST_DEFAULT['stampRate']*100:.2f}%→{COST_DEFAULT['stampRateNew']*100:.2f}% "
          f"滑点{COST_DEFAULT['slippage']*100:.1f}% 整手{COST_DEFAULT['lotSize']}股 "
          f"调仓延迟{COST_DEFAULT['execDelay']}日 分红复投延迟{COST_DEFAULT['divDelay']}日")

    all_metrics = {}
    for mode in (["optimistic", "conservative"] if args.mode == "both" else [args.mode]):
        eq, wh, buy_nl = simulate(dates, panel, mode)
        m = metrics(dates, eq, buy_notional=buy_nl)
        all_metrics[f"策略-{mode}"] = m
        print(f"\n=== 策略 模式: {mode} ===")
        print(json.dumps(m, ensure_ascii=False, indent=2))
        out = os.path.join(args.hist, f"equity_{mode}.csv")
        with open(out, "w", encoding="utf-8") as f:
            f.write("date,equity\n")
            for d, v in eq:
                f.write(f"{d.isoformat()},{v:.2f}\n")
        print(f"净值已导出: {out}")
    for c, n, _, kline, divs in benches:
        closes = {d: p for d, p in kline if start <= d <= end}
        first_valid = next((d for d in dates if d in closes), None)
        last = closes.get(first_valid) if first_valid else None
        filled = {}
        for d in dates:
            if d in closes:
                last = closes[d]
            filled[d] = last
        eq = simulate_hold(dates, filled, divs)
        m = metrics(dates, eq)
        all_metrics[f"基准-{n}"] = m
        print(f"\n=== 基准: {n} ===")
        print(json.dumps(m, ensure_ascii=False, indent=2))
        out = os.path.join(args.hist, f"bench_{c}_equity.csv")
        with open(out, "w", encoding="utf-8") as f:
            f.write("date,equity\n")
            for d, v in eq:
                f.write(f"{d.isoformat()},{v:.2f}\n")
        print(f"净值已导出: {out}")
    print("\n========== 对比汇总（初始 100 万 · 按月再平衡 + 分红复投 + 交易成本）==========")
    print(f"{'策略/基准':<26}{'CAGR%':>8}{'总收益%':>10}{'MDD%':>8}{'波动%':>8}{'夏普':>7}"
          f"{'Sortino':>9}{'Calmar':>8}{'换手':>7}{'月胜率%':>8}")
    for k, m in all_metrics.items():
        print(f"{k:<26}{m.get('cagr', 0):>8}{m.get('total_ret', 0):>10}{m.get('mdd', 0):>8}"
              f"{m.get('vol', 0):>8}{m.get('sharpe', 0):>7}{m.get('sortino', 0):>9}"
              f"{m.get('calmar', 0):>8}{m.get('turnover', '-'):>7}{m.get('win_rate', '-'):>8}")
    with open(os.path.join(args.hist, "summary_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(all_metrics, f, ensure_ascii=False, indent=2)
    print("汇总已导出: hist/summary_metrics.json")


if __name__ == "__main__":
    main()
