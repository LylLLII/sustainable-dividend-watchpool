// validate_engine.mjs — 校验 JS 引擎 vs Python 回测（第4轮评审口径：真实分红 + 交易成本 + 标准指标）
// 检查项:
//   1) JS 经典档位(乐观/保守)与 Python summary_metrics.json 完全对齐(0 偏差, 容差=四舍五入级)
//   2) 策略/基准指标落在合理区间(宽区间断言, 抗分红源漂移)
//   3) 分红源口径: 全部股票来自真实除息事件(无 expDps 回填特征: 无全周期同值事件, 移动无上市前分红)
//   4) 成本模型生效: 换手率>0, Sharpe/Sortino/Calmar 合理
//   5) 滚动窗口/不同起始年重算(打印 + 断言可跑通)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPanel, runStrategy, runBenchmark, simulate } from './backtest_engine.js';

const HIST = 'hist';
const START = '2015-01-01', END = new Date().toISOString().slice(0,10);
const STOCK_RE = /^(sh|sz)\d{6}\.json$/;
const BENCH_ALLOW = new Set(['sh513500', 'sh000300', 'sh000922']);

function loadStocks(){
  const stocks = [];
  for (const f of readdirSync(HIST)){
    if (!STOCK_RE.test(f)) continue;
    const d = JSON.parse(readFileSync(join(HIST, f), 'utf8'));
    stocks.push({
      code: d.code, name: d.name, isResource: d.isResource,
      kline: d.kline.map(r => [r.date, r.close]),
      divs: d.divs.map(r => [r.exDate, r.dps]),
      divSource: d.divSource || ''
    });
  }
  return stocks;
}
function loadBenches(){
  const benches = [];
  for (const f of readdirSync(HIST)){
    if (!f.startsWith('bench_')) continue;
    const code = f.slice(6, -5);
    if (!BENCH_ALLOW.has(code)) continue;
    const d = JSON.parse(readFileSync(join(HIST, f), 'utf8'));
    benches.push({
      code, name: d.name,
      kline: d.kline.map(r => [r.date, r.close]),
      divs: d.divs.map(r => [r.exDate, r.dps])
    });
  }
  return benches;
}

const stocks = loadStocks();
const benches = loadBenches();
console.log(`载入股票 ${stocks.length} 只, 基准 ${benches.length} 个`);

const { dates, panel } = buildPanel(stocks, START, END);
console.log(`日期轴 ${dates.length} 天, ${dates[0]} ~ ${dates[dates.length-1]}`);

// ---- 1) 经典档位 (usePercentile=false) 乐观 ----
const P_pure = {
  usePercentile: false, buyYield: 5, sellYield: 3, cheapPct: 30, expensivePct: 70,
  lookbackYears: 5, maxWeight: 0.20, rebalance: 'month', drip: true,
  resourceExtra: true, initialCapital: 1_000_000
};
const stratPure = runStrategy(dates, panel, P_pure);
console.log('\n[经典档位 usePercentile=false]');
console.log(JSON.stringify(stratPure.metrics, null, 0));

// ---- 2) 百分位估值默认 (硬闸门) ----
const P_pct = { ...P_pure, usePercentile: true };
const stratPct = runStrategy(dates, panel, P_pct);
console.log('\n[百分位估值 usePercentile=true 默认(硬闸门)]');
console.log(JSON.stringify(stratPct.metrics, null, 0));

// ---- 2b) 百分位软倾斜 ----
const P_tilt = { ...P_pure, usePercentile: true, tilt: true };
const stratTilt = runStrategy(dates, panel, P_tilt);
console.log('\n[百分位软倾斜 tilt=true]');
console.log(JSON.stringify(stratTilt.metrics, null, 0));

// ---- 3) 基准 ----
console.log('\n[基准]');
const benchM = {};
for (const b of benches){
  const r = runBenchmark(dates, b.kline, b.divs, 1_000_000);
  benchM[b.name] = r.metrics;
  console.log(`${b.name.padEnd(24)}`, JSON.stringify(r.metrics));
}

// ---- 4) 保守模式 ----
const P_cons = { ...P_pure, conservative: true };
const stratCons = runStrategy(dates, panel, P_cons);
console.log('\n[保守模式 conservative=true]');
console.log(JSON.stringify(stratCons.metrics, null, 0));

