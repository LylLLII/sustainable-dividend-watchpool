// ============================================================
// experiment_v3.mjs — v3.3 候选池内横截面排名轮换 (第13轮评审收紧版)
//
// v3.3 修复(相对 v3.2, 第13轮评审 3 项非阻断 + 之前轮次全部保留):
//   1) 控制台版本号与报告/校验器统一为 v3.3
//   2) 导出 KLINE 供校验器做键集合一致性与真实日历日期断言
//
// v3.2 详细修复清单(第12轮评审 7 项, 全部保留):
//   a) 买入资格与持仓退出资格分离(评审#1):
//      - minEntryYield=5% 只约束新买入候选池
//      - 旧持仓 y∈[sellYield,minEntryYield) 且质量合格 → 按退出线保留(不再直接消失)
//      - 旧持仓仍≥买入线时按排名缓冲(N+buffer)保留; 跌破卖出线或质量失效才退出
//      - sellRuleKeeps 统计证明退出资格独立生效
//   b) 承接率按实际成交后净现金(评审#2):
//      - 统计移到执行循环: 卖出=扣佣金+印花税后的实际到账净现金;
//      - 新进入股=预算缩放后实际成交额; 仅当本次实际发生卖出时计入分母
//      - 排除初始建仓(无卖出自然不计)/加仓/分红复投(pendingQ 路径天然排除)
//   c) 目标仓位断言与钳制(评审#3):
//      - 最终 des 形成后: sum≤1 归一化 + 单票≤maxWeight 钳制 + 断言(超限 throw)
//      - maxDesSum 记录供校验器断言
//   d) 行业补位(评审#4): 默认删除不补位(明确声明"最多6只,行业约束后允许现金");
//      变体 industryBackfill=true 测试删除后补位
//   e) 进出统计移到实际成交日(评审#5): entryQ 记录 execReb 成交日季度
//   f) 模块化导出: isMain 守卫, 供 validate_v3.mjs 导入做专用断言(评审#3)
//
// 数据: v3data/(中证红利 99 只) + data/components_industry.json(申万一级行业)
// 评估: 滚动样本外 2016-2025 × 10 窗口, 参数冻结, 成本同 v1。
// ============================================================

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { metrics } from './backtest_engine.js';

const KLINE = JSON.parse(readFileSync('v3data/kline.json', 'utf8'));
const DIVS = JSON.parse(readFileSync('v3data/divs.json', 'utf8')).divs || {};
const FIN = JSON.parse(readFileSync('v3data/fin.json', 'utf8')).fin || {};
const INDUSTRY = JSON.parse(readFileSync('data/components_industry.json', 'utf8')).industry || {};
const INCLUDES = KLINE.include || {};
const NAMES = KLINE.names || {};
export { INDUSTRY, INCLUDES, KLINE };
const END = JSON.parse(readFileSync('backtest_bundle.json', 'utf8')).meta.end;

const COST = { commissionRate: 0.00025, minCommission: 5.0, stampRate: 0.001,
  stampRateNew: 0.0005, stampCutoff: '2023-08-28', slippage: 0.001, lotSize: 100,
  execDelay: 1, divDelay: 1 };
const FIN_EXEMPT = new Set(['sh601398', 'sh601939', 'sh601288', 'sh601988', 'sh601328',
  'sh601166', 'sh601818', 'sh601009', 'sh601169', 'sh601229', 'sh601997', 'sh601963',
  'sh601187', 'sh601916', 'sh601825', 'sh601658', 'sh600919', 'sh601077', 'sh600015', 'sh600016', 'sh601998']);

function stampRate(d){ return d >= COST.stampCutoff ? COST.stampRateNew : COST.stampRate; }
function normDate(s){ return String(s || '').replace(/\//g, '-'); }
function quarterKey(d){ const dt = new Date(d + 'T00:00:00Z'); return dt.getUTCFullYear() * 4 + Math.floor(dt.getUTCMonth() / 3); }

// 纳入日期标准化 + 断言
const incNorm = {};
for (const [code, inc] of Object.entries(INCLUDES)) incNorm[code] = normDate(inc);
for (const [code, inc] of Object.entries(incNorm)){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inc)){
    console.error(`[断言失败] 纳入日期格式非法: ${code} -> ${inc}`); process.exit(1);
  }
}

