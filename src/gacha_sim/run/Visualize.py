import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager, rcParams
from matplotlib.ticker import PercentFormatter
from matplotlib.transforms import blended_transform_factory

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


@dataclass(frozen=True)
class PlotTheme:
    primary: str
    grid: str
    figure_background: str
    axis_background: str
    legend_background: str = "white"
    legend_edge: str = "#E0E0E0"
    spine_width: float = 1.2
    grid_linewidth: float = 0.8
    grid_alpha: float = 0.5
    legend_alpha: float = 0.95


@dataclass(frozen=True)
class DrawDistributionData:
    values: np.ndarray
    mean: int
    bins: np.ndarray


@dataclass(frozen=True)
class CdfPercentiles:
    p5: int
    p25: int
    p50: int
    p75: int
    p95: int

    def values(self) -> list[int]:
        return [self.p5, self.p25, self.p50, self.p75, self.p95]


@dataclass(frozen=True)
class CdfData:
    values: np.ndarray
    cumulative: np.ndarray
    percentiles: CdfPercentiles


class Visualizer:
    DRAW_DISTRIBUTION_THEME = PlotTheme(
        primary="#00FFFF",
        grid="#B0B0B0",
        figure_background="#F0F2F5",
        axis_background="white",
    )
    DRAW_DISTRIBUTION_MEAN_COLOR = "#00FF00"
    DRAW_DISTRIBUTION_EDGE_COLOR = "#00CED1"

    CDF_THEME = PlotTheme(
        primary="#00FFFF",
        grid="#B0B0B0",
        figure_background="#F0F2F5",
        axis_background="white",
    )
    CDF_REFERENCE_LINE_COLOR = "#9E9E9E"
    CDF_PERCENTILE_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95]
    CDF_PERCENTILE_LABELS = ["P5", "P25", "P50", "P75", "P95"]
    CDF_PERCENTILE_COLORS = ["#A020F0", "#00FF00", "#0000FF", "#FFD700", "#FF0000"]

    def __init__(self, result: Dict):
        self.draw_count = np.asarray(result["draw_count"])
        self.terminate_reasons = np.asarray(result["terminate_reasons"])
        self.total_runs = int(result["total_runs"])

        if len(self.draw_count) != self.total_runs:
            raise ValueError("draw_count length mismatch total_runs")

    def plot_draw_distribution(self, save_path="draw_distribution.svg", dpi=500):
        plot_data = self._prepare_draw_distribution_data()
        fig, ax = self._create_figure(self.DRAW_DISTRIBUTION_THEME)

        self._draw_distribution(ax, plot_data)
        self._apply_common_axis_style(ax)

        ax.set_title("累计抽数分布")
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("概率密度")

        self._save_figure(fig, save_path, dpi)

    def plot_cdf(self, save_path="cdf.svg", dpi=500):
        plot_data = self._prepare_cdf_data()
        fig, ax = self._create_figure(self.CDF_THEME)

        self._draw_cdf(ax, plot_data)
        self._apply_common_axis_style(ax)

        ax.set_title("累计成功概率")
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("累计概率")
        ax.set_ylim(0, 1)

        self._save_figure(fig, save_path, dpi)

    def _prepare_draw_distribution_data(self) -> DrawDistributionData:
        values = self.draw_count
        value_min = int(np.min(values))
        value_max = int(np.max(values))
        value_range = value_max - value_min + 1
        bin_width = max(1, int(np.ceil(value_range / 64)))
        bins = np.arange(value_min, value_max + bin_width + 1, bin_width)
        if bins[-1] <= value_max:
            bins = np.append(bins, bins[-1] + bin_width)

        return DrawDistributionData(
            values=values,
            mean=int(np.mean(values)),
            bins=bins,
        )

    def _prepare_cdf_data(self) -> CdfData:
        values = np.sort(self.draw_count)
        count = len(values)
        cumulative = np.arange(1, count + 1) / count

        return CdfData(
            values=values,
            cumulative=cumulative,
            percentiles=CdfPercentiles(
                p5=int(np.percentile(values, 5)),
                p25=int(np.percentile(values, 25)),
                p50=int(np.percentile(values, 50)),
                p75=int(np.percentile(values, 75)),
                p95=int(np.percentile(values, 95)),
            ),
        )

    def _create_figure(self, theme: PlotTheme):
        fig, ax = plt.subplots(figsize=(10, 6), facecolor=theme.figure_background)
        ax.set_facecolor(theme.axis_background)
        return fig, ax

    def _draw_distribution(self, ax, plot_data: DrawDistributionData) -> None:
        theme = self.DRAW_DISTRIBUTION_THEME
        mean_color = self.DRAW_DISTRIBUTION_MEAN_COLOR

        hist_density, _, _ = ax.hist(
            plot_data.values,
            bins=plot_data.bins,
            density=True,
            color=theme.primary,
            alpha=0.85,
            edgecolor=self.DRAW_DISTRIBUTION_EDGE_COLOR,
            linewidth=0.8,
        )

        self._apply_grid(ax, theme)
        ax.set_xticks(
            np.unique(np.concatenate(([0], plot_data.bins[0::8], [plot_data.bins.max()])))
        )

        line_mean = ax.axvline(
            plot_data.mean,
            linestyle="--",
            color=mean_color,
            linewidth=1.5,
        )

        peak_y = float(np.max(hist_density))
        current_ymin, _ = ax.get_ylim()
        ax.set_ylim(current_ymin, peak_y * 1.05)

        transform = blended_transform_factory(ax.transData, ax.transAxes)
        ax.text(
            plot_data.mean,
            0.98,
            "MEAN ",
            transform=transform,
            ha="right",
            va="top",
            color=mean_color,
        )

        ax.set_xlim(left=0)
        ax.set_ylim(bottom=0)
        ax.margins(x=0, y=0)

        legend = ax.legend(
            handles=[line_mean],
            labels=[f"MEAN:{plot_data.mean}"],
            loc="upper left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8,
        )
        self._style_legend(legend, [mean_color])

    def _draw_cdf(self, ax, plot_data: CdfData) -> None:
        theme = self.CDF_THEME

        ax.step(
            plot_data.values,
            plot_data.cumulative,
            where="post",
            color=theme.primary,
            linewidth=2,
        )

        self._apply_grid(ax, theme)
        ax.set_xlim(left=0)
        ax.set_ylim(bottom=0)
        ax.margins(x=0, y=0)

        percentile_values = plot_data.percentiles.values()
      
        current_yticks = list(ax.get_yticks())
        new_yticks = sorted(set(current_yticks + self.CDF_PERCENTILE_LEVELS))
        ax.set_yticks(new_yticks)
        ax.yaxis.set_major_formatter(PercentFormatter(1.0))

        percentile_lines = []
        for value, color in zip(percentile_values, self.CDF_PERCENTILE_COLORS):
            percentile_lines.append(
                ax.axvline(value, linestyle="--", color=color, linewidth=1.5)
            )

        plt.scatter(
            percentile_values,
            self.CDF_PERCENTILE_LEVELS,
            color=self.CDF_PERCENTILE_COLORS,
            s=40,
            zorder=5,
        )

        transform = blended_transform_factory(ax.transData, ax.transAxes)
        for label, value, level, color in zip(
            self.CDF_PERCENTILE_LABELS,
            percentile_values,
            self.CDF_PERCENTILE_LEVELS,
            self.CDF_PERCENTILE_COLORS,
        ):
            ax.text(
                value,
                level,
                f"{label} ",
                color=color,
                ha="right",
                va="bottom",
                transform=transform,
            )

        legend_labels = [
            f"{label}:{value}"
            for label, value in zip(self.CDF_PERCENTILE_LABELS, percentile_values)
        ]
        legend = ax.legend(
            handles=percentile_lines,
            labels=legend_labels,
            loc="upper left",
            frameon=True,
            fancybox=True,
            shadow=False,
            borderpad=0.8,
        )
        self._style_legend(legend, self.CDF_PERCENTILE_COLORS)

    def _apply_grid(self, ax, theme: PlotTheme) -> None:
        ax.grid(
            True,
            which="major",
            axis="both",
            linestyle="--",
            linewidth=theme.grid_linewidth,
            color=theme.grid,
            alpha=theme.grid_alpha,
        )

    def _style_legend(self, legend, text_colors: list[str]) -> None:
        frame = legend.get_frame()
        frame.set_facecolor("white")
        frame.set_edgecolor("#E0E0E0")
        frame.set_linewidth(0.8)
        frame.set_alpha(0.95)

        for text, color in zip(legend.get_texts(), text_colors):
            text.set_color(color)

    def _apply_common_axis_style(self, ax) -> None:
        for spine in ax.spines.values():
            spine.set_linewidth(1.2)

    def _save_figure(self, fig, save_path: str, dpi: int) -> None:
        plt.tight_layout()
        plt.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor())
        plt.close(fig)