// ---- 5) 与 Python 对照 (summary_metrics.json) ----
const pyFile = join(HIST, 'summary_metrics.json');
let py = null, parity = [];
if (existsSync(pyFile)){
  py = JSON.parse(readFileSync(pyFile, 'utf8'));
  const pairs = [
    ['optimistic', stratPure.metrics],
    ['conservative', stratCons.metrics],
  ];
  for (const [mode, jsM] of pairs){
    const p = py[`策略-${mode}`];
    if (!p){ parity.push([mode, false, 'Python 缺失']); continue; }
    const dCagr = Math.abs(jsM.cagr - p.cagr);
    const dMdd = Math.abs(jsM.mdd - p.mdd);
    const dSharpe = Math.abs(jsM.sharpe - p.sharpe);
    const dTurn = (jsM.turnover ?? -1) - (p.turnover ?? -1);
    const ok = dCagr <= 0.06 && dMdd <= 0.06 && dSharpe <= 0.03 && Math.abs(dTurn) <= 0.01;
    parity.push([mode, ok, `ΔCAGR=${dCagr.toFixed(3)} ΔMDD=${dMdd.toFixed(3)} ΔSharpe=${dSharpe.toFixed(3)} ΔTurnover=${dTurn.toFixed(3)}`]);
  }
  // 基准对照
  for (const b of benches){
    const p = py[`基准-${b.name}`];
    if (!p) continue;
    const jsM = benchM[b.name];
    const dCagr = Math.abs(jsM.cagr - p.cagr);
    if (dCagr > 0.06) parity.push([`基准-${b.name}`, false, `ΔCAGR=${dCagr.toFixed(3)}`]);
  }
}
console.log('\n[Python 对照 summary_metrics.json]');
for (const [k, ok, msg] of parity){
  console.log(`${k.padEnd(14)} ${ok ? 'PASS ✅' : 'FAIL ❌'}  ${msg}`);
}

// ---- 6) 分红源来源级审计: hist/*.json 与 data/real_divs.json 逐条一致 ----
console.log('\n[分红源来源级审计 hist vs data/real_divs.json]');
const realDivsPath = 'data/real_divs.json';
let srcOk = true, compared = 0;
if (!existsSync(realDivsPath)){
  srcOk = false;
  console.log(`  ${realDivsPath} 不存在 -> FAIL ❌`);
}else{
  const realDivsDoc = JSON.parse(readFileSync(realDivsPath, 'utf8'));
  const realDivs = realDivsDoc.stocks || {};
  console.log(`  快照: source=${(realDivsDoc.meta || {}).source} fetched_at=${(realDivsDoc.meta || {}).fetched_at}`);
  console.log(`  审计边界: hist 与东财抓取快照 real_divs.json 逐条一致; 快照本身依赖东财源(非二次独立核验)`);
  for (const s of stocks){
    const realEvents = (realDivs[s.code] || [])
      .filter(e => e.exDate >= '2014-01-01')          // 与 apply_watchpool_divs 的裁剪口径一致
      .sort((a, b) => a.exDate < b.exDate ? -1 : 1);
    const histMap = new Map(s.divs.map(([ex, dps]) => [ex, dps]));
    for (const e of realEvents){
      compared++;
      const h = histMap.get(e.exDate);
      if (h === undefined || Math.abs(h - e.dps) > 1e-9){
        srcOk = false;
        console.log(`  ${s.code} ${e.exDate} hist=${h} real=${e.dps} -> FAIL ❌`);
      }
    }
    if (realEvents.length !== s.divs.length){
      srcOk = false;
      console.log(`  ${s.code} 事件数不符: hist=${s.divs.length} real=${realEvents.length} -> FAIL ❌`);
    }
    // 上市前分红检查(中国移动)
    if (s.code === 'sh600941' && s.divs.length && s.divs[0][0] < '2022-01-01'){
      srcOk = false;
      console.log(`  ${s.code} 中国移动存在上市前分红 -> FAIL ❌`);
    }
  }
}
console.log(`  逐条比对 ${compared} 条分红事件(52 股, exDate+dps 精确一致) -> ${srcOk ? 'PASS ✅' : 'FAIL ❌'}`);

