// ============================================================
// experiment_v2.mjs — v2 策略变体实验: 点时分红信号 + 质量过滤 + 连续仓位评分
//                    + 动量过滤 + 最低仓位, 滚动样本外评估(参数冻结)
//
// 背景(用户第9轮路线图, "最值得先做的实验"):
//   "真实点时分红 + 质量过滤 + 连续仓位评分 + 6-12个月动量过滤",
//   同时比较最低仓位 40%/60%/80%; 必须用滚动样本外, 冻结参数后再看结果。
//
// v2 相对 v1 的改动(全部无前视):
//   1) 点时分红信号: 股息率 = 最近已公告(PLAN_NOTICE_DATE 预案日)的年报+中报每股分红 / 价,
//      替代 v1 的 realized-TTM 滚动窗口(滞后)。预案公告日早于除息日 1-3 个月。
//   2) 质量过滤: 财务(ROE/毛利率/每股经营现金流 vs 分红/负债率, 银行豁免负债率, 按公告日
//      point-in-time) + 分红可持续性(连续3年、未显著下滑); 模式 none/penalty(×0.5)/gate(=0)。
//   3) 连续仓位评分: 股息率连续映射 + 百分位连续打折, 替代档位硬门槛。
//   4) 动量过滤: 12个月价格动量 <-20% 减半, <-35% 清仓。
//   5) 最低股票仓位: 组合层强制 40%/60%/80%(现金拖累修复)。
//   6) 季度调仓 + 最小调仓幅度 1pp。
// 交易执行/成本与 v1 完全一致(佣金万2.5/印花税分阶段/滑点0.1%/整手/调仓延迟1日/
//   分红复投延迟1日且计费/净值含待复投), 保证对比公平。
//
// 评估: 滚动样本外(2016-2025 年度窗口), 每窗口独立建仓; 输出平均CAGR/胜率/平均MDD/
//   平均仓位(区分 beta 与 alpha: 收益上升若伴随仓位上升, 不视为 alpha)。
// ============================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { metrics } from './backtest_engine.js';

const HIST = 'hist';
const END = JSON.parse(readFileSync('backtest_bundle.json', 'utf8')).meta.end;
const STOCK_RE = /^(sh|sz)\d{6}\.json$/;

// ---------- 数据加载 ----------
const realDivs = JSON.parse(readFileSync('data/real_divs.json', 'utf8')).stocks || {};
const finDoc = JSON.parse(readFileSync('data/financials.json', 'utf8'));
const financials = finDoc.stocks || {};
const FIN_META = finDoc.meta || {};

const stocks = [];
for (const f of readdirSync(HIST)){
  if (!STOCK_RE.test(f)) continue;
  const d = JSON.parse(readFileSync(join(HIST, f), 'utf8'));
  stocks.push({
    code: d.code, name: d.name, isResource: d.isResource,
    kline: d.kline.map(r => [r.date, +r.close]).sort((a, b) => a[0] < b[0] ? -1 : 1),
  });
}

// 金融股(银行)豁免负债率质量项
const FIN_EXEMPT = new Set(['sh601398', 'sh601939', 'sh601288']);

// ---------- v2 面板构建 ----------
function buildPanelV2(st, en){
  const allDates = new Set();
  for (const s of stocks) for (const [d] of s.kline) if (d >= st && d <= en) allDates.add(d);
  const dates = [...allDates].sort();
  const panel = {};
  for (const s of stocks){
    const closes = {}; for (const [d, c] of s.kline) closes[d] = c;
    const filled = {}; let last = null;
    for (const d of dates){ if (d in closes) last = closes[d]; filled[d] = last; }
    // 分红事件: 用预案公告日(planDate)作已知时点
    const events = (realDivs[s.code] || [])
      .map(e => ({ ex: e.exDate, dps: e.dps, rep: e.reportDate || '', plan: e.planDate || e.exDate }))
      .filter(e => e.plan <= en)
      .sort((a, b) => a.plan < b.plan ? -1 : 1);
    // 财务年报(公告日 point-in-time)
    const finAnnual = (financials[s.code] || [])
      .filter(f => f.reportDate && f.reportDate.slice(5, 7) === '12' && f.noticeDate <= en)
      .sort((a, b) => a.noticeDate < b.noticeDate ? -1 : 1);
    panel[s.code] = { code: s.code, name: s.name, isRes: s.isResource, close: filled,
      events, finAnnual, finExempt: FIN_EXEMPT.has(s.code) };
  }
  return { dates, panel };
}

