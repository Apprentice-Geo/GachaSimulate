export const ANIMATION_TOTAL_MS = 5300;
export const EXPORT_BUFFER_MS = 500;

export const ANIMATION_TIMELINE = {
  TOP_BAR_DELAY_MS: 120, // top-bar 标题和操作按钮开始浮现的时间
  TOP_BAR_DURATION_MS: 360, // top-bar 浮现持续时间
  CHART_SHELL_DELAY_MS: 560, // CDF 图背景卡片开始浮现的时间
  CHART_SHELL_DURATION_MS: 420, // CDF 图背景卡片浮现持续时间
  CHART_SURFACE_DELAY_MS: 700, // Recharts 坐标轴、网格和刻度开始浮现的时间
  CHART_SURFACE_DURATION_MS: 360, // Recharts 坐标轴、网格和刻度浮现持续时间
  CURVE_DELAY_MS: 1000, // CDF 阶梯曲线开始绘制的时间
  CURVE_DURATION_MS: 1300, // CDF 阶梯曲线绘制持续时间
  MARKER_LINE_DELAY_MS: 2300, // 分位数竖向标注线开始出现的时间
  MARKER_LINE_DURATION_MS: 320, // 分位数竖向标注线伸展持续时间
  MARKER_GROUP_DELAY_MS: 2360, // 分位数标注点和文字开始浮现的时间
  MARKER_GROUP_DURATION_MS: 280, // 分位数标注点和文字浮现持续时间
  MARKER_STAGGER_MS: 36, // 各分位数标注之间的错峰间隔
  MEAN_LINE_DELAY_MS: 2500, // MEAN 横向虚线开始出现的时间
  MEAN_LINE_DURATION_MS: 320, // MEAN 横向虚线伸展持续时间
  TERMINATION_PANEL_DELAY_MS: 2920, // 终止条件卡片开始浮现的时间
  TERMINATION_PANEL_DURATION_MS: 380, // 终止条件卡片浮现持续时间
  PK_FILL_DELAY_MS: 3260, // 终止条件 PK 条开始填充的时间
  PK_FILL_DURATION_MS: 420, // 终止条件 PK 条填充持续时间
  TERMINATION_DETAIL_DELAY_MS: 3400, // 终止原因图例开始浮现的时间
  TERMINATION_DETAIL_DURATION_MS: 320, // 终止原因图例浮现持续时间
  STAT_PANEL_DELAY_MS: 3820, // 核心统计量背景卡片开始浮现的时间
  STAT_PANEL_DURATION_MS: 380, // 核心统计量背景卡片浮现持续时间
  STAT_CONTENT_DELAY_MS: 4200, // 核心统计量列表内容开始自上而下浮现的时间
  STAT_CONTENT_DURATION_MS: 320, // 单个统计量标题或卡片浮现持续时间
  STAT_CONTENT_STAGGER_MS: 55, // 核心统计量列表内容之间的错峰间隔
} as const;
