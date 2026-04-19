import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager, rcParams
from matplotlib.patches import FancyBboxPatch
from matplotlib.ticker import MaxNLocator, PercentFormatter
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
    figure_background: str = "#FAFAF7" # 整张图背景
    card_background: str = "#FFFFFF"   # 卡片背景
    axis_background: str = "#F3F4F2"   # 坐标区背景
    # 坐标轴边框
    spine_color: str = "#AEB6BF"
    spine_width: float = 1.2
    # 网格
    grid_color: str = "#E1E4E8"
    grid_linewidth: float = 0.8
    grid_alpha: float = 0.7
    # 轴标题
    axis_title_color: str = "#5B6570"
    # 轴刻度
    tick_color: str = "#5B6570"
    tick_labelsize: int = 10
    tick_width: float = 0.8
    tick_length: int = 4
    # 标题
    title_color: str = "#2B2F33"


@dataclass(frozen=True)
class CdfPercentileMark:
    label: str
    level: float
    color: str
    width: float
    alpha: float


@dataclass(frozen=True)
class DrawDistributionData:
    values: np.ndarray
    mean: int
    p50: int
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
    P50_COLOR = "#f9c74f"
    DRAW_DISTRIBUTION_THEME = PlotTheme(
        primary="#2F4858",
        figure_background="#EEF1F4",
        card_background="#FFFFFF",
        axis_background="#F8FAFB",
        grid_color="#DDE3E8",
        spine_color="#D7DDE3",
    )
    DRAW_DISTRIBUTION_MEAN_COLOR = "#3B82F6"
    DRAW_DISTRIBUTION_EDGE_COLOR = "#DDE3E8"
    DASHBOARD_CHIP_WIDTH = 0.125
    DASHBOARD_CHIP_HEIGHT = 0.20
    DASHBOARD_CHIP_GAP = 0.05
    DASHBOARD_CHIP_Y = 0.10
    DASHBOARD_CHIP_FONTSIZE = 8.8
    DASHBOARD_TITLE_Y = 0.88
    DRAW_DISTRIBUTION_CARD_BOUNDS = (0.075, 0.125, 0.85, 0.67)
    DRAW_DISTRIBUTION_HEADER_BOUNDS = (0.09, 0.81, 0.82, 0.14)
    DRAW_DISTRIBUTION_PLOT_BOUNDS = (0.155, 0.215, 0.705, 0.50)
    DRAW_DISTRIBUTION_FOOTER_BOUNDS = (0.09, 0.035, 0.82, 0.08)

    CDF_THEME = PlotTheme(
        primary="#2F4858",
        figure_background="#EEF1F4",
        card_background="#FFFFFF",
        axis_background="#F8FAFB",
        grid_color="#DDE3E8",
        spine_color="#D7DDE3",
    )
    CDF_PERCENTILE_MARKS = [
        CdfPercentileMark("P5", 0.05, "#1a9641", 1.5, 0.85),
        CdfPercentileMark("P25", 0.25, "#a6d96a", 1.5, 0.85),
        CdfPercentileMark("P50", 0.5, P50_COLOR, 2.0, 0.95),
        CdfPercentileMark("P75", 0.75, "#f46d43", 1.5, 0.85),
        CdfPercentileMark("P95", 0.95, "#d7191c", 2.0, 0.95),
    ]
    CDF_EMPHASIS_LABELS = {"P50", "P95"}
    CDF_CARD_BOUNDS = (0.075, 0.125, 0.85, 0.67)
    CDF_HEADER_BOUNDS = (0.09, 0.81, 0.82, 0.14)
    CDF_PLOT_BOUNDS = (0.155, 0.215, 0.705, 0.50)
    CDF_FOOTER_BOUNDS = (0.09, 0.035, 0.82, 0.08)


    def __init__(self, result: Dict):
        self.draw_count = np.asarray(result["draw_count"])
        self.terminate_reasons = np.asarray(result["terminate_reasons"])
        self.total_runs = int(result["total_runs"])

        if len(self.draw_count) != self.total_runs:
            raise ValueError("draw_count length mismatch total_runs")

    def plot_draw_distribution(self, save_path="draw_distribution.svg", dpi=500):
        plot_data = self._prepare_draw_distribution_data()
        fig, header_ax, ax, footer_ax = self._create_dashboard_figure(
            theme=self.DRAW_DISTRIBUTION_THEME,
            card_bounds=self.DRAW_DISTRIBUTION_CARD_BOUNDS,
            header_bounds=self.DRAW_DISTRIBUTION_HEADER_BOUNDS,
            plot_bounds=self.DRAW_DISTRIBUTION_PLOT_BOUNDS,
            footer_bounds=self.DRAW_DISTRIBUTION_FOOTER_BOUNDS,
        )

        self._draw_distribution_header(header_ax, plot_data)
        self._draw_distribution(ax, plot_data)
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("概率密度")
        ax.xaxis.label.set_color(self.DRAW_DISTRIBUTION_THEME.axis_title_color)
        ax.yaxis.label.set_color(self.DRAW_DISTRIBUTION_THEME.axis_title_color)
        ax.tick_params(
            axis="both",
            which="major",
            colors=self.DRAW_DISTRIBUTION_THEME.tick_color,
            labelsize=self.DRAW_DISTRIBUTION_THEME.tick_labelsize,
            width=self.DRAW_DISTRIBUTION_THEME.tick_width,
            length=self.DRAW_DISTRIBUTION_THEME.tick_length,
            direction="out",
        )
        self._draw_distribution_footer(footer_ax)

        self._save_figure(fig, save_path, dpi, tight_layout=False, bbox_tight=False)

    def plot_cdf(self, save_path="cdf.svg", dpi=500):
        plot_data = self._prepare_cdf_data()
        fig, header_ax, ax, footer_ax = self._create_dashboard_figure(
            theme=self.CDF_THEME,
            card_bounds=self.CDF_CARD_BOUNDS,
            header_bounds=self.CDF_HEADER_BOUNDS,
            plot_bounds=self.CDF_PLOT_BOUNDS,
            footer_bounds=self.CDF_FOOTER_BOUNDS,
        )

        self._draw_cdf_header(header_ax, plot_data)
        self._draw_cdf(ax, plot_data)
        ax.set_xlabel("累计抽数")
        ax.set_ylabel("成功概率")
        ax.xaxis.label.set_color(self.CDF_THEME.axis_title_color)
        ax.yaxis.label.set_color(self.CDF_THEME.axis_title_color)
        ax.tick_params(
            axis="both",
            which="major",
            colors=self.CDF_THEME.tick_color,
            labelsize=self.CDF_THEME.tick_labelsize,
            width=self.CDF_THEME.tick_width,
            length=self.CDF_THEME.tick_length,
            direction="out",
        )
        ax.set_ylim(0, 1)
        self._draw_cdf_footer(footer_ax, plot_data)

        self._save_figure(fig, save_path, dpi, tight_layout=False, bbox_tight=False)

    def _prepare_draw_distribution_data(self) -> DrawDistributionData:
        values = self.draw_count
        value_min = int(np.min(values))
        value_max = int(np.max(values))
        value_range = value_max - value_min + 1
        bin_width = self._nice_bin_width(value_range / 48)
        bin_start = (value_min // bin_width) * bin_width
        bin_end = int(np.ceil(value_max / bin_width) * bin_width)
        bins = np.arange(bin_start, bin_end + bin_width + 1, bin_width)
        if bins[-1] <= value_max:
            bins = np.append(bins, bins[-1] + bin_width)

        return DrawDistributionData(
            values=values,
            mean=int(np.mean(values)),
            p50=int(np.percentile(values, 50)),
            bins=bins,
        )

    def _nice_bin_width(self, raw_width: float) -> int:
        if raw_width <= 1:
            return 1

        magnitude = 10 ** int(np.floor(np.log10(raw_width)))
        residual = raw_width / magnitude

        if residual <= 1:
            nice = 1
        elif residual <= 2:
            nice = 2
        elif residual <= 5:
            nice = 5
        else:
            nice = 10

        return int(nice * magnitude)

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

    def _create_dashboard_figure(
        self,
        theme: PlotTheme,
        card_bounds: tuple[float, float, float, float],
        header_bounds: tuple[float, float, float, float],
        plot_bounds: tuple[float, float, float, float],
        footer_bounds: tuple[float, float, float, float],
    ):
        fig = plt.figure(figsize=(10, 6), facecolor=theme.figure_background)

        card = FancyBboxPatch(
            (card_bounds[0], card_bounds[1]),
            card_bounds[2],
            card_bounds[3],
            boxstyle="round,pad=0.012,rounding_size=0.028",
            transform=fig.transFigure,
            facecolor=theme.card_background,
            edgecolor="#E2E6EA",
            linewidth=1.0,
            zorder=-10,
        )
        fig.patches.append(card)

        header_ax = fig.add_axes(header_bounds)
        plot_ax = fig.add_axes(plot_bounds)
        footer_ax = fig.add_axes(footer_bounds)

        header_ax.set_axis_off()
        footer_ax.set_axis_off()
        header_ax.set_facecolor("none")
        footer_ax.set_facecolor("none")
        plot_ax.set_facecolor(theme.axis_background)
        return fig, header_ax, plot_ax, footer_ax

    def _draw_distribution_header(self, ax, plot_data: DrawDistributionData) -> None:
        metric_items = [
            ("MEAN", plot_data.mean, self.DRAW_DISTRIBUTION_MEAN_COLOR),
            ("P50", plot_data.p50, self.P50_COLOR),
        ]

        # Header: title and key metric chips sit on the page background.
        ax.text(
            0.5,
            self.DASHBOARD_TITLE_Y,
            "成功所需抽数分布",
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=18,
            fontweight="bold",
            color=self.DRAW_DISTRIBUTION_THEME.title_color,
        )

        chip_width = self.DASHBOARD_CHIP_WIDTH
        chip_gap = self.DASHBOARD_CHIP_GAP
        chip_start_x = 0.5 - (
            len(metric_items) * chip_width + (len(metric_items) - 1) * chip_gap
        ) / 2
        chip_y = self.DASHBOARD_CHIP_Y
        for idx, (label, value, color) in enumerate(metric_items):
            x = chip_start_x + idx * (chip_width + chip_gap)
            chip = FancyBboxPatch(
                (x, chip_y),
                chip_width,
                self.DASHBOARD_CHIP_HEIGHT,
                boxstyle="round,pad=0.012,rounding_size=0.035",
                transform=ax.transAxes,
                facecolor="#F3F6F8",
                edgecolor=color,
                linewidth=1.1,
            )
            ax.add_patch(chip)
            ax.text(
                x + 0.016,
                chip_y + self.DASHBOARD_CHIP_HEIGHT / 2,
                f"{label}  {value}",
                transform=ax.transAxes,
                ha="left",
                va="center",
                fontsize=self.DASHBOARD_CHIP_FONTSIZE,
                fontweight="bold",
                color=color,
            )

    def _draw_distribution(self, ax, plot_data: DrawDistributionData) -> None:
        theme = self.DRAW_DISTRIBUTION_THEME
        mean_color = self.DRAW_DISTRIBUTION_MEAN_COLOR
        p50_color = self.P50_COLOR

        hist_density, _, _ = ax.hist(
            plot_data.values,
            bins=plot_data.bins,
            density=True,
            color=theme.primary,
            alpha=0.82,
            edgecolor=self.DRAW_DISTRIBUTION_EDGE_COLOR,
            linewidth=0.8,
        )

        self._apply_grid(ax, theme, axis="y")
        self._apply_axis_style(ax, theme, hide_top_right=True)
        ax.xaxis.set_major_locator(MaxNLocator(nbins=16, integer=True))

        ax.axvline(
            plot_data.mean,
            linestyle=(0, (6, 3)),
            color=mean_color,
            linewidth=1.8,
            alpha=0.95,
        )
        ax.axvline(
            plot_data.p50,
            linestyle="-.",
            color=p50_color,
            linewidth=1.8,
            alpha=0.95,
        )

        peak_y = float(np.max(hist_density))
        current_ymin, _ = ax.get_ylim()
        ax.set_ylim(current_ymin, peak_y * 1.18)

        label_y = peak_y * 1.08
        mean_is_left = plot_data.mean <= plot_data.p50
        mean_ha = "right" if mean_is_left else "left"
        p50_ha = "left" if mean_is_left else "right"
        mean_text = "MEAN " if mean_is_left else " MEAN"
        p50_text = " P50" if mean_is_left else "P50 "
        ax.text(
            plot_data.mean,
            label_y,
            mean_text,
            transform=ax.transData,
            ha=mean_ha,
            va="bottom",
            color=mean_color,
            fontsize=10,
            fontweight="bold",
        )
        ax.text(
            plot_data.p50,
            label_y,
            p50_text,
            transform=ax.transData,
            ha=p50_ha,
            va="bottom",
            color=p50_color,
            fontsize=10,
            fontweight="bold",
        )

        ax.set_xlim(left=0)
        ax.set_ylim(bottom=0)
        ax.margins(x=0.015, y=0)

    def _draw_distribution_footer(self, ax) -> None:
        # Footer: short reading note sits outside the card on the page background.
        ax.text(
            0.5,
            0.62,
            "MEAN 表示平均成功抽数；P50 表示半数模拟在该抽数内成功。",
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=9.5,
            color="#6B747D",
        )

    def _draw_cdf_header(self, ax, plot_data: CdfData) -> None:
        percentile_values = plot_data.percentiles.values()

        # Header: title and percentile chips sit on the page background.
        ax.text(
            0.5,
            self.DASHBOARD_TITLE_Y,
            "累计抽数-成功概率关系",
            transform=ax.transAxes,
            ha="center",
            va="top",
            fontsize=18,
            fontweight="bold",
            color=self.CDF_THEME.title_color,
        )

        chip_width = self.DASHBOARD_CHIP_WIDTH
        chip_gap = self.DASHBOARD_CHIP_GAP
        chip_start_x = 0.5 - (
            len(self.CDF_PERCENTILE_MARKS) * chip_width
            + (len(self.CDF_PERCENTILE_MARKS) - 1) * chip_gap
        ) / 2
        chip_y = self.DASHBOARD_CHIP_Y
        for idx, (mark, value) in enumerate(
            zip(self.CDF_PERCENTILE_MARKS, percentile_values)
        ):
            x = chip_start_x + idx * (chip_width + chip_gap)
            is_emphasis = mark.label in self.CDF_EMPHASIS_LABELS
            chip = FancyBboxPatch(
                (x, chip_y),
                chip_width,
                self.DASHBOARD_CHIP_HEIGHT,
                boxstyle="round,pad=0.012,rounding_size=0.035",
                transform=ax.transAxes,
                facecolor="#F3F6F8" if is_emphasis else "#FAFBFC",
                edgecolor=mark.color,
                linewidth=1.1 if is_emphasis else 0.8,
            )
            ax.add_patch(chip)
            ax.text(
                x + 0.016,
                chip_y + self.DASHBOARD_CHIP_HEIGHT / 2,
                f"{mark.label}  {value}",
                transform=ax.transAxes,
                ha="left",
                va="center",
                fontsize=self.DASHBOARD_CHIP_FONTSIZE,
                fontweight="bold" if is_emphasis else "normal",
                color=mark.color,
            )

    def _draw_cdf(self, ax, plot_data: CdfData) -> None:
        theme = self.CDF_THEME

        ax.step(
            plot_data.values,
            plot_data.cumulative,
            where="post",
            color=theme.primary,
            linewidth=2.8,
        )

        self._apply_grid(ax, theme, axis="y")
        self._apply_axis_style(ax, theme, hide_top_right=True)
        ax.set_xlim(left=0)
        ax.set_ylim(bottom=0)
        ax.margins(x=0.015, y=0)
        ax.xaxis.set_major_locator(MaxNLocator(nbins=12, integer=True))

        percentile_values = plot_data.percentiles.values()

        ax.yaxis.set_major_locator(MaxNLocator(nbins=6))
        ax.yaxis.set_major_formatter(PercentFormatter(1.0))

        for value, mark in zip(percentile_values, self.CDF_PERCENTILE_MARKS):
            ax.plot(
                [value, value],
                [0, mark.level],
                linestyle="-.",
                color=mark.color,
                linewidth=mark.width,
                alpha=mark.alpha,
                solid_capstyle="butt",
            )

        point_sizes = [
            64 if mark.label in self.CDF_EMPHASIS_LABELS else 34
            for mark in self.CDF_PERCENTILE_MARKS
        ]
        ax.scatter(
            percentile_values,
            [mark.level for mark in self.CDF_PERCENTILE_MARKS],
            color=[mark.color for mark in self.CDF_PERCENTILE_MARKS],
            s=point_sizes,
            zorder=5,
            edgecolor="white",
            linewidth=0.8,
        )

        transform = blended_transform_factory(ax.transData, ax.transAxes)
        for value, mark in zip(percentile_values, self.CDF_PERCENTILE_MARKS):
            ax.text(
                value,
                mark.level,
                f"{mark.label} ",
                color=mark.color,
                ha="right",
                va="bottom",
                transform=transform,
                fontsize=10,
                fontweight=(
                    "bold" if mark.label in self.CDF_EMPHASIS_LABELS else "normal"
                ),
            )

    def _draw_cdf_footer(self, ax, plot_data: CdfData) -> None:
        p50 = plot_data.percentiles.p50
        p95 = plot_data.percentiles.p95

        # Footer: reading note sits outside the card on the page background.
        ax.text(
            0.5,
            0.62,
            (
                f"P50={p50} 表示半数模拟在该抽数内成功；"
                f"P95={p95} 表示 95% 模拟在该抽数内成功。\n"
                "P5/P25/P75 可同样理解。"
            ),
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=9.5,
            linespacing=1.45,
            color="#6B747D",
        )

    def _apply_grid(self, ax, theme: PlotTheme, axis: str = "both") -> None:
        ax.grid(
            True,
            which="major",
            axis=axis,
            linestyle="--",
            linewidth=theme.grid_linewidth,
            color=theme.grid_color,
            alpha=theme.grid_alpha,
        )

    def _apply_axis_style(
        self,
        ax,
        theme: PlotTheme,
        hide_top_right: bool = False,
    ) -> None:
        for spine in ax.spines.values():
            spine.set_linewidth(theme.spine_width)
            spine.set_color(theme.spine_color)
        if hide_top_right:
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
            ax.spines["left"].set_linewidth(0.9)
            ax.spines["bottom"].set_linewidth(0.9)
            ax.spines["left"].set_color("#D7DDE3")
            ax.spines["bottom"].set_color("#D7DDE3")

    def _save_figure(
        self,
        fig,
        save_path: str,
        dpi: int,
        tight_layout: bool = True,
        bbox_tight: bool = True,
    ) -> None:
        if tight_layout:
            plt.tight_layout()
        bbox_inches = "tight" if bbox_tight else None
        plt.savefig(
            save_path,
            dpi=dpi,
            facecolor=fig.get_facecolor(),
            bbox_inches=bbox_inches,
            pad_inches=0.12 if bbox_tight else 0,
        )
        plt.close(fig)