// 时点 t 的信号状态: knownAnnual(最近已公告年报 dps) + knownMid(其后最近中报 dps)
function signalState(panel, c, t){
  const p = panel[c];
  let knownAnnual = 0, knownMid = 0, lastAnnualPlan = null;
  for (const e of p.events){
    if (e.plan > t) break;
    if (e.rep.slice(5, 7) === '12'){ knownAnnual = e.dps; lastAnnualPlan = e.plan; }
    else if (lastAnnualPlan !== null && e.plan >= lastAnnualPlan){ knownMid = e.dps; }
    // 中报在最近年报之前 → 忽略(属于更早年度)
  }
  return { knownAnnual, knownMid };
}

// 5 年股息率百分位(0~100; 历史<126天返回 null)
function pctOf(dates, panel, c, d, yieldOf){
  const lo = dates[Math.max(0, dates.indexOf(d) - 1260)];   // ≈5 个交易日年
  const hist = [];
  for (const dd of dates){
    if (dd < lo) continue;
    if (dd > d) break;
    const y = yieldOf(panel, c, dd);
    if (y != null && y > 0) hist.push(y);
  }
  if (hist.length < 126) return null;
  const cur = yieldOf(panel, c, d);
  if (cur == null) return null;
  let below = 0; for (const h of hist) if (h < cur) below++;
  return below / hist.length * 100;
}

// 动量: 当前价 / 约 12 个月前(365 日历天)最近收盘价 - 1
function momoOf(panel, c, dates, d){
  const pxNow = panel[c].close[d];
  if (!pxNow) return 0;
  const dt = new Date(d + 'T00:00:00Z').getTime() - 365 * 86400000;
  const lo = new Date(dt).toISOString().slice(0, 10);
  let pxLo = null;
  for (const dd of dates){ if (dd > lo) break; const v = panel[c].close[dd]; if (v != null) pxLo = v; }
  if (!pxLo) return 0;
  return pxNow / pxLo - 1;
}

// ---------- v2 质量评分(point-in-time, 0~6) ----------
function qualityScore(panel, c, t, knownAnnual){
  const p = panel[c];
  // 最近已公告年报财务
  let fin = null;
  for (const f of p.finAnnual){ if (f.noticeDate <= t) fin = f; else break; }
  let score = 0;
  if (fin && fin.roe != null && fin.roe >= 8) score++;
  if (fin && fin.grossMargin != null && fin.grossMargin >= 15) score++;
  if (fin && fin.ocps != null && knownAnnual > 0 && fin.ocps >= knownAnnual) score++;
  if (p.finExempt || (fin && fin.debtRatio != null && fin.debtRatio <= 75)) score++;
  // 分红可持续性: 最近 3 个年度事件连续 + 未显著下滑(≥0.9×前年)
  const annuals = p.events.filter(e => e.rep.slice(5, 7) === '12' && e.plan <= t);
  const dpsSeq = annuals.map(e => e.dps);
  if (dpsSeq.length >= 3) score++;
  if (dpsSeq.length >= 2 && dpsSeq[dpsSeq.length - 1] >= dpsSeq[dpsSeq.length - 2] * 0.9) score++;
  return score;
}

// ---------- v2 模拟: 连续评分 + 质量 + 动量 + 最低仓位 + 季度 + 最小调仓, 成本同 v1 ----------
const COST_V1 = { commissionRate: 0.00025, minCommission: 5.0, stampRate: 0.001,
  stampRateNew: 0.0005, stampCutoff: '2023-08-28', slippage: 0.001, lotSize: 100,
  execDelay: 1, divDelay: 1 };

