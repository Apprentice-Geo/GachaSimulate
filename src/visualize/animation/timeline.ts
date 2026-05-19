export const ANIMATION_TOTAL_MS = 5300;
export const EXPORT_BUFFER_MS = 500;

export const ANIMATION_TIMELINE = {
  TOP_BAR_DELAY_MS: 100, // top-bar 标题和操作按钮开始浮现的时间
  TOP_BAR_DURATION_MS: 200, // top-bar 浮现持续时间
  CHART_SHELL_DELAY_MS: 400, // CDF 图背景卡片开始浮现的时间
  CHART_SHELL_DURATION_MS: 300, // CDF 图背景卡片浮现持续时间
  CHART_SURFACE_DELAY_MS: 700, // Recharts 坐标轴、网格和刻度开始浮现的时间
  CHART_SURFACE_DURATION_MS: 200, // Recharts 坐标轴、网格和刻度浮现持续时间
  CURVE_DELAY_MS: 900, // CDF 阶梯曲线开始绘制的时间
  CURVE_DURATION_MS: 800, // CDF 阶梯曲线绘制持续时间
  MARKER_LINE_DELAY_MS: 1600, // 分位数竖向标注线开始出现的时间
  MARKER_LINE_DURATION_MS: 300, // 分位数竖向标注线伸展持续时间
  MARKER_GROUP_DELAY_MS: 1900, // 分位数标注点和文字开始浮现的时间
  MARKER_GROUP_DURATION_MS: 200, // 分位数标注点和文字浮现持续时间
  MARKER_STAGGER_MS: 50, // 各分位数标注之间的错峰间隔
  MEAN_LINE_DELAY_MS: 1800, // MEAN 横向虚线开始出现的时间
  MEAN_LINE_DURATION_MS: 300, // MEAN 横向虚线伸展持续时间
  TERMINATION_PANEL_DELAY_MS: 2200, // 终止条件卡片开始浮现的时间
  TERMINATION_PANEL_DURATION_MS: 300, // 终止条件卡片浮现持续时间
  PK_FILL_DELAY_MS: 2500, // 终止条件 PK 条开始填充的时间
  PK_FILL_DURATION_MS: 400, // 终止条件 PK 条填充持续时间
  TERMINATION_DETAIL_DELAY_MS: 2800, // 终止原因图例开始浮现的时间
  TERMINATION_DETAIL_DURATION_MS: 200, // 终止原因图例浮现持续时间
  STAT_PANEL_DELAY_MS: 3000, // 核心统计量背景卡片开始浮现的时间
  STAT_PANEL_DURATION_MS: 300, // 核心统计量背景卡片浮现持续时间
  STAT_CONTENT_DELAY_MS: 3300, // 核心统计量列表内容开始自上而下浮现的时间
  STAT_CONTENT_DURATION_MS: 200, // 单个统计量卡片浮现持续时间
  STAT_CONTENT_STAGGER_MS: 50, // 核心统计量列表内容之间的错峰间隔
  NOTE_DELAY_MS: 3700, // 底部注释在其它组件浮现完成后开始浮现的时间
  NOTE_DURATION_MS: 300, // 底部注释浮现持续时间
} as const;
