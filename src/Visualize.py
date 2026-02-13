import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter
from matplotlib.transforms import blended_transform_factory
from typing import Dict


class Visualizer:

    def __init__(self, result: Dict):
        self.roll_counts = np.asarray(result["roll_counts"])
        self.terminate_reasons = np.asarray(result["terminate_reasons"])
        self.total_runs = int(result["total_runs"])

        if len(self.roll_counts) != self.total_runs:
            raise ValueError("roll_counts length mismatch total_runs")

    # -----------------------------
    # 1. 毕业抽数分布
    # -----------------------------
    def plot_roll_distribution(self, save_path="roll_distribution.png", dpi=200):
        data = self.roll_counts

        p50 = np.percentile(data, 50)
        p75 = np.percentile(data, 75)
        p95 = np.percentile(data, 95)

        # 颜色定义（与 CDF 保持一致）
        PRIMARY = "#00FFFF"

        P50_COLOR = "#00C853"
        P75_COLOR = "#FFD600"
        P95_COLOR = "#FF3D00"

        GRID_COLOR = "#B0B0B0"

        FIG_BG = "#F0F2F5"
        AX_BG = "white"

        # 创建图
        fig, ax = plt.subplots(figsize=(10, 6), facecolor=FIG_BG)
        ax.set_facecolor(AX_BG)

        # 主直方图
        ax.hist(
            data,
            bins="fd",
            density=True,
            color=PRIMARY,
            alpha=0.8,
            edgecolor="#00CED1",
            linewidth=0.8
        )

        # 网格
        ax.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=0.8,
            color=GRID_COLOR,
            alpha=0.5
        )

        # 分位竖线
        ax.axvline(p50, linestyle="--", color=P50_COLOR, linewidth=1.5)
        ax.axvline(p75, linestyle="--", color=P75_COLOR, linewidth=1.5)
        ax.axvline(p95, linestyle="--", color=P95_COLOR, linewidth=1.5)

        # 强制整数刻度
        from matplotlib.ticker import MaxNLocator
        ax.xaxis.set_major_locator(MaxNLocator(integer=True))

        # 在线顶部标注分位值
        ymax = ax.get_ylim()[1]

        ax.text(p50, ymax * 0.50, f"P50",
                color=P50_COLOR,
                ha="right",
                va="top")

        ax.text(p75, ymax * 0.75, f"P75",
                color=P75_COLOR,
                ha="right",
                va="top")

        ax.text(p95, ymax * 0.95, f"P95",

                color=P95_COLOR,
                ha="right",
                va="top")

        # 标题与标签
        ax.set_title("Roll Count Distribution")
        ax.set_xlabel("Rolls")
        ax.set_ylabel("Density")

        # 保留四边边框并加粗
        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close()




    # -----------------------------
    # 2. CDF 曲线
    # -----------------------------
    def plot_cdf(self, save_path="cdf.png", dpi=200):
        data = np.sort(self.roll_counts)
        n = len(data)
        y = np.arange(1, n + 1) / n

        p50 = int(np.percentile(data, 50))
        p75 = int(np.percentile(data, 75))
        p95 = int(np.percentile(data, 95))

        # 颜色定义
        PRIMARY = "#00FFFF"

        P50_COLOR = "#00C853"
        P75_COLOR = "#FFD600"
        P95_COLOR = "#FF3D00"

        HLINE_COLOR = "#9E9E9E"
        GRID_COLOR = "#DADDE1"

        FIG_BG = "#F0F2F5"
        AX_BG = "white"

        # 创建图
        fig, ax = plt.subplots(figsize=(10, 6), facecolor=FIG_BG)
        ax.set_facecolor(AX_BG)

        # 主 CDF 曲线
        ax.step(data, y, where="post", color=PRIMARY, linewidth=2)

        plt.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=0.8,
            color="#B0B0B0",
            alpha=0.5
        )
        # 横向分位线（灰色虚线）
        ax.axhline(0.5, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.75, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.95, linestyle="--", color=HLINE_COLOR, linewidth=1.2)

        # 1. 合并刻度（修改 Locator）
        current_yticks = list(ax.get_yticks())
        new_yticks = sorted(set(current_yticks + [0.5, 0.75, 0.95]))
        ax.set_yticks(new_yticks)

        # 2. 修改 Formatter
        
        ax.yaxis.set_major_formatter(PercentFormatter(1.0))

        # 竖向分位线（亮色虚线）
        ax.axvline(p50, linestyle="--", color=P50_COLOR, linewidth=1.5)
        ax.axvline(p75, linestyle="--", color=P75_COLOR, linewidth=1.5)
        ax.axvline(p95, linestyle="--", color=P95_COLOR, linewidth=1.5)

        

        transform = blended_transform_factory(ax.transData, ax.transAxes)

        ax.text(p50, 0.90, "P50",
                color=P50_COLOR,
                ha="right",
                va="top",
                transform=transform)

        ax.text(p75, 0.85, "P75",
                color=P75_COLOR,
                ha="right",
                va="top",
                transform=transform)

        ax.text(p95, 0.80, "P95",
                color=P95_COLOR,
                ha="right",
                va="top",
                transform=transform)

        # 强制显示关键 x 轴刻度
        current_xticks = list(ax.get_xticks())
        new_xticks = sorted(set(current_xticks + [p50, p75, p95]))
        ax.set_xticks(new_xticks)

        # 标题与标签
        ax.set_title("Empirical CDF of Roll Counts")
        ax.set_xlabel("Rolls")
        ax.set_ylabel("Cumulative Probability")

        # 保留四边边框，并略微加粗
        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

        ax.set_ylim(0, 1)

        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close()