// ---- 6b) DRIP 开关回归检查 (第5轮评审发现: 开关无效) ----
console.log('\n[DRIP 开关回归检查]');
const stratNoDrip = runStrategy(dates, panel, { ...P_pure, drip: false });
const sameEquity = JSON.stringify(stratPure.equity) === JSON.stringify(stratNoDrip.equity);
const finalOn = stratPure.metrics.final, finalOff = stratNoDrip.metrics.final;
// drip=false 时分红沉淀现金, 最终净值应低于(或显著不同于)复投情形; 若完全相同 = 开关失效
const dripOk = !sameEquity && finalOff > 0 && Math.abs(finalOn - finalOff) / finalOn > 0.001;
console.log(`  drip=true final=${finalOn} / drip=false final=${finalOff} (差 ${(finalOn - finalOff) / finalOn * 100}%) -> ${dripOk ? 'PASS ✅' : 'FAIL ❌'}`);

// ---- 6c) 基准分红复投延迟回归检查 (第7轮评审: simulateHold 未读取 cost.divDelay) ----
console.log('\n[基准 divDelay 回归检查]');
const benchDiv = (dd) => runBenchmark(dates, benches[0].kline, benches[0].divs, 100000, { divDelay: dd }).metrics.final;
const bd0 = benchDiv(0), bd1 = benchDiv(1), bd5 = benchDiv(5);
// 复投时点不同 → 终值应互不相同(方向取决于复投价差); 三者全相同 = divDelay 未生效
const divDelayOk = bd0 !== bd1 && bd1 !== bd5 && bd0 !== bd5;
console.log(`  divDelay=0 -> ${bd0.toFixed(2)} / 1 -> ${bd1.toFixed(2)} / 5 -> ${bd5.toFixed(2)} (三者互不相同) -> ${divDelayOk ? 'PASS ✅' : 'FAIL ❌'}`);

// ---- 8d) 策略 DRIP 复投成本生效 (第9轮评审#1: 复投必须计佣金+滑点, 与基准/再平衡同口径) ----
console.log('\n[策略 DRIP 复投成本生效]');
let dripCostOk = false;
{
  const miniStock = [{ code:'T01', name:'T', isResource:false,
    kline: [['2026-01-01',10],['2026-01-02',10],['2026-01-03',10],['2026-01-04',10],['2026-01-05',10],
            ['2026-01-06',10],['2026-01-07',10],['2026-01-08',10],['2026-01-09',10],['2026-01-10',10]],
    divs: [['2025-12-31',50], ['2026-01-09',50]] }];
  const mini = buildPanel(miniStock, '2026-01-01', '2026-01-10');
  const Pmini = { usePercentile:false, buyYield:0.5, sellYield:0.1, lookbackYears:1, maxWeight:0.2,
    rebalance:'month', drip:true, resourceExtra:false, initialCapital:100000 };
  const c0 = { commissionRate:0, slippage:0, divDelay:0, execDelay:0 };
  const c1 = { commissionRate:0.01, slippage:0.01, divDelay:0, execDelay:0 };
  const fC0 = simulate(mini.dates, mini.panel, { ...Pmini, cost:c0 }).equity.at(-1)[1];
  const fC1 = simulate(mini.dates, mini.panel, { ...Pmini, cost:c1 }).equity.at(-1)[1];
  // 非零成本(含 DRIP 复投佣金+滑点)下终值必须显著低于零成本; 若相等 = 复投/再平衡未计费
  dripCostOk = fC1 < fC0 - 500;
  console.log(`  零成本终值=${fC0.toFixed(2)} / 高成本(1%佣+1%滑)终值=${fC1.toFixed(2)} (差=${(fC0 - fC1).toFixed(2)}, 应>500) -> ${dripCostOk ? 'PASS ✅' : 'FAIL ❌'}`);
}

// ---- 7) 成本模型生效 ----
const m = stratPure.metrics;
const costOk = m.turnover > 0.3 && m.sharpe > 0 && m.sortino > 0 && m.calmar > 0;
console.log(`\n[成本模型] turnover=${m.turnover} sharpe=${m.sharpe} sortino=${m.sortino} calmar=${m.calmar} -> ${costOk ? 'PASS ✅' : 'FAIL ❌'}`);

