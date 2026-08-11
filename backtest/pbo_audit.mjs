// ============================================================
// pbo_audit.mjs — PBO + 选择偏差审计 (第16轮路线1, 评审第12-15轮基线之上)
//
// 目的: 检验"从已测试的 6 个变体中选最优结果"是否导致样本外失效。
// 方法: CSCV (Bailey, Borwein, López de Prado & Zhu 2017, "The Probability
//       of Backtest Overfitting")。输入 6 变体 × 10 窗口的逐窗口净超额收益矩阵,
//       将 10 窗口按 C(10,5)=252 种互补划分成 IS/OOS, 每划分在 IS 选最优变体,
//       统计其在 OOS 表现低于全变体中位数的比例 = PBO。
//
// PBO 的正确解读(用户指定):
//   不是 "+4.20pp 有多大概率是过拟合"的精确概率, 而是
//   "在 6 候选变体 × 10 窗口下, IS 选出的最优方案在 OOS 落后或失效的概率"。
//   仅 6 个变体 → 会低估未测试参数组合的过拟合风险。
//
// 输出(用户指定 6 项):
//   1) 6×10 逐窗口净超额收益矩阵 (+主配置冻结对照行)
//   2) CSCV 样本内选优与样本外表现
//   3) PBO、样本外超额中位数、超额为负的比例
//   4) 各变体排名稳定性(平均排名/std + 前5/后5窗口 Spearman)
//   5) 样本量声明(10 窗口、变体集合不完整)
//   6) 冻结当前主配置, 不根据 PBO 结果重新挑参数
// ============================================================

import { readFileSync } from 'node:fs';
import { buildPanelV3, simulateV3, V3_MAIN } from './experiment_v3.mjs';
import { metrics, runBenchmark } from './backtest_engine.js';

const bundle = JSON.parse(readFileSync('backtest_bundle.json', 'utf8'));
const czz = bundle.benchmarks.find(b => b.name.includes('中证红利'));
const END = '2026-08-07';
const WIN_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// 候选配置: 6 个变体(参与 CSCV 选优) + 主配置(冻结基线, 不参与选优, 单独对照)
const VARIANTS = [
  ['行业补位', { ...V3_MAIN, industryBackfill: true }],
  ['无行业上限', { ...V3_MAIN, maxPerIndustry: 0 }],
  ['minEntry=3%', { ...V3_MAIN, minEntryYield: 3 }],
  ['N=8', { ...V3_MAIN, N: 8 }],
  ['质量≥5', { ...V3_MAIN, qualityScoreMin: 5 }],
  ['无缓冲', { ...V3_MAIN, buffer: 0 }],
];
const MAIN = ['主配置(冻结)', { ...V3_MAIN }];

// ---------- 1) 构建逐窗口矩阵 ----------
function buildMatrix(configs){
  const excess = {};      // label -> {year: excessCagr}
  const absRet = {};      // label -> {year: cagr}
  for (const [label, V] of configs){
    excess[label] = {}; absRet[label] = {};
    for (const y of WIN_YEARS){
      const st = `${y}-01-01`;
      const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
      const { dates, panel } = buildPanelV3(st, en);
      if (!dates.length) continue;
      const r = simulateV3(dates, panel, V);
      const m = metrics(r.equity, r.buyNotional);
      const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
      excess[label][y] = m.cagr - bm.cagr;
      absRet[label][y] = m.cagr;
    }
  }
  return { excess, absRet };
}

// ---------- 工具 ----------
function mean(xs){ return xs.reduce((a, b) => a + b, 0) / xs.length; }
function combos(arr, k){
  const out = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true){
    out.push(idx.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}
function rankOf(xs){
  const sorted = [...xs].map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const r = new Array(xs.length);
  sorted.forEach(([, i], rank) => r[i] = rank + 1);
  return r;
}
function spearman(a, b){
  const ra = rankOf(a), rb = rankOf(b);
  const n = a.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++){
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2;
  }
  return da * db > 0 ? num / Math.sqrt(da * db) : NaN;
}

// ---------- 2) CSCV ----------
function cscv(excess, configLabels){
  const years = WIN_YEARS;
  const N = configLabels.length;
  const S = Math.floor(years.length / 2);
  const isSets = combos(years, S);        // C(10,5) = 252
  let pboCount = 0;
  const oosExcessOfIsWinner = [];
  const pickCount = {}; configLabels.forEach(l => pickCount[l] = 0);
  const winnerOosRankDist = [];
  for (const isSet of isSets){
    const oosSet = years.filter(y => !isSet.includes(y));
    // IS: 各变体在 IS 窗口的平均超额 → 选最优
    const isMean = configLabels.map(l => [l, mean(isSet.map(y => excess[l][y]))]);
    isMean.sort((a, b) => b[1] - a[1]);
    const nStar = isMean[0][0];
    pickCount[nStar]++;
    // OOS: 各变体在 OOS 窗口的平均超额 → n* 排名
    const oosMean = configLabels.map(l => [l, mean(oosSet.map(y => excess[l][y]))]);
    oosMean.sort((a, b) => b[1] - a[1]);
    const rank = oosMean.findIndex(([l]) => l === nStar) + 1;   // 1 = 最好
    const omega = (N - rank) / (N - 1);                          // 1 = 最好, 0 = 最差
    oosExcessOfIsWinner.push(oosMean.find(([l]) => l === nStar)[1]);
    winnerOosRankDist.push(rank);
    if (omega <= 0.5) pboCount++;                                // OOS 表现低于中位数 = 该划分失败
  }
  return { pbo: pboCount / isSets.length, total: isSets.length, pickCount, oosExcessOfIsWinner, winnerOosRankDist };
}

