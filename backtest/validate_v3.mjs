// ============================================================
// validate_v3.mjs — v3.3 专用校验器 (第12–14轮评审)
//
// 断言(11项):
//   1) 买入/退出资格分离: 全 OOS 10 窗口 sellRuleKeeps > 0
//   2) 目标仓位: 每次调仓 maxDesSum ≤ 1 (无缓冲超仓/无隐性杠杆)
//   3) 现金守恒(评审#2): 期末现金+待复投 = 期初 + 卖出净额 - 买入成本(含费)
//      + 分红总额 - 复投转股票金额, 逐窗口误差 < 0.01
//   4) 承接内部一致(评审#2): reuseMatched ≤ sellTotal 且 ≤ 新进入股实际成交总额
//   5) 数据覆盖(评审#3): 纳入日期/行业映射的**键集合与 K 线完全一致**(防同数量错配),
//      纳入日期均为**真实日历日期**(round-trip 校验), 且无默认回退(2000-01-01/"其他")
//   6) 单行业实际持仓上限(评审#4): 引擎内断言 + maxIndCount ≤ 3
//   7) 逐年行业暴露(评审#4): 任一年任一行业日均暴露 ≤ 70% (人为风控阈值, 非行业中性化)
//   8) 主配置冻结: 平均 CAGR ∈ [10,15]%  (区间断言 = 回归护栏, 防大幅漂移, 非机制证明)
//   9) 主配置冻结: 超额 ∈ [0,8]pp       (同上)
//  10) 实际成交匹配率 ∈ [0,1] (订单规模匹配, 非逐笔现金来源账本)
//  11) 已完成退出样本平均持有期 ∈ [1,6] 季 (同上, 回归护栏)
// ============================================================

import { buildPanelV3, simulateV3, V3_MAIN, runOOS, INCLUDES, INDUSTRY, KLINE } from './experiment_v3.mjs';

const winYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
let sellKeeps = 0, maxDes = 0, windows = 0;
let conserveMaxErr = 0, conserveFail = false;
let reuseLeSell = true, reuseLeBuy = true;
let maxIndCount = 0, maxIndExp = 0;
for (const y of winYears){
  const st = `${y}-01-01`;
  const en = `${y + 1}-01-01`;
  const { dates, panel } = buildPanelV3(st, en);
  if (!dates.length) continue;
  const r = simulateV3(dates, panel, V3_MAIN);
  sellKeeps += r.sellRuleKeeps;
  maxDes = Math.max(maxDes, r.maxDesSum);
  windows++;
  // 现金守恒: final_cash + pendingEnd = 1e6 + sumSellNet - sumBuyCost + sumDivCash - sumDivInvest
  const lhs = r.finalCash + r.pendingEnd;
  const rhs = 1_000_000 + r.sumSellNet - r.sumBuyCost + r.sumDivCash - r.sumDivInvest;
  const err = Math.abs(lhs - rhs);
  if (err > conserveMaxErr) conserveMaxErr = err;
  if (err > 0.01) conserveFail = true;
  // 承接内部一致
  if (r.reuseMatched > r.sellTotal + 1e-6) reuseLeSell = false;
  if (r.reuseMatched > r.buysNewTotal + 1e-6) reuseLeBuy = false;
  // 单行业持仓上限 + 行业暴露
  maxIndCount = Math.max(maxIndCount, r.maxIndCount);
  for (const exp of Object.values(r.yearlyExposure)){
    for (const w of Object.values(exp)) maxIndExp = Math.max(maxIndExp, w);
  }
}
const okSep = sellKeeps > 0 && windows === 10;
const okDes = maxDes <= 1 + 1e-6;
const okConserve = !conserveFail;
const okReuseRel = reuseLeSell && reuseLeBuy;

// 数据覆盖(第14轮评审#1升级): 键集合与 K 线一致 + 真实日历日期 + 无默认回退
// 注: KLINE.include 为原始斜杠格式(如 2024/12/16), 先按 normDate 语义标准化再验证
const normInc = v => String(v || '').replace(/\//g, '-');
const klKeys = Object.keys(KLINE.kline || {}).sort();
const incKeys = Object.keys(INCLUDES).sort();
const indKeys = Object.keys(INDUSTRY).sort();
const sameSet = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
const okKeySet = sameSet(klKeys, incKeys) && sameSet(klKeys, indKeys);
const incVals = Object.values(INCLUDES);
const indVals = Object.values(INDUSTRY);
const okRealDates = incVals.every(v => {
  const nv = normInc(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nv)) return false;
  const t = Date.parse(nv + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === nv;
});
const okCover = okKeySet && okRealDates && incVals.length === 99
  && !incVals.some(v => normInc(v) === '2000-01-01')
  && indVals.length === 99 && !indVals.some(v => v === '其他');

// 主配置全 OOS(冻结基线)
const main = runOOS(V3_MAIN, '主配置');
const okCagr = main.avgCagr >= 10 && main.avgCagr <= 15;
const okExcess = (main.avgCagr - main.avgBm) >= 0 && (main.avgCagr - main.avgBm) <= 8;
const okReuse = main.reusePct > 0 && main.reusePct <= 1;
const okHolding = main.avgHoldingQ >= 1 && main.avgHoldingQ <= 6;
const okIndCount = maxIndCount <= 3;
const okIndExp = maxIndExp <= 0.70;

const ok = okSep && okDes && okConserve && okReuseRel && okCover && okIndCount
  && okIndExp && okCagr && okExcess && okReuse && okHolding;
console.log('=== v3.3 专用校验 ===');
console.log(`买入/退出资格分离(10窗口 退出线独立保留 ${sellKeeps} 次) -> ${okSep ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`目标仓位总和峰值 ${maxDes.toFixed(6)} ≤1 (无超仓/无杠杆) -> ${okDes ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`现金守恒(10窗口最大误差 ${conserveMaxErr.toFixed(6)} 元 <0.01) -> ${okConserve ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`承接内部一致(匹配≤卖出净额 ${reuseLeSell ? '✓' : '✗'} 且 ≤新进入成交额 ${reuseLeBuy ? '✓' : '✗'}) -> ${okReuseRel ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`数据覆盖(键集合 ${klKeys.length}/99 与K线一致, 纳入日期均为真实日历日期, 无默认回退) -> ${okCover ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`单行业实际持仓上限(峰值 ${maxIndCount} ≤3) -> ${okIndCount ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`逐年行业暴露(峰值 ${(maxIndExp * 100).toFixed(1)}% ≤70% 人为风控阈值, 非行业中性化; 3/6 等权理论上限~50%, 超出部分来自权重漂移) -> ${okIndExp ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`主配置冻结 CAGR=${main.avgCagr.toFixed(2)}% (10~15, 回归护栏) -> ${okCagr ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`主配置冻结 超额=${(main.avgCagr - main.avgBm).toFixed(2)}pp (0~8, 回归护栏) -> ${okExcess ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`实际成交匹配率 ${(main.reusePct * 100).toFixed(0)}% (0~100%) -> ${okReuse ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`已完成退出样本平均持有期 ${main.avgHoldingQ.toFixed(1)} 季 (1~6, 回归护栏) -> ${okHolding ? 'PASS ✅' : 'FAIL ❌'}`);
if (!ok) console.log('\n⚠️ v3 校验未通过：请复核 experiment_v3.mjs 机制。');
console.log('\n说明: CAGR/超额/持有期为区间回归断言(防大幅漂移), 非机制证明; 机制正确性由结构性断言');
console.log('(资格分离/仓位/守恒/内部一致/键集合覆盖/单行业上限/行业暴露)支撑。');
process.exit(ok ? 0 : 1);