function simulateV2(dates, panel, V){
  const codes = Object.keys(panel);
  let cash = 1_000_000;
  const shares = {}; codes.forEach(c => shares[c] = 0);
  const n = dates.length;
  const pendingQ = [];          // 待复投分红 {dueIdx, c, amt}
  let pendingReb = null;        // [dueIdx, des]
  const eq = []; const weightsHist = [];
  let buyNotional = 0;

  // 季度再平衡日
  const rebDays = new Set(); let prevKey = null;
  for (const d of dates){
    const dt = new Date(d + 'T00:00:00Z');
    const key = dt.getUTCFullYear() * 4 + Math.floor(dt.getUTCMonth() / 3);
    if (key !== prevKey){ rebDays.add(d); prevKey = key; }
  }
  const dIdx = new Map(); dates.forEach((d, i) => dIdx.set(d, i));

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
        const buyPx = p * (1 + COST_V1.slippage);
        const lot = COST_V1.lotSize > 0 ? COST_V1.lotSize : 1;
        let tsh = Math.floor(tgtVal / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];
        if (tsh - shares[c] > 0) buys.push([c, tsh, (tsh - shares[c]) * buyPx]);
      } else {
        const sellPx = p * (1 - COST_V1.slippage);
        const tsh = sellPx > 0 ? tgtVal / sellPx : 0;
        if (tsh < shares[c] - 1e-9) sells.push([c, tsh, (shares[c] - tsh) * sellPx]);
      }
    }
    let feeBuy = 0; buys.forEach(([, , nl]) => feeBuy += Math.max(nl * COST_V1.commissionRate, COST_V1.minCommission));
    let feeSell = 0; sells.forEach(([, , nl]) => feeSell += Math.max(nl * COST_V1.commissionRate, COST_V1.minCommission) + nl * stampRate(d));
    const sellProc = sells.reduce((a, [, , nl]) => a + nl, 0);
    let buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    const budget = cash + sellProc - feeSell;
    if (buyCost > budget && buyCost > 0){
      const k = budget / buyCost;
      const buys2 = [];
      for (const [c] of buys){
        const p = px[c];
        const buyPx = p * (1 + COST_V1.slippage);
        const lot = COST_V1.lotSize > 0 ? COST_V1.lotSize : 1;
        const nb = tot * des[c] * k;
        let tsh = Math.floor(nb / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];
        if (tsh - shares[c] > 0) buys2.push([c, tsh, (tsh - shares[c]) * buyPx]);
      }
      buys.length = 0; buys2.forEach(b => buys.push(b));
      buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    }
    for (const [c, tsh, nl] of buys){
      const fee = Math.max(nl * COST_V1.commissionRate, COST_V1.minCommission);
      shares[c] = tsh; cash -= nl + fee; buyNotional += nl;
    }
    for (const [c, tsh, nl] of sells){
      const fee = Math.max(nl * COST_V1.commissionRate, COST_V1.minCommission) + nl * stampRate(d);
      shares[c] = tsh; cash += nl - fee;
    }
    let tot2 = cash; codes.forEach(c => tot2 += shares[c] * px[c]);
    if (tot2 > 0){
      const ws = {}; codes.forEach(c => ws[c] = (shares[c] * px[c]) / tot2);
      weightsHist.push([d, ws]);
    }
  }
  function stampRate(d){ return d >= COST_V1.stampCutoff ? COST_V1.stampRateNew : COST_V1.stampRate; }

  // 每只股的事件指针(planDate 驱动信号)与除息指针(DRIP)
  const evPtr = {}; codes.forEach(c => evPtr[c] = 0);

  let exposureSum = 0;    // 日股票仓位累计(算平均仓位)
  let qHits = 0, rebCount = 0, momoHits = 0;   // 质量/动量过滤触发统计
  for (let i = 0; i < n; i++){
    const d = dates[i];
    const px = {}; codes.forEach(c => px[c] = panel[c].close[d] || 0);
    // 1) DRIP 到期复投(计佣金+滑点, 与 v1 一致)
    if (COST_V1.divDelay >= 1){
      while (pendingQ.length && pendingQ[0].dueIdx <= i){
        const { c, amt } = pendingQ.shift();
        const buyPx = px[c] * (1 + COST_V1.slippage);
        if (buyPx > 0){
          const fee = Math.max(amt * COST_V1.commissionRate, COST_V1.minCommission);
          const invest = amt - fee;
          if (invest > 0){ shares[c] += invest / buyPx; }
          else { cash += amt; }
        } else { cash += amt; }
      }
    }
    // 2) 入账除息分红
    for (const c of codes){
      const evs = panel[c].events;
      while (evPtr[c] < evs.length && evs[evPtr[c]].ex <= d){
        const e = evs[evPtr[c]];
        if (shares[c] > 0){
          if (COST_V1.divDelay === 0 && px[c] > 0){
            const amt = shares[c] * e.dps;
            const buyPx = px[c] * (1 + COST_V1.slippage);
            const fee = Math.max(amt * COST_V1.commissionRate, COST_V1.minCommission);
            const invest = amt - fee;
            if (invest > 0){ shares[c] += invest / buyPx; }
            else { cash += amt; }
          } else {
            pendingQ.push({ dueIdx: i + COST_V1.divDelay, c, amt: shares[c] * e.dps });
          }
        }
        evPtr[c]++;
      }
    }
    // 3) 执行到期调仓
    if (pendingReb !== null && pendingReb[0] === i){ execReb(i, pendingReb[1]); pendingReb = null; }
    // 4) 信号日(季度): v2 决策
    if (rebDays.has(d)){
      let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
      if (tot > 0){
        const des = {};
        for (const c of codes){
          const p = px[c];
          if (!p || p <= 0){ des[c] = 0; continue; }
          const { knownAnnual, knownMid } = signalState(panel, c, d);
          const y = (knownAnnual + knownMid) / p * 100;
          // 连续评分: yield 连续映射
          const wy = Math.min(1, Math.max(0, (y - V.sellYield) / (V.buyYield - V.sellYield)));
          // 百分位连续打折
          const pct = pctOf(dates, panel, c, d, (panel_, cc, dd) => {
            const s = signalState(panel_, cc, dd);
            const pp = panel_[cc].close[dd];
            return (pp && (s.knownAnnual + s.knownMid) > 0) ? (s.knownAnnual + s.knownMid) / pp * 100 : null;
          });
          let wp = 0.5;
          if (!V.useNoPct && pct != null) wp = Math.min(1, Math.max(0, (pct - V.cheapPct) / (V.expensivePct - V.cheapPct)));
          const score = wy * (1 - 0.4 * wp);
          let w = V.minW + score * (V.maxW - V.minW);
          // 动量过滤
          const momo = momoOf(panel, c, dates, d);
          if (momo < V.momoFloor || momo < V.momoKill) momoHits++;
          if (momo < V.momoKill) w = 0;
          else if (momo < V.momoFloor) w *= 0.5;
          // 质量过滤
          const q = qualityScore(panel, c, d, knownAnnual);
          if (V.qualityMode !== 'none'){
            if (q < V.qualityScoreMin){
              qHits++;
              if (V.qualityMode === 'gate') w = 0;
              else if (V.qualityMode === 'penalty') w *= 0.5;
            }
          }
          des[c] = w;
        }
        rebCount++;
        // 最小调仓幅度
        for (const c of codes){
          const cur = (shares[c] * px[c]) / tot;
          if (Math.abs(des[c] - cur) < V.minTrade && des[c] !== 0 && cur > 0) des[c] = cur;
        }
        // 组合最低仓位: sum < minPosition → 按 yield 加权补足(跳过动量杀跌股; 动量弱/低质量股减半)
        let s = 0; codes.forEach(c => s += des[c]);
        let qualityHits = 0;
        if (s < V.minPosition){
          const ranked = codes.filter(c => des[c] > 0 && panel[c].close[d])
            .map(c => {
              const st = signalState(panel, c, d);
              const p = panel[c].close[d] || 1;
              const momo = momoOf(panel, c, dates, d);
              const q = qualityScore(panel, c, d, st.knownAnnual);
              if (V.qualityMode !== 'none' && q < V.qualityScoreMin) qualityHits++;
              return { c, y: (st.knownAnnual + st.knownMid) / p, momo, q };
            })
            .filter(x => x.momo >= V.momoKill)          // 跳过动量杀跌
            .sort((a, b) => b.y - a.y);
          let need = V.minPosition - s;
          for (const x of ranked){
            if (need <= 0) break;
            const weak = x.momo < V.momoFloor || (V.qualityMode !== 'none' && x.q < V.qualityScoreMin);
            const add = Math.min(need, V.maxW - des[x.c]) * (weak ? 0.5 : 1);
            des[x.c] += add; need -= add;
          }
        }
        s = 0; codes.forEach(c => s += des[c]);
        if (s > 1.0){ codes.forEach(c => des[c] /= s); }
        if (COST_V1.execDelay > 0){
          pendingReb = [Math.min(i + COST_V1.execDelay, n - 1), des];
        } else {
          execReb(i, des);
        }
      }
    }
    // 净值 + 仓位统计
    let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
    let pendSum = 0; for (const p of pendingQ) pendSum += p.amt;
    const val = tot + pendSum;
    const stockVal = codes.reduce((a, c) => a + shares[c] * px[c], 0);
    exposureSum += val > 0 ? stockVal / val : 0;
    eq.push([d, val]);
  }
  return { equity: eq, weights: weightsHist, buyNotional, avgExposure: exposureSum / n,
    qHits, rebCount, momoHits };
}

