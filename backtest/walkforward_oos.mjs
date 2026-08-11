// walkforward_oos.mjs — 严格滚动样本外测试 (Walk-Forward Out-of-Sample, 纯评估式)
//
// 协议(按第10轮评审要求):
//   - 参数冻结: 使用 v1.0-research-ready 的基线参数(纯档位 P_pure + 工具默认软倾斜),
//     不随窗口重拟合 —— 无 walk-forward 优化, 排除隐性过拟合。
//   - 股票池冻结: 固定 watchpool.json 完整股票池; 数据冻结: hist/*.json + real_divs.json(bundle)。
//   - 窗口: 2016..2025 每年 1 月 1 日起始的 1 年期验证窗口(共 10 个) + 3 年期窗口(2016/2019/2022)。
//   - 每个窗口独立建仓: 基准自动排除建仓前分红(引擎第8轮修复), 与策略同套成本。
//   - 判定: 报告窗口级胜率(策略 CAGR > 基准 CAGR 的比例)与平均超额, 不硬断言 alpha
//     (样本量小, 如实展示; 结论留给用户判断)。
//
// 已知局限: 时间维度的 OOS 不能消除幸存者偏差(池固定为当前 watchpool 时点)与合成基准分红估算。

import { readFileSync } from 'node:fs';
import { buildPanel, runStrategy, runBenchmark } from './backtest_engine.js';

const bundle = JSON.parse(readFileSync('backtest_bundle.json', 'utf8'));
const END = bundle.meta.end;   // 2026-08-07

const P_pure = { usePercentile: false, buyYield: 5, sellYield: 3, lookbackYears: 5, maxWeight: 0.20,
  rebalance: 'month', drip: true, resourceExtra: true, initialCapital: 1_000_000 };
const P_tilt = { ...P_pure, usePercentile: true, tilt: true };
const czz = bundle.benchmarks.find(b => b.name.includes('中证红利'));
if (!czz){ console.error('未找到中证红利基准'); process.exit(1); }

function runWindow(st, en){
  const { dates, panel } = buildPanel(bundle.stocks, st, en);
  if (!dates.length) return null;
  const sp = runStrategy(dates, panel, P_pure).metrics;
  const stilt = runStrategy(dates, panel, P_tilt).metrics;
  const bm = runBenchmark(dates, czz.kline, czz.divs, 1_000_000).metrics;
  const yrs = (Date.parse(bm.end) - Date.parse(bm.start)) / (365.25 * 86400000);
  return { yrs, sp, stilt, bm };
}

const rows = [];
// 1) 1 年期窗口: 2016..2025 起始
console.log('=== 滚动样本外: 1 年期窗口(2016~2025 起始, 参数冻结) ===');
console.log(`${'起始'.padEnd(10)}${'年数'.padStart(5)}${'纯档位CAGR%'.padStart(10)}${'软倾斜CAGR%'.padStart(10)}${'基准CAGR%'.padStart(10)}${'纯档位MDD%'.padStart(10)}${'基准MDD%'.padStart(10)}${'纯档位胜'.padStart(8)}${'软倾斜胜'.padStart(8)}`);
for (const y of [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]){
  const st = `${y}-01-01`;
  const en = `${y + 1}-01-01` <= END ? `${y + 1}-01-01` : END;
  const r = runWindow(st, en);
  if (!r) continue;
  const winS = r.sp.cagr > r.bm.cagr ? '✓' : '✗';
  const winT = r.stilt.cagr > r.bm.cagr ? '✓' : '✗';
  rows.push({ y, yrs: r.yrs, sp: r.sp.cagr, tl: r.stilt.cagr, bm: r.bm.cagr, winS, winT });
  console.log(`${st.padEnd(10)}${r.yrs.toFixed(2).padStart(5)}${r.sp.cagr.toFixed(2).padStart(10)}`
    + `${r.stilt.cagr.toFixed(2).padStart(10)}${r.bm.cagr.toFixed(2).padStart(10)}`
    + `${r.sp.mdd.toFixed(1).padStart(10)}${r.bm.mdd.toFixed(1).padStart(10)}${winS.padStart(8)}${winT.padStart(8)}`);
}
// 汇总
const n = rows.length;
const avg = k => rows.reduce((a, r) => a + r[k], 0) / n;
const winRate = k => rows.filter(r => r[k] === '✓').length / n;
console.log('\n=== 汇总(1 年期窗口) ===');
console.log(`窗口数=${n}`);
console.log(`纯档位平均CAGR=${avg('sp').toFixed(2)}%  vs  中证红利平均CAGR=${avg('bm').toFixed(2)}%  (超额 ${(avg('sp') - avg('bm')).toFixed(2)}pp)`);
console.log(`软倾斜平均CAGR=${avg('tl').toFixed(2)}%  vs  中证红利平均CAGR=${avg('bm').toFixed(2)}%  (超额 ${(avg('tl') - avg('bm')).toFixed(2)}pp)`);
console.log(`窗口级胜率: 纯档位 ${(winRate('winS') * 100).toFixed(0)}% (${rows.filter(r => r.winS === '✓').length}/${n}), 软倾斜 ${(winRate('winT') * 100).toFixed(0)}% (${rows.filter(r => r.winT === '✓').length}/${n})`);
console.log(`纯档位跑赢窗口年份: ${rows.filter(r => r.winS === '✓').map(r => r.y).join(', ') || '无'}`);
console.log(`纯档位跑输窗口年份: ${rows.filter(r => r.winS === '✗').map(r => r.y).join(', ') || '无'}`);

// 2) 3 年期窗口: 2016/2019/2022 起始
console.log('\n=== 滚动样本外: 3 年期窗口(2016/2019/2022 起始) ===');
console.log(`${'起始'.padEnd(10)}${'年数'.padStart(5)}${'纯档位CAGR%'.padStart(10)}${'基准CAGR%'.padStart(10)}${'纯档位MDD%'.padStart(10)}${'基准MDD%'.padStart(10)}${'胜'.padStart(5)}`);
for (const y of [2016, 2019, 2022]){
  const st = `${y}-01-01`;
  const en = `${y + 3}-01-01` <= END ? `${y + 3}-01-01` : END;
  const r = runWindow(st, en);
  if (!r) continue;
  const win = r.sp.cagr > r.bm.cagr ? '✓' : '✗';
  console.log(`${st.padEnd(10)}${r.yrs.toFixed(2).padStart(5)}${r.sp.cagr.toFixed(2).padStart(10)}`
    + `${r.bm.cagr.toFixed(2).padStart(10)}${r.sp.mdd.toFixed(1).padStart(10)}${r.bm.mdd.toFixed(1).padStart(10)}${win.padStart(5)}`);
}

// 判定: 只做"可跑通 + 窗口完整"断言; alpha 结论由报告如实呈现
const ok = rows.length === 10 && rows.every(r => r.yrs > 0.9);
console.log(`\nOOS 脚本完整性: 1 年期窗口 ${rows.length}/10 -> ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);