export function buildPanelV3(st, en){
  const allDates = new Set();
  const parsed = {};
  for (const code of Object.keys(KLINE.kline)){
    const kl = (KLINE.kline[code] || []).filter(r => r[0] >= st && r[0] <= en);
    for (const [d] of kl) allDates.add(d);
    parsed[code] = kl;
  }
  const dates = [...allDates].sort();
  const panel = {};
  for (const code of Object.keys(parsed)){
    const closes = {}; for (const [d, c] of parsed[code]) closes[d] = c;
    const filled = {}; let last = null;
    for (const d of dates){ if (d in closes) last = closes[d]; filled[d] = last; }
    const events = (DIVS[code] || [])
      .map(e => ({ ex: e.exDate, dps: e.dps, rep: e.reportDate || '', plan: e.planDate || e.exDate }))
      .filter(e => e.plan <= en)
      .sort((a, b) => a.plan < b.plan ? -1 : 1);
    const finAll = (FIN[code] || [])
      .filter(f => f.noticeDate <= en)
      .sort((a, b) => a.noticeDate < b.noticeDate ? -1 : 1);
    panel[code] = { code, name: NAMES[code] || code, close: filled, events, finAll,
      include: incNorm[code] || '2000-01-01', ind: INDUSTRY[code] || '其他',
      finExempt: FIN_EXEMPT.has(code) };
  }
  return { dates, panel };
}

function signalState(panel, c, t){
  let knownAnnual = 0, knownMid = 0, lastAnnualPlan = null;
  for (const e of panel[c].events){
    if (e.plan > t) break;
    if (e.rep.slice(5, 7) === '12'){ knownAnnual = e.dps; lastAnnualPlan = e.plan; }
    else if (lastAnnualPlan !== null && e.plan >= lastAnnualPlan){ knownMid = e.dps; }
  }
  return { knownAnnual, knownMid };
}
function finAt(panel, c, t){
  let f = null;
  for (const x of panel[c].finAll){
    if (x.noticeDate <= t && x.reportDate.slice(5, 7) === '12') f = x;
    else if (x.noticeDate > t) break;
  }
  return f;
}
function qualityScore(panel, c, t){
  const p = panel[c];
  const f = finAt(panel, c, t);
  const { knownAnnual } = signalState(panel, c, t);
  let score = 0;
  if (f && f.roe != null && f.roe >= 8) score++;
  if (f && f.grossMargin != null && f.grossMargin >= 15) score++;
  if (f && f.ocps != null && knownAnnual > 0 && f.ocps >= knownAnnual) score++;
  if (p.finExempt || (f && f.debtRatio != null && f.debtRatio <= 75)) score++;
  const seq = p.events.filter(e => e.rep.slice(5, 7) === '12' && e.plan <= t).map(e => e.dps);
  if (seq.length >= 3) score++;
  if (seq.length >= 2 && seq[seq.length - 1] >= seq[seq.length - 2] * 0.9) score++;
  return score;
}
function stabScore(panel, c, t){
  const seq = panel[c].events.filter(e => e.rep.slice(5, 7) === '12' && e.plan <= t).map(e => e.dps);
  let s = 0;
  if (seq.length >= 3) s++;
  if (seq.length >= 2 && seq[seq.length - 1] >= seq[seq.length - 2] * 0.9) s++;
  return s;
}
function pePct(dates, panel, c, d){
  const eps = finAt(panel, c, d)?.eps;
  if (!eps || eps <= 0) return 50;
  const cur = panel[c].close[d];
  if (!cur) return 50;
  const curPE = cur / eps;
  const loIdx = Math.max(0, dates.indexOf(d) - 1260);
  const hist = [];
  for (let i = loIdx; i < dates.length; i++){
    const dd = dates[i];
    if (dd > d) break;
    const px = panel[c].close[dd];
    const e = finAt(panel, c, dd)?.eps;
    if (px && e && e > 0) hist.push(px / e);
  }
  if (hist.length < 126) return 50;
  let below = 0; for (const h of hist) if (h < curPE) below++;
  return below / hist.length * 100;
}