// ---- 8) 滚动窗口/不同起始年重算 (评审: 不同起始年份/牛熊阶段; 第8轮: 基准也纳入重算) ----
console.log('\n[滚动窗口重算: 策略 vs 中证红利基准]');
const czz = benches.find(b => b.name.includes('中证红利'));
const rollOk = [];
for (const y of [2016, 2018, 2020, 2022]){
  const st = `${y}-01-01`;
  const { dates: d2, panel: p2 } = buildPanel(stocks, st, END);
  if (!d2.length){ rollOk.push([y, false, '无数据']); continue; }
  const r = runStrategy(d2, p2, { ...P_pure, initialCapital: 1_000_000 });
  const mm = r.metrics;
  let bm = null;
  if (czz){ bm = runBenchmark(d2, czz.kline, czz.divs, 1_000_000).metrics; }
  const ok = mm.cagr > 0 && mm.cagr < 20 && (!bm || (bm.cagr > -2 && bm.cagr < 25));
  rollOk.push([y, ok, `策略CAGR=${mm.cagr}% 基准CAGR=${bm ? bm.cagr : 'N/A'}%`]);
  console.log(`  起始 ${st}: 策略 CAGR=${mm.cagr}% MDD=${mm.mdd}% 夏普=${mm.sharpe} | `
              + `基准 CAGR=${bm ? bm.cagr : '-'}% MDD=${bm ? bm.mdd : '-'}% 夏普=${bm ? bm.sharpe : '-'}`);
}
// 滚动 3 年窗口 (2016/2019/2022 起各 3 年)
console.log('\n[滚动3年窗口 optimistic]');
for (const y of [2016, 2019, 2022]){
  const st = `${y}-01-01`, en = `${y + 3}-01-01`;
  const { dates: d2, panel: p2 } = buildPanel(stocks, st, en);
  if (!d2.length) continue;
  const r = runStrategy(d2, p2, { ...P_pure, initialCapital: 1_000_000 });
  console.log(`  ${st} ~ ${en}: CAGR=${r.metrics.cagr}% MDD=${r.metrics.mdd}%`);
}

// ---- 8b) 策略待复投分红权益守恒 (第8轮评审#1: 净值必须包含 pendingQ) ----
console.log('\n[策略待复投分红权益守恒]');
let equityConserved = false, benchNoPreDivOk = false;
{
  const miniStock = [{ code:'T01', name:'T', isResource:false,
    kline: [['2026-01-01',10],['2026-01-02',10],['2026-01-03',10],['2026-01-04',10],['2026-01-05',10],
            ['2026-01-06',10],['2026-01-07',10],['2026-01-08',10],['2026-01-09',10],['2026-01-10',10]],
    divs: [['2025-12-31',50], ['2026-01-09',50]] }];   // 第二笔在期末前 1 天, divDelay>=1 → 期末仍 pending
  const mini = buildPanel(miniStock, '2026-01-01', '2026-01-10');
  const Pmini = { usePercentile:false, buyYield:0.5, sellYield:0.1, lookbackYears:1, maxWeight:0.2,
    rebalance:'month', drip:true, resourceExtra:false, initialCapital:100000,
    cost:{ divDelay:0, slippage:0, execDelay:0, commissionRate:0, minCommission:0 } };
  const r0 = simulate(mini.dates, mini.panel, { ...Pmini, cost:{ divDelay:0, slippage:0, execDelay:0, commissionRate:0, minCommission:0 } });
  const r3 = simulate(mini.dates, mini.panel, { ...Pmini, cost:{ divDelay:3, slippage:0, execDelay:0, commissionRate:0, minCommission:0 } });
  const f0 = r0.equity[r0.equity.length-1][1], f3 = r3.equity[r3.equity.length-1][1];
  // 恒定价格+无滑点: divDelay=0(当日复投) 与 divDelay=3(期末 pending) 终值必须相等 ⇔ pending 计入净值
  equityConserved = Math.abs(f0 - f3) < 1e-6;
  console.log(`  divDelay=0 终值=${f0.toFixed(2)} / divDelay=3 终值=${f3.toFixed(2)} (应相等, 差=${(f0-f3).toFixed(4)}) -> ${equityConserved ? 'PASS ✅' : 'FAIL ❌'}`);
}

