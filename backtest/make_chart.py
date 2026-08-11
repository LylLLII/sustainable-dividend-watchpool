"""绘制策略净值曲线 vs 三大基准，输出 PNG。修复中文字体缺失问题。"""
import csv, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from datetime import datetime

# 注册系统中文字体，避免标题/图例中文显示为方块
CJK_FONT_PATHS = [
    r"C:/Windows/Fonts/msyh.ttc",        # 微软雅黑
    r"C:/Windows/Fonts/NotoSansSC-VF.ttf",  # 思源黑体(备选)
    r"C:/Windows/Fonts/simhei.ttf",      # 黑体(备选)
]
_registered = []
for p in CJK_FONT_PATHS:
    try:
        font_manager.fontManager.addfont(p)
        _registered.append(font_manager.FontProperties(fname=p).get_name())
    except Exception:
        pass
if _registered:
    plt.rcParams["font.sans-serif"] = _registered
plt.rcParams["axes.unicode_minus"] = False  # 正常显示负号

def load_csv(p):
    rows = list(csv.reader(open(p, encoding="utf-8")))[1:]
    return [(datetime.strptime(r[0], "%Y-%m-%d"), float(r[1])) for r in rows]

series = {
    "策略(股息率触发+分红复投+成本)": ("hist/equity_optimistic.csv", "#e4572e", 2.5),
    "沪深300(近似全收益)": ("hist/bench_sh000300_equity.csv", "#3a86ff", 1.4),
    "中证红利(近似全收益)": ("hist/bench_sh000922_equity.csv", "#2a9d8f", 1.4),
    "标普500ETF(近似全收益)": ("hist/bench_sh513500_equity.csv", "#8338ec", 1.4),
}
plt.figure(figsize=(11, 5.6), dpi=130)
for label, (path, color, lw) in series.items():
    try:
        d, v = zip(*load_csv(path))
        plt.plot(d, [x/10000 for x in v], label=label, color=color, lw=lw)
    except FileNotFoundError:
        pass
plt.title("可持续高股息策略 回测净值 (初始 100 万 · 2015-01-05 ~ 2026-08-07)", fontsize=13)
plt.ylabel("净值 (万元)")
plt.legend(loc="upper left", fontsize=9)
plt.grid(alpha=.25)
plt.tight_layout()
plt.savefig("backtest_equity_curve.png", dpi=130)
print("saved backtest_equity_curve.png | CJK fonts:", _registered)
