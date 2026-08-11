// sweep_percentile.mjs — 量化百分位估值维度的收益权衡, 为策略调整提供数据
import { readFileSync } from 'node:fs';
import { buildPanel, runStrategy } from './backtest_engine.js';

const B = JSON.parse(readFileSync('backtest_bundle.json', 'utf8'));
const { dates, panel } = buildPanel(B.stocks, B.meta.start, B.meta.end);
const base = { buyYield: 5, sellYield: 3, maxWeight: 0.20, rebalance: 'month',
  initialCapital: 1_000_000, drip: true, resourceExtra: true };

// 基线: 纯档位(无百分位)
const pure = runStrategy(dates, panel, { ...base, usePercentile: false }).metrics;
console.log(`基线 纯档位(无百分位): CAGR ${pure.cagr}%  MDD ${pure.mdd}%  Sharpe ${pure.sharpe}  终值 ¥${pure.final}`);
console.log('');

const header = (t) => console.log(t);
header('=== 网格扫描: usePercentile=true, 变动 回看窗口 / 便宜线 / 贵线 ===');
header('回看  便宜%  贵%   | CAGR%   MDD%    Sharpe  终值(万)  相对纯档位');
const rows = [];
for (const lb of [2, 3, 5]) {
  for (const cheap of [30, 40, 50, 60]) {
    for (const exp of [70, 80]) {
      if (cheap >= exp) continue;
      const m = runStrategy(dates, panel, { ...base, usePercentile: true,
        lookbackYears: lb, cheapPct: cheap, expensivePct: exp }).metrics;
      rows.push({ lb, cheap, exp, m });
      const diff = (m.cagr - pure.cagr).toFixed(2);
      console.log(
        `${String(lb).padEnd(4)}  ${String(cheap).padEnd(5)}  ${String(exp).padEnd(4)}  | ` +
        `${String(m.cagr).padEnd(6)}  ${String(m.mdd).padEnd(6)}  ${String(m.sharpe).padEnd(6)}  ` +
        `${(m.final/1e4).toFixed(0).padEnd(6)}  ${diff>=0?'+':''}${diff}pp`);
    }
  }
}
console.log('\n=== 观察 ===');
console.log('1) 回看窗口: 5年 vs 2/3年 — 注意预热期(历史不足时退化为纯档位)长短不同');
console.log('2) 便宜线↑(30→60): 买入触发更宽松, CAGR 应回升');
console.log('3) 贵线↑(70→80): 卖出更克制, CAGR 应回升');