export function simulateV3(dates, panel, V){
  const codes = Object.keys(panel);
  let cash = 1_000_000;
  const shares = {}; codes.forEach(c => shares[c] = 0);
  const n = dates.length;
  const pendingQ = [];
  let pendingReb = null;
  const eq = []; const weightsHist = [];
  let buyNotional = 0;
  let exposureSum = 0;
  let maxDesSum = 0;            // v3.2: 目标仓位总和峰值(供断言)
  let sellRuleKeeps = 0;        // v3.2: 因退出线独立保留的旧持仓次数(资格分离证明)
  // v3.3: 现金流账本(现金守恒断言) + 行业暴露统计
  let sumSellNet = 0, sumBuyCost = 0, sumDivCash = 0, sumDivInvest = 0;
  let buysNewTotal = 0;         // 新进入股实际成交总额(承接内部一致性)
  let maxIndCount = 0;          // 任一时刻单行业实际持仓数峰值
  const yearlyIndExp = {};      // year -> { ind: 日均权重累计 }
  const yrDays = {};            // year -> 交易日数

  const rebDays = new Set(); let prevKey = null;
  for (const d of dates){
    const qk = quarterKey(d);
    if (qk !== prevKey){ rebDays.add(d); prevKey = qk; }
  }

  // 轮换统计(v3.2: 全部按实际成交日)
  const entryQ = {};            // code -> 进入季度 key
  let totalEnters = 0, totalExits = 0;
  let holdingQSum = 0, exitsWithQ = 0;   // 已完成退出样本的持仓季度
  let sellTotal = 0, reuseMatched = 0;   // 实际成交净现金累计

  let prevHoldings = new Set();

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
        const buyPx = p * (1 + COST.slippage);
        const lot = COST.lotSize > 0 ? COST.lotSize : 1;
        let tsh = Math.floor(tgtVal / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];
        if (tsh - shares[c] > 0) buys.push([c, tsh, (tsh - shares[c]) * buyPx]);
      } else {
        const sellPx = p * (1 - COST.slippage);
        const tsh = sellPx > 0 ? tgtVal / sellPx : 0;
        if (tsh < shares[c] - 1e-9) sells.push([c, tsh, (shares[c] - tsh) * sellPx]);
      }
    }
    let feeBuy = 0; buys.forEach(([, , nl]) => feeBuy += Math.max(nl * COST.commissionRate, COST.minCommission));
    let feeSell = 0; sells.forEach(([, , nl]) => feeSell += Math.max(nl * COST.commissionRate, COST.minCommission) + nl * stampRate(d));
    const sellProc = sells.reduce((a, [, , nl]) => a + nl, 0);
    let buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    const budget = cash + sellProc - feeSell;
    if (buyCost > budget && buyCost > 0){
      const k = budget / buyCost;
      const buys2 = [];
      for (const [c] of buys){
        const p = px[c];
        const buyPx = p * (1 + COST.slippage);
        const lot = COST.lotSize > 0 ? COST.lotSize : 1;
        const nb = tot * des[c] * k;
        let tsh = Math.floor(nb / buyPx / lot) * lot;
        if (tsh < shares[c]) tsh = shares[c];
        if (tsh - shares[c] > 0) buys2.push([c, tsh, (tsh - shares[c]) * buyPx]);
      }
      buys.length = 0; buys2.forEach(b => buys.push(b));
      buyCost = buys.reduce((a, [, , nl]) => a + nl, 0) + feeBuy;
    }
    // v3.2: 执行实际成交, 同步统计承接(评审#2: 扣费后净现金 + 缩放后实际买入)
    let reuseSellNow = 0, reuseBuyNewNow = 0;
    for (const [c, tsh, nl] of buys){
      const fee = Math.max(nl * COST.commissionRate, COST.minCommission);
      const wasZero = shares[c] < 1e-6;
      shares[c] = tsh; cash -= nl + fee; buyNotional += nl;
      sumBuyCost += nl + fee;
      if (wasZero && shares[c] >= 1e-6){ reuseBuyNewNow += nl; buysNewTotal += nl; }  // 实际新进入成交额
    }
    for (const [c, tsh, nl] of sells){
      const fee = Math.max(nl * COST.commissionRate, COST.minCommission) + nl * stampRate(d);
      shares[c] = tsh; cash += nl - fee;
      reuseSellNow += nl - fee;                                  // 实际卖出净现金(扣佣金+印花税)
      sumSellNet += nl - fee;
    }
    if (reuseSellNow > 0){                                       // 本次实际发生卖出才计入分母
      sellTotal += reuseSellNow;
      reuseMatched += Math.min(reuseSellNow, reuseBuyNewNow);
    }
    // v3.2: 进出统计在成交日(评审#5), 按实际持仓集合
    const newHoldings = new Set(codes.filter(c => shares[c] > 1e-6));
    for (const c of newHoldings){
      if (!prevHoldings.has(c)){ totalEnters++; entryQ[c] = quarterKey(d); }
    }
    for (const c of prevHoldings){
      if (!newHoldings.has(c)){
        totalExits++;
        if (entryQ[c] !== undefined){ holdingQSum += quarterKey(d) - entryQ[c] + 1; exitsWithQ++; }
        delete entryQ[c];
      }
    }
    prevHoldings = newHoldings;
    // v3.3: 单行业实际持仓上限断言(评审: 校验"实际持仓"而非目标持仓)
    if (V.maxPerIndustry > 0){
      const indCnt = {};
      for (const c of newHoldings){ const ind = panel[c].ind; indCnt[ind] = (indCnt[ind] || 0) + 1; }
      for (const ind of Object.keys(indCnt)){
        if (indCnt[ind] > V.maxPerIndustry){
          throw new Error(`v3.3 单行业实际持仓断言失败 ${ind}=${indCnt[ind]} > ${V.maxPerIndustry}`);
        }
        if (indCnt[ind] > maxIndCount) maxIndCount = indCnt[ind];
      }
    }
    let tot2 = cash; codes.forEach(c => tot2 += shares[c] * px[c]);
    if (tot2 > 0){
      const ws = {}; codes.forEach(c => ws[c] = (shares[c] * px[c]) / tot2);
      weightsHist.push([d, ws]);
    }
  }

  const evPtr = {}; codes.forEach(c => evPtr[c] = 0);

  for (let i = 0; i < n; i++){
    const d = dates[i];
    const px = {}; codes.forEach(c => px[c] = panel[c].close[d] || 0);
    if (COST.divDelay >= 1){
      while (pendingQ.length && pendingQ[0].dueIdx <= i){
        const { c, amt } = pendingQ.shift();
        const buyPx = px[c] * (1 + COST.slippage);
        if (buyPx > 0){
          const fee = Math.max(amt * COST.commissionRate, COST.minCommission);
          const invest = amt - fee;
          if (invest > 0){ shares[c] += invest / buyPx; sumDivInvest += amt; }
          else { cash += amt; }
        } else { cash += amt; }
      }
    }
    for (const c of codes){
      const evs = panel[c].events;
      while (evPtr[c] < evs.length && evs[evPtr[c]].ex <= d){
        const e = evs[evPtr[c]];
        if (shares[c] > 0){
          const amt = shares[c] * e.dps;
          sumDivCash += amt;
          if (COST.divDelay === 0 && px[c] > 0){
            const buyPx = px[c] * (1 + COST.slippage);
            const fee = Math.max(amt * COST.commissionRate, COST.minCommission);
            const invest = amt - fee;
            if (invest > 0){ shares[c] += invest / buyPx; sumDivInvest += amt; }
            else { cash += amt; }
          } else {
            pendingQ.push({ dueIdx: i + COST.divDelay, c, amt });
          }
        }
        evPtr[c]++;
      }
    }
    if (pendingReb !== null && pendingReb[0] === i){ execReb(i, pendingReb[1]); pendingReb = null; }

    if (rebDays.has(d)){
      let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
      if (tot > 0){
        // v3.2: 买入资格 = 可投资 + y>=minEntryYield + 质量硬筛(仅约束新买入)
        const cands = [];
        for (const c of codes){
          if (!px[c] || px[c] <= 0) continue;
          if (panel[c].include > d) continue;
          const { knownAnnual, knownMid } = signalState(panel, c, d);
          const y = (knownAnnual + knownMid) / px[c] * 100;
          if (y < V.minEntryYield) continue;
          const q = qualityScore(panel, c, d);
          if (q < V.qualityScoreMin) continue;
          cands.push({ c, y, q, st: stabScore(panel, c, d) });
        }
        const scored = cands.map(x => {
          const peP = pePct(dates, panel, x.c, d);
          const valN = 1 - peP / 100;
          const score = V.wYield * Math.min(1, x.y / V.yieldCap) + V.wVal * valN
            + V.wStab * (x.st / 2) + V.wQual * (x.q / 6);
          return { ...x, score };
        }).sort((a, b) => b.score - a.score);
        const rankOf = {}; scored.forEach((x, idx) => rankOf[x.c] = idx + 1);

        const holdings = new Set();
        for (const x of scored) if (rankOf[x.c] <= V.N) holdings.add(x.c);
        // v3.2: 退出资格与买入资格分离(评审#1):
        //   a) 旧持仓仍≥买入线: 排名≤N+buffer 保留(缓冲)
        //   b) 旧持仓 y∈[sellYield,minEntryYield): 只要质量合格即保留(退出线独立生效)
        //   c) y<sellYield 或质量失效: 退出
        for (const c of prevHoldings){
          if (holdings.has(c)) continue;
          const { knownAnnual, knownMid } = signalState(panel, c, d);
          const y = (knownAnnual + knownMid) / (px[c] || 1) * 100;
          const q = qualityScore(panel, c, d);
          if (q < V.qualityScoreMin) continue;      // 质量失效 → 退出
          if (y < V.sellYield) continue;            // 跌破卖出线 → 退出
          const r = rankOf[c];
          if (r !== undefined && r <= V.N + V.buffer){
            holdings.add(c);                        // 缓冲区内保留
          } else if (r === undefined && y < V.minEntryYield){
            holdings.add(c); sellRuleKeeps++;       // 退出资格独立生效(跌破买入线但≥卖出线)
          }
        }
        // 行业上限: 默认删除不补位(主配置语义: 最多N只, 行业约束后允许现金)
        if (V.maxPerIndustry > 0){
          const indCount = {};
          for (const c of holdings){ const ind = panel[c].ind; indCount[ind] = (indCount[ind] || 0) + 1; }
          for (const ind of Object.keys(indCount)){
            if (indCount[ind] > V.maxPerIndustry){
              const members = [...holdings].filter(c => panel[c].ind === ind)
                .sort((a, b) => (rankOf[a] || 999) - (rankOf[b] || 999));
              for (const c of members.slice(V.maxPerIndustry)) holdings.delete(c);
            }
          }
          // v3.2: 行业补位变体(评审#4): 删除后按 scored 排名补入未持有且行业未超限者
          if (V.industryBackfill && holdings.size < V.N){
            const indCount2 = {};
            for (const c of holdings){ const ind = panel[c].ind; indCount2[ind] = (indCount2[ind] || 0) + 1; }
            for (const x of scored){
              if (holdings.size >= V.N) break;
              if (holdings.has(x.c)) continue;
              const ind = panel[x.c].ind;
              if ((indCount2[ind] || 0) >= V.maxPerIndustry) continue;
              holdings.add(x.c); indCount2[ind] = (indCount2[ind] || 0) + 1;
            }
          }
        }
        // 持仓集合内等权(含缓冲) → 目标仓位恒 ≤100%
        const w = holdings.size > 0 ? 1 / holdings.size : 0;
        const des = {};
        for (const c of codes) des[c] = holdings.has(c) ? Math.min(w, V.maxWeight) : 0;
        for (const c of codes){
          const cur = (shares[c] * px[c]) / tot;
          if (Math.abs(des[c] - cur) < V.minTrade && des[c] !== 0 && cur > 0) des[c] = cur;
        }
        // v3.2: 目标仓位钳制+断言(评审#3): sum≤1 / 单票≤maxWeight / 无隐性杠杆
        let sumDes = 0; for (const c of codes) sumDes += des[c];
        if (sumDes > 1 + 1e-9){ for (const c of codes) des[c] /= sumDes; sumDes = 1; }
        let over = false;
        for (const c of codes){ if (des[c] > V.maxWeight + 1e-9){ des[c] = V.maxWeight; over = true; } }
        if (over){
          sumDes = 0; for (const c of codes) sumDes += des[c];
          if (sumDes > 1 + 1e-9){ for (const c of codes) des[c] /= sumDes; sumDes = 1; }
        }
        for (const c of codes){
          if (des[c] > V.maxWeight + 1e-6 || des[c] < -1e-9){
            throw new Error(`v3.2 目标仓位断言失败 ${c}=${des[c].toFixed(4)} > ${V.maxWeight}`);
          }
        }
        sumDes = 0; for (const c of codes) sumDes += des[c];
        if (sumDes > 1 + 1e-6) throw new Error(`v3.2 目标仓位总和断言失败 ${sumDes.toFixed(4)} > 1`);
        if (sumDes > maxDesSum) maxDesSum = sumDes;
        if (COST.execDelay > 0){
          pendingReb = [Math.min(i + COST.execDelay, n - 1), des];
        } else {
          execReb(i, des);
        }
      }
    }
    let tot = cash; codes.forEach(c => tot += shares[c] * px[c]);
    let pendSum = 0; for (const p of pendingQ) pendSum += p.amt;
    const val = tot + pendSum;
    const stockVal = codes.reduce((a, c) => a + shares[c] * px[c], 0);
    exposureSum += val > 0 ? stockVal / val : 0;
    // v3.3: 逐年行业暴露(日均股票市值/净值)
    const yr = d.slice(0, 4);
    yrDays[yr] = (yrDays[yr] || 0) + 1;
    if (val > 0){
      const indW = yearlyIndExp[yr] || (yearlyIndExp[yr] = {});
      for (const c of codes){
        if (shares[c] > 0){
          const ind = panel[c].ind;
          indW[ind] = (indW[ind] || 0) + (shares[c] * px[c]) / val;
        }
      }
    }
    eq.push([d, val]);
  }
  // 归一化行业暴露为年均
  const yearlyExposure = {};
  for (const y of Object.keys(yearlyIndExp)){
    const cnt = yrDays[y] || 1;
    const out = {};
    for (const ind of Object.keys(yearlyIndExp[y])) out[ind] = yearlyIndExp[y][ind] / cnt;
    yearlyExposure[y] = out;
  }
  let pendingEnd = 0; for (const p of pendingQ) pendingEnd += p.amt;
  return { equity: eq, weights: weightsHist, buyNotional, avgExposure: exposureSum / n,
    totalEnters, totalExits, avgHoldingQ: exitsWithQ ? holdingQSum / exitsWithQ : 0,
    reuseMatched, sellTotal, reusePct: sellTotal > 0 ? reuseMatched / sellTotal : 0,
    maxDesSum, sellRuleKeeps, sumSellNet, sumBuyCost, sumDivCash, sumDivInvest,
    buysNewTotal, maxIndCount, yearlyExposure, pendingEnd, finalCash: cash };
}