// ---------- v1 对照(纯档位, 用 v1 引擎) ----------
import { buildPanel, runStrategy, runBenchmark } from './backtest_engine.js';
const bundle = JSON.parse(readFileSync('backtest_bundle.json', 'utf8'));
const P_v1 = { usePercentile: false, buyYield: 5, sellYield: 3, lookbackYears: 5, maxWeight: 0.20,
  rebalance: 'month', drip: true, resourceExtra: true, initialCapital: 1_000_000 };
const czz = bundle.benchmarks.find(b => b.name.includes('中证红利'));

// ---------- 滚动样本外 ----------
function runOOS(V2, label){
  const winYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const rows = [];
  let qHits = 0, rebCount = 0, momoHits = 0;
  for (const y of winYears){
    const st = `${y}-01-01`;
    const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
    const { dates, panel } = buildPanelV2(st, en);
    if (!dates.length) continue;
    const r = simulateV2(dates, panel, V2);
    const m = metrics(r.equity, r.buyNotional);
    const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
    rows.push({ y, cagr: m.cagr, mdd: m.mdd, bm: bm.cagr, exp: r.avgExposure });
    qHits += r.qHits; rebCount += r.rebCount; momoHits += r.momoHits;
  }
  const n = rows.length;
  const avg = k => rows.reduce((a, r) => a + r[k], 0) / n;
  const winRate = rows.filter(r => r.cagr > r.bm).length / n;
  return { label, n, avgCagr: avg('cagr'), avgMdd: avg('mdd'), avgBm: avg('bm'),
    winRate, avgExp: avg('exp'), rows, qHitRate: rebCount ? qHits / rebCount : 0,
    momoHitRate: rebCount ? momoHits / rebCount : 0 };
}

