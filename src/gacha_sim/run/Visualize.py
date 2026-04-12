import os
from pathlib import Path
import numpy as np
from matplotlib import rcParams, font_manager
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter, MaxNLocator
from matplotlib.transforms import blended_transform_factory
from typing import Dict

# 项目根目录
project_root = Path(__file__).resolve().parents[3]

# 字体路径
font_path = os.path.join(project_root, "fonts", "SourceHanSansSC-Medium.otf")

# 注册字体
font_manager.fontManager.addfont(font_path)
prop = font_manager.FontProperties(fname=font_path)

# 强制使用该字体
rcParams["font.family"] = "sans-serif"
rcParams["font.sans-serif"] = [prop.get_name()]
rcParams["axes.unicode_minus"] = False


class Visualizer:

    def __init__(self, result: Dict):
        self.draw_count = np.asarray(result["draw_count"])
        self.terminate_reasons = np.asarray(result["terminate_reasons"])
        self.total_runs = int(result["total_runs"])

        if len(self.draw_count) != self.total_runs:
            raise ValueError("draw_count length mismatch total_runs")

    def plot_draw_distribution(self, save_path="draw_distribution.png", dpi=500):
        data = self.draw_count

        p_mean = int(np.mean(data))

        PRIMARY = "#00FFFF"
        MEAN_COLOR = "#00FF00"
        GRID_COLOR = "#B0B0B0"

        FIG_BG = "#F0F2F5"
        AX_BG = "white"

        fig, ax = plt.subplots(figsize=(10, 6), facecolor=FIG_BG)
        ax.set_facecolor(AX_BG)

        bins = np.arange(min(data), max(data) + 2) - 0.5

        hist_density, _, _ = ax.hist(
            data,
            bins=bins,
            density=True,
            color=PRIMARY,
            alpha=0.85,
            edgecolor="#00CED1",
            linewidth=0.8,
        )

        peak_y = float(np.max(hist_density))
        text_y = peak_y * 1.05
        current_ymin, current_ymax = ax.get_ylim()
        if text_y > current_ymax:
            ax.set_ylim(current_ymin, text_y * 1.05)

        ax.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=0.8,
            color=GRID_COLOR,
            alpha=0.5,
        )

        line_mean = ax.axvline(p_mean, linestyle="--", color=MEAN_COLOR, linewidth=1.5)
        ax.text(
            p_mean,
            text_y,
            "MEAN ",
            color=MEAN_COLOR,
            ha="right",
            va="bottom",
        )
        # 左下角图例
        legend = ax.legend(
            handles=[line_mean],
            labels=[
                f"MEAN:{p_mean}",
            ],
            loc="lower left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8,
        )

        # 卡片样式
        frame = legend.get_frame()
        frame.set_facecolor("white")
        frame.set_edgecolor("#E0E0E0")
        frame.set_linewidth(0.8)
        frame.set_alpha(0.95)

        # 图例文字颜色匹配线条
        for text, color in zip(legend.get_texts(), [MEAN_COLOR]):
            text.set_color(color)

        ax.set_title("累计抽数分布")
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("概率密度")

        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close()

    def plot_cdf(self, save_path="cdf.png", dpi=500):
        data = np.sort(self.draw_count)
        n = len(data)
        y = np.arange(1, n + 1) / n

        p5 = int(np.percentile(data, 5))
        p25 = int(np.percentile(data, 25))
        p50 = int(np.percentile(data, 50))
        p75 = int(np.percentile(data, 75))
        p95 = int(np.percentile(data, 95))

        PRIMARY = "#00FFFF"
        P5_COLOR = "#A020F0"
        P25_COLOR = "#00FF00"
        P50_COLOR = "#0000FF"
        P75_COLOR = "#FFD700"
        P95_COLOR = "#FF0000"
        HLINE_COLOR = "#9E9E9E"
        GRID_COLOR = "#B0B0B0"

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
            color=GRID_COLOR,
            alpha=0.5,
        )

        ax.axhline(0.05, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.25, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.5, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.75, linestyle="--", color=HLINE_COLOR, linewidth=1.2)
        ax.axhline(0.95, linestyle="--", color=HLINE_COLOR, linewidth=1.2)

        current_yticks = list(ax.get_yticks())
        new_yticks = sorted(set(current_yticks + [0.05, 0.25, 0.5, 0.75, 0.95]))
        ax.set_yticks(new_yticks)

        ax.yaxis.set_major_formatter(PercentFormatter(1.0))

        # 竖向分位线
        line5 = ax.axvline(p5, linestyle="--", color=P5_COLOR, linewidth=1.5)
        line25 = ax.axvline(p25, linestyle="--", color=P25_COLOR, linewidth=1.5)
        line50 = ax.axvline(p50, linestyle="--", color=P50_COLOR, linewidth=1.5)
        line75 = ax.axvline(p75, linestyle="--", color=P75_COLOR, linewidth=1.5)
        line95 = ax.axvline(p95, linestyle="--", color=P95_COLOR, linewidth=1.5)

        # 分位线交点
        plt.scatter(
            [p5, p25, p50, p75, p95],
            [0.05, 0.25, 0.5, 0.75, 0.95],
            color=[P5_COLOR, P25_COLOR, P50_COLOR, P75_COLOR, P95_COLOR],
            s=40,
            zorder=5,
        )

        # 分别使用数据坐标和轴坐标的混合坐标系来放置文本，使其既能贴近分位线又能固定在图的上方
        transform = blended_transform_factory(ax.transData, ax.transAxes)
        ax.text(
            p5,
            0.05,
            "P5 ",
            color=P5_COLOR,
            ha="right",
            va="bottom",
            transform=transform,
        )
        ax.text(
            p25,
            0.25,
            "P25 ",
            color=P25_COLOR,
            ha="right",
            va="bottom",
            transform=transform,
        )
        ax.text(
            p50,
            0.50,
            "P50 ",
            color=P50_COLOR,
            ha="right",
            va="bottom",
            transform=transform,
        )
        ax.text(
            p75,
            0.75,
            "P75 ",
            color=P75_COLOR,
            ha="right",
            va="bottom",
            transform=transform,
        )
        ax.text(
            p95,
            0.95,
            "P95 ",
            color=P95_COLOR,
            ha="right",
            va="bottom",
            transform=transform,
        )

        # 左下角图例
        legend = ax.legend(
            handles=[line5, line25, line50, line75, line95],
            labels=[
                f"P5:{p5}",
                f"P25:{p25}",
                f"P50:{p50}",
                f"P75:{p75}",
                f"P95:{p95}",
            ],
            loc="lower left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8,
        )

        # 卡片样式
        frame = legend.get_frame()
        frame.set_facecolor("white")
        frame.set_edgecolor("#E0E0E0")
        frame.set_linewidth(0.8)
        frame.set_alpha(0.95)

        # 图例文字颜色匹配线条
        for text, color in zip(
            legend.get_texts(), [P5_COLOR, P25_COLOR, P50_COLOR, P75_COLOR, P95_COLOR]
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