import { buildPanel, runStrategy, runBenchmark } from './backtest_engine.js';
const bundle = JSON.parse(readFileSync('backtest_bundle.json', 'utf8'));
const czz = bundle.benchmarks.find(b => b.name.includes('中证红利'));

// 主配置(冻结, 第11轮评审; 第12轮评审#6: 属"看到结果后确定的冻结配置",
// 用于未来测试, 不追溯消除既有选择偏差 — 见报告措辞)
export const V3_MAIN = {
  N: 6, buffer: 3, minEntryYield: 5, sellYield: 3, yieldCap: 6,
  wYield: 0.35, wVal: 0.25, wStab: 0.20, wQual: 0.20,
  qualityScoreMin: 4, maxWeight: 0.20, minTrade: 0.01, maxPerIndustry: 3,
  industryBackfill: false,
};

export function runOOS(V3, label){
  const winYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  const rows = [];
  let enters = 0, exits = 0;
  let reuseMatched = 0, sellTotal = 0, hqSum = 0, hqN = 0;
  for (const y of winYears){
    const st = `${y}-01-01`;
    const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
    const { dates, panel } = buildPanelV3(st, en);
    if (!dates.length) continue;
    const r = simulateV3(dates, panel, V3);
    const m = metrics(r.equity, r.buyNotional);
    const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
    rows.push({ y, cagr: m.cagr, mdd: m.mdd, bm: bm.cagr, exp: r.avgExposure });
    enters += r.totalEnters; exits += r.totalExits;
    reuseMatched += r.reuseMatched; sellTotal += r.sellTotal;
    hqSum += r.avgHoldingQ * (r.totalExits || 0); hqN += r.totalExits;
  }
  const n = rows.length;
  const avg = k => rows.reduce((a, r) => a + r[k], 0) / n;
  const winRate = rows.filter(r => r.cagr > r.bm).length / n;
  return { label, n, avgCagr: avg('cagr'), avgMdd: avg('mdd'), avgBm: avg('bm'),
    winRate, avgExp: avg('exp'), rows, enters, exits,
    avgHoldingQ: hqN ? hqSum / hqN : 0,
    reusePct: sellTotal > 0 ? reuseMatched / sellTotal : 0 };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain){
  console.log('=== v3.3 候选池轮换(第13轮评审收紧版) ===');
  console.log(`主配置: N=${V3_MAIN.N} buffer=${V3_MAIN.buffer} minEntryYield=${V3_MAIN.minEntryYield}% `
    + `sellYield=${V3_MAIN.sellYield}% 质量≥${V3_MAIN.qualityScoreMin} 行业≤${V3_MAIN.maxPerIndustry} `
    + `(删除不补位) 等权(含缓冲,≤100%)`);
  console.log(`${'配置'.padEnd(28)}${'平均CAGR%'.padStart(10)}${'基准CAGR%'.padStart(10)}${'超额pp'.padStart(9)}${'胜率%'.padStart(7)}${'平均MDD%'.padStart(9)}${'仓位%'.padStart(7)}${'每仓效率'.padStart(9)}${'新进'.padStart(6)}${'退出'.padStart(6)}${'持有期(季)'.padStart(10)}${'匹配%(实成)'.padStart(10)}`);

  const results = [];
  function printRow(r){
    console.log(`${r.label.padEnd(28)}${r.avgCagr.toFixed(2).padStart(10)}${r.avgBm.toFixed(2).padStart(10)}`
      + `${(r.avgCagr - r.avgBm).toFixed(2).padStart(9)}${(r.winRate * 100).toFixed(0).padStart(7)}`
      + `${r.avgMdd.toFixed(1).padStart(9)}${(r.avgExp * 100).toFixed(0).padStart(7)}`
      + `${(r.avgExp > 0 ? r.avgCagr / r.avgExp : 0).toFixed(2).padStart(9)}`
      + `${String(r.enters).padStart(6)}${String(r.exits).padStart(6)}${r.avgHoldingQ.toFixed(1).padStart(12)}${(r.reusePct * 100).toFixed(0).padStart(10)}`);
  }

  // 主配置(冻结)
  const main = runOOS(V3_MAIN, '主配置(冻结)');
  results.push(main); printRow(main);

  // 敏感性变体(仅展示, 不用于结论)
  for (const [lbl, V] of [
    [' 变体: 行业补位', { ...V3_MAIN, industryBackfill: true }],
    [' 变体: 无行业上限', { ...V3_MAIN, maxPerIndustry: 0 }],
    [' 变体: minEntry=3%', { ...V3_MAIN, minEntryYield: 3 }],
    [' 变体: N=8', { ...V3_MAIN, N: 8 }],
    [' 变体: 质量≥5', { ...V3_MAIN, qualityScoreMin: 5 }],
    [' 变体: 无缓冲', { ...V3_MAIN, buffer: 0 }],
  ]){
    const r = runOOS(V, lbl);
    results.push(r); printRow(r);
  }
  // v1 对照
  {
    const winYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const rows = [];
    for (const y of winYears){
      const st = `${y}-01-01`;
      const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
      const { dates, panel } = buildPanel(bundle.stocks, st, en);
      const r = runStrategy(dates, panel, { usePercentile: false, buyYield: 5, sellYield: 3,
        lookbackYears: 5, maxWeight: 0.20, rebalance: 'month', drip: true, resourceExtra: true,
        initialCapital: 1_000_000 });
      const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
      rows.push({ y, cagr: r.metrics.cagr, mdd: r.metrics.mdd, bm: bm.cagr, exp: r.avgExposure });
    }
    const n = rows.length;
    const avg = k => rows.reduce((a, r) => a + r[k], 0) / n;
    const v1 = { label: 'v1纯档位(对照)', n, avgCagr: avg('cagr'), avgMdd: avg('mdd'), avgBm: avg('bm'),
      winRate: rows.filter(r => r.cagr > r.bm).length / n, avgExp: avg('exp'), rows,
      enters: 0, exits: 0, avgHoldingQ: 0, reusePct: 0 };
    results.push(v1); printRow(v1);
  }

  console.log('\n=== 逐年明细(主配置) ===');
  console.log(main.rows.map(x => `${x.y}:${x.cagr.toFixed(1)}/${x.bm.toFixed(1)}`).join(' '));
  console.log('\n说明: 持有期(季)=按实际成交日季度的已完成退出样本平均持有期;');
  console.log('匹配%(实成)=实际成交匹配率: 逐次调仓 min(卖出净现金-费用, 新进入股实际成交额)/卖出净现金总额。');
  console.log('注意: 匹配率证明订单规模匹配, 非逐笔现金来源账本(不证明某笔卖出流入某只新股票)。');
  console.log('主配置为冻结配置(非事前预注册, 见报告); 变体仅敏感性参考。');
  process.exit(0);
}
