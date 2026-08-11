// ============================================================
// backtest_engine.js  —  高股息策略回测引擎 (浏览器 + Node 通用, 无 DOM 依赖)
// 移植自 dividend_backtest.py, 并扩展「股息率百分位估值」维度。
// 策略核心 (用户定义):
//   买入 = 股息率高(>= 买入触发线) 且 处于历史低位百分位(便宜)
//   卖出 = 股息率低(<= 卖出触发线) 且 处于历史高位百分位(贵)
//
// 本轮(第4轮评审)更新:
//  - 交易成本: 佣金/印花税(卖出)/滑点/买入整手/调仓执行延迟/分红复投延迟 (默认中性档, P.* 可调)
//  - 指标: 标准日度超额收益夏普 + Sortino + Calmar + 年化换手 + 月度胜率 + 年度分解
//  - 分红源: 东财真实历史除息事件 (数据由 generate_bundle.py 从 hist/*.json 生成)
// ============================================================

// ---------- 日期工具 (ISO 'YYYY-MM-DD' 字符串, 全程 UTC 以匹配 Python timedelta, 避免时区漂移) ----------
export function parseD(s){ const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function shiftDays(s, n){
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}
export function addDaysStr(s, n){ return shiftDays(s, n); }
export function subDaysStr(s, n){ return shiftDays(s, -n); }
export function daysBetween(a, b){ return Math.round((parseD(b) - parseD(a)) / 86400000); }

// 无风险利率(年化) —— 与 Python 引擎保持一致
export const RF = 0.017;

// ---------- 最近 12 个月实际分红 (避免未来函数) ----------
export function ttmDps(divs, t){
  const lo = subDaysStr(t, 365);
  let s = 0;
  for (const [ex, dps] of divs){ if (lo < ex && ex <= t) s += dps; }
  return s;
}

// ---------- 交易成本默认值(中性档, 与 Python COST_DEFAULT 一致) ----------
export function defaultCost(){
  return {
    commissionRate: 0.00025, minCommission: 5.0,
    stampRate: 0.001, stampRateNew: 0.0005, stampCutoff: '2023-08-28',
    slippage: 0.001, lotSize: 100, execDelay: 1, divDelay: 1,
  };
}
function stampRateOn(d, cost){
  return d >= cost.stampCutoff ? cost.stampRateNew : cost.stampRate;
}

// ---------- 经典档位决策 (复刻 index.html decOf + 滞回) ----------
// 非资源 5/6/7/8%, 资源 +2 -> 7/8/9/10%; 对应仓位 3/8/12/20%, 单票<=20%
// 档位以 buyYield 为基准(buy/buy+1/buy+2/buy+3), 资源自动 +2; 与百分位路径保持一致。
// gate_ok=false(保守模式: 分红同比下滑>1%)时, 不新开仓, 仅维持现有。
export function targetWeightPure(y, isRes, P, gate_ok = true){
  if (y === null || y === undefined || !(y >= 0)) return null;
  const buy = P ? ((isRes && P.resourceExtra) ? P.buyYield + 2 : P.buyYield) : (isRes ? 7 : 5);
  const add = buy + 1, deep = buy + 2, ext = buy + 3;
  if (P && P.conservative && !gate_ok) return (y >= buy) ? 'hold' : 0.0;  // 保守闸门
  if (y >= ext) return 0.20;
  if (y >= deep) return 0.12;
  if (y >= add)  return 0.08;
  if (y >= buy)  return 0.03;
  const sell = buy - 0.8, clear = buy - 1.2;     // 滞回带
  if (y >= sell) return 'hold';
  if (y >= clear) return 'reduce';
  return 0.0;
}

// ---------- 百分位估值决策 (用户新增维度) ----------
// 买入 = 股息率高 且 百分位便宜(pct<=cheapPct)
// 卖出 = 股息率低 且 百分位贵(pct>=expensivePct)
// pct 为 null(历史不足)时退化为经典档位, 保证回测起点可用
export function targetWeightPct(y, pct, isRes, P, gate_ok = true, tilt = false){
  if (y === null || y === undefined || !(y >= 0)) return null;
  const buy = (isRes && P.resourceExtra) ? (P.buyYield + 2) : P.buyYield;
  // 保守闸门: 分红同比下滑>1% 时, 不新开仓(仅维持现有)
  if (P.conservative && !gate_ok) return (y >= buy) ? 'hold' : 0.0;
  if (pct === null) return targetWeightPure(y, isRes, P, gate_ok);   // 预热期: 经典档位
  // 软倾斜模式: 以档位目标权重为基底, 用百分位做仓位微调(便宜满配/中性七成/贵区四成),
  // 不把"非便宜"当硬闸门 —— 避免高股息组合长期建不起仓位、收益被压垮。
  if (tilt){
    const add = buy + 1, deep = buy + 2, ext = buy + 3;
    let w = 0;
    if (y >= ext) w = 0.20; else if (y >= deep) w = 0.12; else if (y >= add) w = 0.08; else if (y >= buy) w = 0.03;
    if (pct <= P.cheapPct) return w > 0 ? Math.min(w, P.maxWeight) : 'hold';  // 便宜区: 满配; 息过低则持有(不卖便宜股)
    if (pct >= P.expensivePct){                                        // 贵区
      if (y <= P.sellYield) return 0.0;                               // 贵+低息: 清仓
      return w > 0 ? Math.min(w * 0.4, P.maxWeight) : 'hold';         // 贵+息尚可: 减至四成留底仓; 恡过低则持有
    }
    return w > 0 ? Math.min(w * 0.7, P.maxWeight) : 'hold';           // 中性: 七成; 息过低则持有
  }
  // 「便宜买入」优先于「贵卖出」: 处于便宜区即按档位买, 不再被贵区覆盖
  if (pct <= P.cheapPct){                                        // 便宜区: 按档位买
    const add = buy + 1, deep = buy + 2, ext = buy + 3;
    if (y >= ext) return 0.20;
    if (y >= deep) return 0.12;
    if (y >= add)  return 0.08;
    if (y >= buy)  return 0.03;
    return 'hold';                                               // 历史便宜但绝对股息率不高 -> 持有
  }
  if (pct >= P.expensivePct){                                    // 贵区
    if (y <= P.sellYield) return 0.0;                            // 股息率低+贵 -> 清仓
    return 'reduce';                                             // 股息率尚可但贵 -> 减半
  }
  return 'hold';                                                 // 中性区: 维持
}

// ---------- 构建统一日期轴 + 每日 ttm 股息率 ----------
export function buildPanel(stocksData, start, end){
  const allDates = new Set();
  const parsed = stocksData.map(s => {
    const kline = (s.kline || [])
      .filter(r => r[0] >= start && r[0] <= end)
      .map(r => [r[0], +r[1]])
      .sort((a, b) => a[0] < b[0] ? -1 : 1);
    const divs = (s.divs || [])
      .map(r => [r[0], +r[1]])
      .sort((a, b) => a[0] < b[0] ? -1 : 1);
    return { code: s.code, name: s.name, isResource: !!s.isResource, kline, divs };
  });
  for (const s of parsed) for (const [d] of s.kline) allDates.add(d);
  const dates = [...allDates].sort();
  const panel = {};
  for (const s of parsed){
    const closes = {}; for (const [d, c] of s.kline) closes[d] = c;
    const filled = {}; let last = null;
    for (const d of dates){ if (d in closes) last = closes[d]; filled[d] = last; }
    const ttm = {}; for (const d of dates) ttm[d] = ttmDps(s.divs, d);
    panel[s.code] = { name: s.name, isRes: s.isResource, close: filled, ttm, divs: s.divs, kline: s.kline };
  }
  return { dates, panel };
}

// 某股票在 d 时点的「股息率百分位」(回看窗口内历史股息率的排名)
function pctAt(dates, panel, c, d, lookbackDays){
  const lo = subDaysStr(d, lookbackDays);
  const closes = panel[c].close, ttm = panel[c].ttm;
  const hist = [];
  for (const dd of dates){
    if (dd < lo) continue;
    if (dd > d) break;
    const px = closes[dd], t = ttm[dd];
    if (px && px > 0 && t > 0) hist.push(t / px * 100);
  }
  if (hist.length < 126) return null;                 // 不足约半年 -> 预热
  const cur = (closes[d] && ttm[d] > 0) ? ttm[d] / closes[d] * 100 : null;
  if (cur === null) return null;
  let below = 0; for (const h of hist) if (h < cur) below++;
  return below / hist.length * 100;
}

// 单股在 d 时点的信号(供工具展示「当前该买/持/卖」)
export function signalAt(panel, dates, c, d, P){
  const lookbackDays = Math.round((P.lookbackYears || 5) * 365);
  const px = panel[c].close[d], ttm = panel[c].ttm[d];
  const y = (px && ttm > 0) ? ttm / px * 100 : null;
  const pct = (P.usePercentile === false) ? null : pctAt(dates, panel, c, d, lookbackDays);
  const gate_ok = !P.conservative ? true
    : (ttm >= ttmDps(panel[c].divs, subDaysStr(d, 365)) * 0.99);
          const tw = (P.usePercentile === false)
            ? targetWeightPure(y, panel[c].isRes, P, gate_ok)
            : targetWeightPct(y, pct, panel[c].isRes, P, gate_ok, P.tilt);
  let label, cls;
  if (tw === null) { label = '无信号'; cls = 'flat'; }
  else if (tw === 'hold') { label = '持有'; cls = 'hold'; }
  else if (tw === 'reduce') { label = '减仓'; cls = 'reduce'; }
  else if (tw === 0.0) { label = '清仓'; cls = 'sell'; }
  else { label = '买入'; cls = 'buy'; }
  return { y, pct, tw, label, cls };
}

// ---------- 策略模拟: 月度/季度再平衡 + 分红复投(DRIP) + 交易成本 + 执行延迟 ----------
// 与 Python dividend_backtest.simulate 逐行对齐(0 偏差):
//   - 信号日收盘计算目标权重; execDelay=1 默认次日收盘执行(T+1)
//   - 分红除息日入账, divDelay=1 默认次一交易日收盘复投
//   - 买入整手(lotSize), 卖出可零股; 佣金/印花税/滑点按 cost 参数
export function simulate(dates, panel, P){
  const cost = Object.assign(defaultCost(), P && P.cost ? P.cost : {});
  const codes = Object.keys(panel);
  let cash = P.initialCapital;
  const shares = {}; codes.forEach(c => shares[c] = 0);
  const n = dates.length;

  const divEvents = [];
  for (const c of codes) for (const [ex, dps] of panel[c].divs) divEvents.push([ex, c, dps]);
  divEvents.sort((a, b) => a[0] < b[0] ? -1 : 1);
  let di = 0;
  const pendingQ = [];   // 待复投分红队列 {dueIdx, c, amt}, 按入账顺序, dueIdx=入账交易日+i+divDelay

  const rebDays = new Set(); let prevKey = null;
  for (const d of dates){
    const dt = parseD(d);
    const key = (P.rebalance === 'quarter')
      ? (dt.getFullYear() * 4 + Math.floor(dt.getMonth() / 3))
      : (dt.getFullYear() * 12 + dt.getMonth());
    if (key !== prevKey){ rebDays.add(d); prevKey = key; }
  }

  let pendingReb = null;   // [dueIndex, des]
  const eq = []; const weightsHist = [];
  const lookbackDays = Math.round((P.lookbackYears || 5) * 365);
  let buyNotional = 0;
  let exposureSum = 0;     // 日均股票仓位(用于区分 beta/alpha)

  function execReb(i, des){
    const d = dates[i];
    const px = {}; codes.forEach(c => px[c] = panel[c].close[d] || 0);
    let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
    const buys = [], sells = [];
    for (const c of codes){
      const p = px[c];
      if (!p || p <= 0) continue;
      const tgtVal = tot * des[c];
      const curVal = shares[c] * p;
      if (tgtVal >= curVal){
        const buyPx = p * (1 + cost.slippage);
        const lot = cost.lotSize > 0 ? cost.lotSize : 1;
        let tsh = Math.floor(tgtVal / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];          // 整手下限: 不小于现持
        if (tsh - shares[c] > 0) buys.push([c, tsh, (tsh - shares[c]) * buyPx]);
      } else {
        const sellPx = p * (1 - cost.slippage);
        const tsh = sellPx > 0 ? tgtVal / sellPx : 0;
        if (tsh < shares[c] - 1e-9) sells.push([c, tsh, (shares[c] - tsh) * sellPx]);
      }
    }
    let feeBuy = 0; buys.forEach(([, , nl]) => feeBuy += Math.max(nl * cost.commissionRate, cost.minCommission));
    let feeSell = 0; sells.forEach(([, , nl]) => feeSell += Math.max(nl * cost.commissionRate, cost.minCommission) + nl * stampRateOn(d, cost));
    const sellProc = sells.reduce((a, [, , nl]) => a + nl, 0);
    let buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    const budget = cash + sellProc - feeSell;
    if (buyCost > budget && buyCost > 0){              // 现金不足: 按比例削减买入(整手向下取整)
      const k = budget / buyCost;
      const buys2 = [];
      for (const [c] of buys){
        const p = px[c];
        const buyPx = p * (1 + cost.slippage);
        const lot = cost.lotSize > 0 ? cost.lotSize : 1;
        const nb = tot * des[c] * k;
        let tsh = Math.floor(nb / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];
        if (tsh - shares[c] > 0) buys2.push([c, tsh, (tsh - shares[c]) * buyPx]);
      }
      buys.length = 0; buys2.forEach(b => buys.push(b));
      buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    }
    for (const [c, tsh, nl] of buys){
      const fee = Math.max(nl * cost.commissionRate, cost.minCommission);
      shares[c] = tsh; cash -= nl + fee; buyNotional += nl;
    }
    for (const [c, tsh, nl] of sells){
      const fee = Math.max(nl * cost.commissionRate, cost.minCommission) + nl * stampRateOn(d, cost);
      shares[c] = tsh; cash += nl - fee;
    }
    let tot2 = cash; codes.forEach(c => tot2 += shares[c] * px[c]);
    if (tot2 > 0){
      const ws = {}; codes.forEach(c => ws[c] = (shares[c] * px[c]) / tot2);
      weightsHist.push([d, ws]);
    }
  }

  for (let i = 0; i < n; i++){
    const d = dates[i];
    const px = {}; codes.forEach(c => px[c] = panel[c].close[d] || 0);
    // 1) 复投到期的分红 (入账后 N 个交易日, N=cost.divDelay; 计佣金+滑点, 与基准/再平衡同口径)
    if (cost.divDelay >= 1){
      while (pendingQ.length && pendingQ[0].dueIdx <= i){
        const { c, amt } = pendingQ.shift();
        const p = px[c];
        const buyPx = p * (1 + cost.slippage);
        if (buyPx > 0){
          const fee = Math.max(amt * cost.commissionRate, cost.minCommission);
          const invest = amt - fee;
          if (invest > 0){ shares[c] += invest / buyPx; }
          else { cash += amt; }                 // 分红太小不足支付最低佣金 -> 留现金
        } else { cash += amt; }
      }
    }
    // 2) 入账今日除息分红 (以除息日当日持股计)
    while (di < divEvents.length && divEvents[di][0] <= d){
      const [ex, c, dps] = divEvents[di];
      if (shares[c] > 0){
        if (P.drip === false){
          cash += shares[c] * dps;                     // DRIP 关闭: 分红沉淀为现金(不复投)
        } else if (cost.divDelay === 0 && px[c] > 0){
          const amt = shares[c] * dps;                 // 当日立即复投(旧口径), 计佣金+滑点
          const buyPx = px[c] * (1 + cost.slippage);
          const fee = Math.max(amt * cost.commissionRate, cost.minCommission);
          const invest = amt - fee;
          if (invest > 0){ shares[c] += invest / buyPx; }
          else { cash += amt; }
        } else {
          pendingQ.push({ dueIdx: i + cost.divDelay, c, amt: shares[c] * dps });
        }
      }
      di++;
    }
    // 3) 执行到期调仓
    if (pendingReb !== null && pendingReb[0] === i){
      execReb(i, pendingReb[1]);
      pendingReb = null;
    }
    // 4) 信号日: 计算目标权重(收盘数据), 按 execDelay 调度执行
    if (rebDays.has(d)){
      let tot = cash; codes.forEach(c => tot += shares[c] * (panel[c].close[d] || 0));
      if (tot > 0){
        const des = {};
        for (const c of codes){
          const p = panel[c].close[d];
          const ttm = panel[c].ttm[d];
          const y = (p && ttm > 0) ? ttm / p * 100 : null;
          const gate_ok = !P.conservative ? true
            : (ttm >= ttmDps(panel[c].divs, subDaysStr(d, 365)) * 0.99);
          let tw;
          if (P.usePercentile === false){
            tw = targetWeightPure(y, panel[c].isRes, P, gate_ok);
          } else {
            const pct = pctAt(dates, panel, c, d, lookbackDays);
            tw = targetWeightPct(y, pct, panel[c].isRes, P, gate_ok, P.tilt);
          }
          const cur_w = (shares[c] * p) / tot;
          if (tw === null)       des[c] = cur_w;
          else if (tw === 'hold') des[c] = cur_w;
          else if (tw === 'reduce') des[c] = cur_w * 0.5;
          else des[c] = Math.min(tw, P.maxWeight);
        }
        let s = 0; codes.forEach(c => s += des[c]);
        if (s > 1.0){ codes.forEach(c => des[c] /= s); }   // 不杠杆: 等比例缩到 100%
        if (cost.execDelay > 0){
          pendingReb = [Math.min(i + cost.execDelay, n - 1), des];
        } else {
          execReb(i, des);                                 // 当日收盘执行(旧口径)
        }
      }
    }
    let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
    let pendingSum = 0; for (const p of pendingQ) pendingSum += p.amt;
    const val = tot + pendingSum;   // 净值含待复投分红(等价现金池); 调仓预算 tot 仍不含 pending
    const stockVal = codes.reduce((a, c) => a + shares[c] * px[c], 0);
    exposureSum += val > 0 ? stockVal / val : 0;
    eq.push([d, val]);
  }
  return { equity: eq, weights: weightsHist, buyNotional, avgExposure: exposureSum / n };
}

// ---------- 基准: 买入持有 + 分红复投 ----------
// 与策略使用同一套成本模型(初始建仓佣金+滑点, 每次分红复投计佣金+滑点)和分红复投延迟(divDelay):
// divDelay=0 除息日当日收盘复投; divDelay=N>=1 入账待复投现金, N 个交易日后收盘复投。
// 待复投现金计入净值(等价于现金池), 保证 divDelay=1 默认数字与单一现金池实现一致。
export function simulateHold(dates, closeMap, divs, startCash = 1e6, cost){
  cost = Object.assign(defaultCost(), cost || {});
  let firstD = null;
  for (const d of dates){ if (closeMap[d] != null){ firstD = d; break; } }
  const px0 = closeMap[firstD] || 0;
  const buyPx0 = px0 * (1 + cost.slippage);
  const fee0 = Math.max(startCash * cost.commissionRate, cost.minCommission);
  let shares = buyPx0 > 0 ? Math.max(startCash - fee0, 0) / buyPx0 : 0;
  let cash = 0;                       // 佣金残余等现金
  const pendingQ = [];                // 待复投分红队列 {dueIdx, amt}
  const ev = [...divs].sort((a, b) => a[0] < b[0] ? -1 : 1);
  let di = 0;
  if (firstD != null){
    // 建仓日(含)之前的除息分红不归属投资者: 投资者尚未持有, 不能获得
    while (di < ev.length && ev[di][0] <= firstD) di++;
  }
  const eq = [];
  for (let i = 0; i < dates.length; i++){
    const d = dates[i];
    // 1) 复投到期的待复投现金 (入账后 N 个交易日, N=cost.divDelay)
    if (cost.divDelay >= 1){
      while (pendingQ.length && pendingQ[0].dueIdx <= i){
        const { amt } = pendingQ.shift();
        const px = closeMap[d] || 0;
        const buyPx = px * (1 + cost.slippage);
        if (buyPx > 0){
          const fee = Math.max(amt * cost.commissionRate, cost.minCommission);
          const invest = amt - fee;
          if (invest > 0){ shares += invest / buyPx; }
          else { cash += amt; }           // 分红太小不足支付最低佣金 -> 留现金
        } else { cash += amt; }
      }
    }
    // 2) 入账今日除息分红
    while (di < ev.length && ev[di][0] <= d){
      const [ex, dps] = ev[di];
      if (shares > 0){
        const divCash = shares * dps;
        if (cost.divDelay === 0){
          // 除息日当日立即复投(旧口径)
          const px = closeMap[d] || 0;
          const buyPx = px * (1 + cost.slippage);
          if (buyPx > 0){
            const fee = Math.max(divCash * cost.commissionRate, cost.minCommission);
            const invest = divCash - fee;
            if (invest > 0){ shares += invest / buyPx; }
            else { cash += divCash; }
          } else { cash += divCash; }
        } else {
          pendingQ.push({ dueIdx: i + cost.divDelay, amt: divCash });  // 入账, 延迟复投
        }
      }
      di++;
    }
    const px = closeMap[d] || 0;
    let pendingSum = 0; for (const p of pendingQ) pendingSum += p.amt;
    eq.push([d, shares * px + cash + pendingSum]);
  }
  return eq;
}

// ---------- 指标 (与 Python metrics 逐行对齐) ----------
// 标准日度超额收益夏普: mean(daily_ret - rf/252) / std(daily_ret - rf/252) * sqrt(252)
// Sortino: 下行偏差 sqrt(mean(min(excess,0)^2)); Calmar: CAGR/|MDD|
// 月度胜率: 按自然月分组, 月末值环比 >0 的比例
// 换手(仅策略): 年化单边 = 买入成交额 / 日均净值 / 年数
export function metrics(eq, buyNotional){
  const e = eq.filter(([, v]) => v != null && v > 0);
  if (e.length < 2) return {};
  const [d0, v0] = e[0]; const [d1, v1] = e[e.length - 1];
  const yrs = daysBetween(d0, d1) / 365.25;
  const totalRet = v1 / v0 - 1;
  const cagr = yrs > 0 ? Math.pow(v1 / v0, 1 / yrs) - 1 : 0;
  let peak = e[0][1], mdd = 0;
  for (const [, v] of e){ peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const rets = []; for (let i = 0; i < e.length - 1; i++) rets.push(e[i + 1][1] / e[i][1] - 1);
  const rfD = RF / 252;
  const excess = rets.map(r => r - rfD);
  const meanEx = excess.reduce((a, b) => a + b, 0) / excess.length;
  const sdEx = Math.sqrt(excess.reduce((a, b) => a + (b - meanEx) ** 2, 0) / excess.length);
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - rets.reduce((x, y) => x + y, 0) / rets.length) ** 2, 0) / rets.length) * Math.sqrt(252);
  const sharpe = sdEx > 0 ? meanEx / sdEx * Math.sqrt(252) : 0;
  const downside = Math.sqrt(excess.reduce((a, b) => a + Math.min(b, 0) ** 2, 0) / excess.length);
  const sortino = downside > 0 ? meanEx / downside * Math.sqrt(252) : 0;
  const calmar = mdd < 0 ? cagr / (-mdd) : 0;
  // 月度胜率
  const byMonth = {};
  for (const [d, v] of e){ const dt = parseD(d); byMonth[dt.getFullYear() * 100 + dt.getMonth()] = v; }
  const mKeys = Object.keys(byMonth).map(Number).sort((a, b) => a - b);
  let winSum = 0, winN = 0, prevV = null;
  for (const k of mKeys){
    if (prevV !== null){ winN++; if (byMonth[k] / prevV - 1 > 0) winSum++; }
    prevV = byMonth[k];
  }
  const winRate = winN > 0 ? winSum / winN : 0;
  // 年度收益分解(年内首末净值)
  const byYear = {};
  for (const [d, v] of e){ const y = parseD(d).getFullYear(); (byYear[y] = byYear[y] || []).push(v); }
  const yearly = {};
  for (const y of Object.keys(byYear).map(Number).sort((a, b) => a - b)){
    const vals = byYear[y]; yearly[String(y)] = +( (vals[vals.length - 1] / vals[0] - 1) * 100 ).toFixed(2);
  }
  const m = {
    start: d0, end: d1, years: +yrs.toFixed(2), final: Math.round(v1),
    total_ret: +(totalRet * 100).toFixed(2), cagr: +(cagr * 100).toFixed(2),
    mdd: +(mdd * 100).toFixed(2), vol: +(vol * 100).toFixed(2),
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), calmar: +calmar.toFixed(2),
    win_rate: +(winRate * 100).toFixed(1), yearly,
  };
  if (buyNotional != null && buyNotional > 0){
    const avgEq = e.reduce((a, [, v]) => a + v, 0) / e.length;
    m.turnover = (avgEq > 0 && yrs > 0) ? +(buyNotional / avgEq / yrs).toFixed(3) : 0;
  }
  return m;
}

// ---------- 便捷封装 ----------
export function runStrategy(dates, panel, P){
  const { equity, weights, buyNotional, avgExposure } = simulate(dates, panel, P);
  return { equity, weights, metrics: metrics(equity, buyNotional), avgExposure };
}

// 基准封装: 在统一 dates 轴上向前填充收盘价后买入持有
// cost 可选: 与策略同一套成本模型(建仓佣金+滑点、分红复投费用); 不传则用默认中性档
export function runBenchmark(dates, kline, divs, startCash = 1e6, cost){
  const closes = {}; for (const [d, p] of kline) closes[d] = p;
  let firstValid = null;
  for (const d of dates){ if (d in closes){ firstValid = d; break; } }
  let last = closes[firstValid];
  const filled = {};
  for (const d of dates){ if (d in closes) last = closes[d]; filled[d] = last; }
  const eq = simulateHold(dates, filled, divs, startCash, cost);
  return { equity: eq, metrics: metrics(eq) };
}