// ---------- 主流程 ----------
console.log('=== PBO / 选择偏差审计 (第16轮路线1) ===');
console.log(`样本: 6 变体 × ${WIN_YEARS.length} 窗口(2016-2025 年度 OOS), 基准=中证红利近似全收益, 净收益(已含成本)`);

const varMatrix = buildMatrix(VARIANTS);
const mainMatrix = buildMatrix([MAIN]);

// 输出 1: 矩阵
console.log('\n[1] 逐窗口净超额收益矩阵 (%/年, 策略CAGR - 基准CAGR)');
console.log('变体'.padEnd(14) + WIN_YEARS.map(String).join('').padStart(WIN_YEARS.length * 6 - 4));
for (const [label] of VARIANTS){
  const row = WIN_YEARS.map(y => (varMatrix.excess[label][y] ?? NaN).toFixed(1)).join(' ');
  console.log(label.padEnd(14) + row.padStart(WIN_YEARS.length * 6 - 4));
}
{
  const row = WIN_YEARS.map(y => (mainMatrix.excess[MAIN[0]][y] ?? NaN).toFixed(1)).join(' ');
  console.log(MAIN[0].padEnd(14) + row.padStart(WIN_YEARS.length * 6 - 4) + '  ←冻结基线(不参与选优)');
}
console.log('\n主配置绝对 CAGR/年: ' + WIN_YEARS.map(y => (mainMatrix.absRet[MAIN[0]][y] ?? NaN).toFixed(1)).join(' '));
console.log('基准绝对 CAGR/年: ' + WIN_YEARS.map(y => { const st=`${y}-01-01`; const en=`${y+1}-01-01`<=END?`${y+1}-01-01`:END; const {dates}=buildPanelV3(st,en); return runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics.cagr.toFixed(1); }).join(' '));

// 输出 2/3: CSCV
const varLabels = VARIANTS.map(([l]) => l);
const cscvRes = cscv(varMatrix.excess, varLabels);
console.log('\n[2/3] CSCV (C(10,5)=' + cscvRes.total + ' 划分)');
console.log(`PBO(过拟合概率, 6 变体口径) = ${(cscvRes.pbo * 100).toFixed(1)}%  (IS 选优在 OOS 低于中位数的划分比例)`);
console.log(`IS 最优变体的 OOS 超额: 中位数=${mean(cscvRes.oosExcessOfIsWinner).toFixed(2)}pp  `
  + `负值比例=${(cscvRes.oosExcessOfIsWinner.filter(x => x < 0).length / cscvRes.oosExcessOfIsWinner.length * 100).toFixed(0)}%`);
console.log(`IS 最优变体的 OOS 排名分布: 第1名=${(cscvRes.winnerOosRankDist.filter(r => r === 1).length / cscvRes.total * 100).toFixed(0)}% `
  + `后50%=${(cscvRes.winnerOosRankDist.filter(r => r > varLabels.length / 2).length / cscvRes.total * 100).toFixed(0)}%`);
console.log('IS 选优频次(被选为样本内最优的次数/252): ' + varLabels.map(l => `${l}=${cscvRes.pickCount[l]}`).join(' '));

// 输出 3 补充: 每变体全样本超额中位数/负值比例
console.log('\n各变体 10 窗口超额汇总');
for (const [label] of VARIANTS){
  const xs = WIN_YEARS.map(y => varMatrix.excess[label][y]);
  const med = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`  ${label.padEnd(12)} 中位数=${med.toFixed(2)}pp  负超额年数=${xs.filter(x => x < 0).length}/10  均值=${mean(xs).toFixed(2)}pp`);
}
{
  const xs = WIN_YEARS.map(y => mainMatrix.excess[MAIN[0]][y]);
  const med = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`  ${MAIN[0].padEnd(12)} 中位数=${med.toFixed(2)}pp  负超额年数=${xs.filter(x => x < 0).length}/10  均值=${mean(xs).toFixed(2)}pp  ←冻结基线`);
}

// 输出 4: 排名稳定性
console.log('\n[4] 排名稳定性 (每窗口按超额降序排名; 前5窗口 vs 后5窗口 Spearman)');
const rankByYear = {}; varLabels.forEach(l => rankByYear[l] = {});
for (const y of WIN_YEARS){
  const sorted = varLabels.map(l => [l, varMatrix.excess[l][y]]).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([l], r) => rankByYear[l][y] = r + 1);
}
for (const [label] of VARIANTS){
  const rk = WIN_YEARS.map(y => rankByYear[label][y]);
  const avg = mean(rk);
  const sd = Math.sqrt(mean(rk.map(r => (r - avg) ** 2)));
  const front = WIN_YEARS.slice(0, 5).map(y => rankByYear[label][y]);
  const back = WIN_YEARS.slice(5).map(y => rankByYear[label][y]);
  const sp = spearman(front, back);
  console.log(`  ${label.padEnd(12)} 平均排名=${avg.toFixed(2)}  排名σ=${sd.toFixed(2)}  前后半段Spearman=${isNaN(sp) ? 'N/A' : sp.toFixed(2)}`);
}

// 输出 5/6: 声明
console.log('\n[5/6] 声明');
console.log('- 样本量: 仅 10 个年度窗口, CSCV 在 6 变体 × 10 窗口内做; 统计功效有限, PBO 为审计指标非精确概率。');
console.log('- 变体集合不完整: 仅 6 个已测试变体参与选优, 未测试参数组合的过拟合风险被低估(PBO 不会计入)。');
console.log('- 主配置(冻结)不参与 CSCV 选优, 仅作对照; 本轮不根据 PBO 结果重新挑参数, 主配置保持冻结。');
console.log('- 幸存者偏差(当前成分)与估算基准的既有 caveat 仍然存在, 不因 PBO 通过而消除。');
process.exit(0);
