import os
import numpy as np
from matplotlib import rcParams, font_manager
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter,MaxNLocator
from matplotlib.transforms import blended_transform_factory
from typing import Dict

# 当前文件所在目录（src）
current_dir = os.path.dirname(os.path.abspath(__file__))

# 项目根目录
project_root = os.path.dirname(current_dir)

# 字体路径
font_path = os.path.join(
    project_root,
    "fonts",
    "SourceHanSansSC-Medium.otf"
)

# 注册字体
font_manager.fontManager.addfont(font_path)
prop = font_manager.FontProperties(fname=font_path)

# 强制使用该字体
rcParams["font.family"] = "sans-serif"
rcParams["font.sans-serif"] = [prop.get_name()]
rcParams["axes.unicode_minus"] = False

class Visualizer:

    def __init__(self, result: Dict):
        self.roll_counts = np.asarray(result["roll_counts"])
        self.terminate_reasons = np.asarray(result["terminate_reasons"])
        self.total_runs = int(result["total_runs"])

        if len(self.roll_counts) != self.total_runs:
            raise ValueError("roll_counts length mismatch total_runs")

    def plot_roll_distribution(self, save_path="roll_distribution.png", dpi=200):
        data = self.roll_counts

        p50 = int(np.percentile(data, 50))
        p75 = int(np.percentile(data, 75))
        p95 = int(np.percentile(data, 95))

        PRIMARY = "#00FFFF"
        P50_COLOR = "#00C853"
        P75_COLOR = "#FFD600"
        P95_COLOR = "#FF3D00"
        GRID_COLOR = "#B0B0B0"

        FIG_BG = "#F0F2F5"
        AX_BG = "white"

        fig, ax = plt.subplots(figsize=(10, 6), facecolor=FIG_BG)
        ax.set_facecolor(AX_BG)

        ax.hist(
            data,
            bins="fd",
            density=True,
            color=PRIMARY,
            alpha=0.8,
            edgecolor="#00CED1",
            linewidth=0.8
        )

        ax.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=0.8,
            color=GRID_COLOR,
            alpha=0.5
        )

        # 分位竖线（保留）
        line50 = ax.axvline(p50, linestyle="--", color=P50_COLOR, linewidth=1.5)
        line75 = ax.axvline(p75, linestyle="--", color=P75_COLOR, linewidth=1.5)
        line95 = ax.axvline(p95, linestyle="--", color=P95_COLOR, linewidth=1.5)

        
        ax.xaxis.set_major_locator(MaxNLocator(integer=True))

        ymax = ax.get_ylim()[1]
        ax.text(p50, ymax * 0.90, f"P50", color=P50_COLOR, ha="right", va="top")
        ax.text(p75, ymax * 0.85, f"P75", color=P75_COLOR, ha="right", va="top")
        ax.text(p95, ymax * 0.80, f"P95", color=P95_COLOR, ha="left", va="top")

        # 左下角图例
        legend = ax.legend(
            handles=[line50, line75, line95],
            labels=[
                f"P50：{p50}",
                f"P75：{p75}",
                f"P95：{p95}"
            ],
            loc="lower left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8
        )

        # 卡片样式
        frame = legend.get_frame()
        frame.set_facecolor("white")
        frame.set_edgecolor("#E0E0E0")
        frame.set_linewidth(0.8)
        frame.set_alpha(0.95)

        # 图例文字颜色匹配线条
        for text, color in zip(
            legend.get_texts(),
            [P50_COLOR, P75_COLOR, P95_COLOR]
        ):
            text.set_color(color)

        ax.set_title("累计抽数分布")
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("概率密度")

        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close()

    def plot_cdf(self, save_path="cdf.png", dpi=200):
        data = np.sort(self.roll_counts)
        n = len(data)
        y = np.arange(1, n + 1) / n

        p50 = int(np.percentile(data, 50))
        p75 = int(np.percentile(data, 75))
        p95 = int(np.percentile(data, 95))

        PRIMARY = "#00FFFF"
        P50_COLOR = "#00C853"
        P75_COLOR = "#FFD600"
        P95_COLOR = "#FF3D00"

        HLINE_COLOR = "#9E9E9E"
        GRID_COLOR = "#DADDE1"

        FIG_BG = "#F0F2F5"
        AX_BG = "white"

        fig, ax = plt.subplots(figsize=(10, 6), facecolor=FIG_BG)
        ax.set_facecolor(AX_BG)

        ax.step(data, y, where="post", color=PRIMARY, linewidth=2)

        ax.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=0.8,
            color="#B0B0B0",
            alpha=0.5
        )

        ax.axhline(0.5, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.75, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.95, linestyle="--", color=HLINE_COLOR, linewidth=1.2)

        current_yticks = list(ax.get_yticks())
        new_yticks = sorted(set(current_yticks + [0.5, 0.75, 0.95]))
        ax.set_yticks(new_yticks)

        ax.yaxis.set_major_formatter(PercentFormatter(1.0))

        # 竖向分位线
        line50 = ax.axvline(p50, linestyle="--", color=P50_COLOR, linewidth=1.5)
        line75 = ax.axvline(p75, linestyle="--", color=P75_COLOR, linewidth=1.5)
        line95 = ax.axvline(p95, linestyle="--", color=P95_COLOR, linewidth=1.5)

        transform = blended_transform_factory(ax.transData, ax.transAxes)
        ax.text(p50, 0.90, "P50", color=P50_COLOR, ha="right", va="top", transform=transform)
        ax.text(p75, 0.85, "P75", color=P75_COLOR, ha="right", va="top", transform=transform)
        ax.text(p95, 0.80, "P95", color=P95_COLOR, ha="left", va="top", transform=transform)


        # 左下角图例
        legend = ax.legend(
            handles=[line50, line75, line95],
            labels=[
                f"P50：{p50}",
                f"P75：{p75}",
                f"P95：{p95}"
            ],
            loc="lower left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8
        )

        # 卡片样式
        frame = legend.get_frame()
        frame.set_facecolor("white")
        frame.set_edgecolor("#E0E0E0")
        frame.set_linewidth(0.8)
        frame.set_alpha(0.95)

        # 图例文字颜色匹配线条
        for text, color in zip(
            legend.get_texts(),
            [P50_COLOR, P75_COLOR, P95_COLOR]
        ):
            text.set_color(color)

        ax.set_title("累计成功概率")
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("累计概率")

        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

        ax.set_ylim(0, 1)

        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close()

    