const V2_BASE = {
  buyYield: 5, sellYield: 3, cheapPct: 30, expensivePct: 70,
  minW: 0, maxW: 0.20,              // 无底仓: 信号弱即现金, minPosition 下限才有意义
  momoLen: 365, momoFloor: -0.20, momoKill: -0.35,
  rebalance: 'quarter', minTrade: 0.01,
  qualityMode: 'penalty', qualityScoreMin: 4,
};

console.log('数据: financials 源 =', (FIN_META.source || '').slice(0, 60), '抓取 =', FIN_META.fetched_at || '');
console.log('v2 基线参数:', JSON.stringify(V2_BASE));
console.log('\n=== v2 滚动样本外(2016-2025 年度窗口, 参数冻结) ===');
console.log(`${'配置'.padEnd(22)}${'平均CAGR%'.padStart(10)}${'基准CAGR%'.padStart(10)}${'超额pp'.padStart(9)}${'胜率%'.padStart(7)}${'平均MDD%'.padStart(9)}${'平均仓位%'.padStart(9)}${'每仓效率'.padStart(9)}${'质量'.padStart(8)}${'动量'.padStart(8)}`);

const results = [];
for (const mp of [0.4, 0.6, 0.8]){
  const V = { ...V2_BASE, minPosition: mp };
  const r = runOOS(V, `v2 minPos=${(mp * 100).toFixed(0)}%`);
  results.push(r);
  console.log(`${r.label.padEnd(22)}${r.avgCagr.toFixed(2).padStart(10)}${r.avgBm.toFixed(2).padStart(10)}`
    + `${(r.avgCagr - r.avgBm).toFixed(2).padStart(9)}${(r.winRate * 100).toFixed(0).padStart(7)}`
    + `${r.avgMdd.toFixed(1).padStart(9)}${(r.avgExp * 100).toFixed(0).padStart(9)}`
    + `${(r.avgExp > 0 ? r.avgCagr / r.avgExp : 0).toFixed(2).padStart(9)}`);
}
// 组件拆解(在 minPos=40% 基础上逐一关停): 分离动量/质量/百分位的贡献
console.log('\n=== v2 组件拆解(基于 minPos=40%, 逐一关停) ===');
const baseV = { ...V2_BASE, minPosition: 0.4 };
const variants = [
  ['v2-full(全开)', baseV],
  [' 去动量', { ...baseV, momoFloor: -9, momoKill: -9 }],
  [' 去质量', { ...baseV, qualityMode: 'none' }],
  [' 去百分位', { ...baseV, useNoPct: true }],
];
const pctOn = (V) => !V.useNoPct;
// 说明: 百分位关停通过 wp=0.5 固定实现(在 simulateV2 内判断)
for (const [label, V] of variants){
  const r = runOOS(V, label);
  results.push(r);
  console.log(`${label.padEnd(22)}${r.avgCagr.toFixed(2).padStart(10)}${r.avgBm.toFixed(2).padStart(10)}`
    + `${(r.avgCagr - r.avgBm).toFixed(2).padStart(9)}${(r.winRate * 100).toFixed(0).padStart(7)}`
    + `${r.avgMdd.toFixed(1).padStart(9)}${(r.avgExp * 100).toFixed(0).padStart(9)}`
    + `${(r.avgExp > 0 ? r.avgCagr / r.avgExp : 0).toFixed(2).padStart(9)}`
    + `${('质量' + (r.qHitRate * 100).toFixed(0) + '%').padStart(8)}${('动量' + (r.momoHitRate * 100).toFixed(0) + '%').padStart(8)}`);
}
// v1 纯档位对照
{
  const winYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const rows = [];
  for (const y of winYears){
    const st = `${y}-01-01`;
    const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
    const { dates, panel } = buildPanel(bundle.stocks, st, en);
    const r = runStrategy(dates, panel, P_v1);
    const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
    rows.push({ y, cagr: r.metrics.cagr, mdd: r.metrics.mdd, bm: bm.cagr, exp: r.avgExposure });
  }
  const n = rows.length;
  const avg = k => rows.reduce((a, r) => a + r[k], 0) / n;
  const v1 = { label: 'v1纯档位(对照)', n, avgCagr: avg('cagr'), avgMdd: avg('mdd'), avgBm: avg('bm'),
    winRate: rows.filter(r => r.cagr > r.bm).length / n, avgExp: avg('exp'), rows, qHitRate: 0 };
  results.push(v1);
  console.log(`${v1.label.padEnd(22)}${v1.avgCagr.toFixed(2).padStart(10)}${v1.avgBm.toFixed(2).padStart(10)}`
    + `${(v1.avgCagr - v1.avgBm).toFixed(2).padStart(9)}${(v1.winRate * 100).toFixed(0).padStart(7)}`
    + `${v1.avgMdd.toFixed(1).padStart(9)}${(v1.avgExp * 100).toFixed(0).padStart(9)}`
    + `${(v1.avgExp > 0 ? v1.avgCagr / v1.avgExp : 0).toFixed(2).padStart(9)}`);
}

console.log('\n=== 各配置逐年明细(纯档位CAGR% vs 基准CAGR%) ===');
for (const r of results){
  const detail = r.rows.map(x => `${x.y}:${x.cagr.toFixed(1)}/${x.bm.toFixed(1)}`).join(' ');
  console.log(`${r.label.padEnd(22)} ${detail}`);
}

console.log('\n说明: 平均仓位 = 日均股票市值/总净值(区分 beta 与 alpha 的关键);');
console.log('收益上升若伴随仓位同向上升 → 主要由暴露(beta)驱动, 不视为 alpha 改善。');
process.exit(0);