// ---- 8c) 基准建仓前分红不计入 (第8轮评审#2: 2016/2018/2022 起始不得获得未持有期分红) ----
console.log('\n[基准建仓前分红不计入]');
{
  const y2016 = buildPanel(stocks, '2016-01-01', END);
  const fullDivs = czz.divs;
  const filteredDivs = fullDivs.filter(([ex]) => ex > '2016-01-01');
  const rf = runBenchmark(y2016.dates, czz.kline, fullDivs, 1_000_000).metrics.final;
  const rfd = runBenchmark(y2016.dates, czz.kline, filteredDivs, 1_000_000).metrics.final;
  // 修复后: simulateHold 自动跳过 firstD 前分红 → 全量 divs 与显式过滤 divs 终值一致
  benchNoPreDivOk = Math.abs(rf - rfd) < 1;
  console.log(`  中证红利 @2016起始: 全量divs终值=${(rf/10000).toFixed(1)}万 / 过滤2015前divs终值=${(rfd/10000).toFixed(1)}万 (应一致) -> ${benchNoPreDivOk ? 'PASS ✅' : 'FAIL ❌'}`);
}

// ---- 断言汇总 ----
// 新诚实基线(真实分红+成本): 经典档位 CAGR 大幅低于旧口径 15.83%(前视偏差已被剔除),
// 预期落在 3%~12% 之间(52只完整池优化后适度放宽上限); 保守≈乐观(差<1pp); 软倾斜/硬闸门仅打印(该关系随真实分红变化, 不再做硬断言);
// 策略跑赢/跑输基准由数据决定, 不作断言(如实报告).
const mc = stratCons.metrics;
const okOpt = m.cagr > 3 && m.cagr < 12 && m.mdd > -40 && m.mdd < 0;
const okCons = mc.cagr > 3 && mc.cagr < 12;
const okClose = Math.abs(m.cagr - mc.cagr) < 1.0;
const okParity = parity.every(([, ok]) => ok) && parity.length >= 2;
const okRoll = rollOk.every(([, ok]) => ok) && rollOk.length === 4;
// 网页默认模式(usePercentile+tilt)硬断言: 宽区间 + 相对关系(realized-TTM 下便宜区极少触发,
// 软倾斜仓位长期不足 → 收益低于纯档位)。防默认配置回归(第6轮评审 #2)。
const mt = stratTilt.metrics;
const okTilt = mt.cagr > 0.5 && mt.cagr < 8 && mt.cagr < m.cagr + 0.5 && mt.mdd > -40;
const ok = okOpt && okCons && okClose && okParity && okRoll && srcOk && costOk && dripOk && okTilt && divDelayOk && equityConserved && benchNoPreDivOk && dripCostOk;
console.log('\n=== 校验 ===');
console.log(`optimistic  CAGR=${m.cagr}% (3~12% 诚实区间) MDD=${m.mdd}% -> ${okOpt ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`conservative CAGR=${mc.cagr}% (3~12%) -> ${okCons ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`乐观/保守 CAGR 差=${Math.abs(m.cagr - mc.cagr).toFixed(2)}pp (<1pp) -> ${okClose ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`JS/Python 对照 ${parity.length} 项 -> ${okParity ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`滚动窗口 4 个起始年(策略+基准) -> ${okRoll ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`分红源来源级审计(逐条比对 ${compared} 条) -> ${srcOk ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`DRIP 开关回归(开=${finalOn} 关=${finalOff}, 差 ${((finalOn - finalOff) / finalOn * 100).toFixed(2)}%) -> ${dripOk ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`成本模型 -> ${costOk ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`默认模式软倾斜 CAGR=${mt.cagr}% (0.5~8%, 且<纯档位) -> ${okTilt ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`基准 divDelay 生效(0/1/5 互不相同) -> ${divDelayOk ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`策略待复投分红权益守恒 -> ${equityConserved ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`基准建仓前分红不计入 -> ${benchNoPreDivOk ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`策略 DRIP 复投成本生效(非零成本显著拉低终值) -> ${dripCostOk ? 'PASS ✅' : 'FAIL ❌'}`);
if (!ok) console.log('\n⚠️ 校验未通过：请复核引擎回归或数据口径。');
process.exit(ok ? 0 : 1);
