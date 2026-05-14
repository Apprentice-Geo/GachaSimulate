# 项目概述

[`visualize`](/src/visualize/) 是抽卡模拟器的前端可视化子项目。

它负责读取模拟器输出的数据文件，生成适合视频展示的 CDF 曲线分析页面，并通过浏览器自动化工具导出：

- 静态结果图：PNG
- 绘制过程视频：WebM
- 转码后视频：MP4

本项目不负责抽卡模拟计算，只负责模拟结果的可视化展示与素材导出。

# 技术栈

主技术栈：
React + TypeScript + Vite
React：前端UI库，负责写页面
TypeScript：编程语言，负责写逻辑并约束数据类型
Vite：前端构建工具，负责启动、开发、打包项目

图表：
Recharts

动画：
Motion + CSS + 少量自定义 SVG 动画

导出：
Playwright 控制 Chromium
截图输出 PNG
录屏输出 WebM
FFmpeg 转 MP4

# 布局要求

- 1920x1080 的单页展示界面；
- CDF 主曲线必须是画面中最重要的视觉元素；
- 顶部显示标题，与 CDF 曲线图应该左对齐，右端为数据导入按钮；
- 标题下方使用小字号显示模拟目标和实际模拟抽数
- 右侧从上到下显示 P5/P25/P50/P75/P95、均值、最小值、最大值、单抽成本这九个核心统计量，单抽成本单位为RMB，其余均为抽；
- 上述九个统计量应该以并列的视觉逻辑展示，例如每一个统计量占据一行布局空间
- 底部显示模拟目标，终止原因及其比例，终止原因至少有一种，至多有两种，比例使用PK条的形式展示，如果只有一种原因则填满单条即可；
- 最底部保留可选小字号注释；
- 不要牺牲数据可读性来追求装饰感；
- 页面外边距：64px；
- 顶部标题区高度：96px；
- 主内容区高度：760px；
- 主内容区域左右布局，左侧 CDF 图表区域约 62%，右侧统计面板区域约 38%，即符合黄金分割比；
- 底部说明区高度：140px。

  
# 页面布局比例

画布尺寸固定为 1920x1080。

推荐布局：

- 页面外边距：64px
- 顶部标题区高度：96px
- 主内容区高度：760px
- 底部说明区高度：140px

主内容区采用左右布局：

- 左侧 CDF 图表区域：约 62%
- 右侧统计面板区域：约 38%

左侧图表必须是视觉主体，右侧统计卡片不能抢占图表注意力。

# CDF曲线
- 原实现为[模拟项目可视化](/src/simulate/visualize.py)中的CDF曲线，它的审美设计与该项目的需求不一致，因此主要参考其统计意义以及统计量标注方法。
- X 轴表示抽数，显示为整数。
- Y 轴表示累计概率 CDF，显示为百分比。
- P5/P25/P50/P75/P95/MIN/MAX 使用竖向虚线标记，虚线从 x 轴开始，到对应抽数的 CDF 概率高度结束，即与曲线相交并绘制交点就结束。
- MEAN同时使用竖向和横向虚线标记，虚线从x和y轴开始，到 MEAN_LEVEL 和到 MEAN 结束，即与曲线相交并绘制交点就结束。
- MEAN和P50常常会比较接近，文字标注可参考[模拟项目可视化](/src/simulate/visualize.py):385-411行的做法避免重叠
- CDF 图中的标记虚线视觉权重需要区分，P50 的视觉权重最高，MAX/P95/MEAN 次之，P25/P75 更弱，MIN/P5最弱。
- 网格线必须低对比，不能干扰主曲线。
- 坐标轴刻度必须清晰可读。
- 不允许为了美观改变 CDF 数据，完全按照输入数据绘制即可。

# 视觉风格
视觉风格：

Sentry 作为整体 UI 语言，NVIDIA 只提供科技感细节。

- 不使用 Sentry 贴纸/吉祥物/大营销 hero。
- 不使用 NVIDIA 全黑 hero/footer 结构。
- 采用 Sentry 的信息层级、卡片密度、字体节奏。
- 采用 NVIDIA 的绿色语义、细线、角标、技术感点缀。

主曲线：Cyan #22d3ee

MIN，P5 ~ P95，MAX：使用符合改项目模拟语义的颜色

 | 标记     | 推荐颜色 | 来源/语义                                  |
 | -------- | -------: | ------------------------------------------ |
 | MIN / P5 |  #3f8500 | NVIDIA success-deep，低抽数/较优结果       |
 | P25      |  #76b900 | NVIDIA primary green，低抽数偏优           |
 | P50      |  #bff230 | NVIDIA accent-green-pale，核心中位数       |
 | MEAN     |  #fa7faa | Sentry accent-pink，平均值，独立于分位语义 |
 | P75      |  #ef9100 | NVIDIA warning-bright，偏高抽数            |
 | P95      |  #df6500 | NVIDIA warning，高抽数风险                 |
 | MAX      |  #e52020 | NVIDIA error，最差尾部                     |

Sentry风格文档：[Sentry](./Sentry.md)

NVIDIA风格文档：[NVIDIA](./NVIDIA.md)

# 交互设计

本项目核心是导出视频可用素材，目前不需要过多交互效果。
只需要使用数据导入按钮导入数据以后，数据导入按钮无需显示明确文字，可替换为合适的图标。约3秒绘制动画用于绘制 CDF 曲线图和其它元素。
导入行为统一为读取一份模拟器导出的 json 输入文件。
输入文件可以通过顶部右侧数据导入按钮选择，也可以通过 URL 参数 `?input=<json文件路径>` 指定,其中json文件路径保证在该项目内，使用相对于项目根目录\的相对路径格式。
两种导入方式进入同一套加载、解析、展示和动画逻辑。

导入状态：
- 未导入数据时，页面显示基础布局和导入入口，不展示伪造图表数据。
- 正在加载数据时，保留 1920x1080 布局，显示克制的加载状态。
- 导入失败时，展示明确错误信息，保留重新导入入口；导出脚本遇到导入失败应直接失败退出。
- 应在页面中设置一个信号用于 Playwright 查询数据是否导入完毕

动画触发：
- 页面提供一个重新绘制动画按钮，用于从初始绘制状态重新播放约 3 秒动画。
- 重新绘制按钮应使用稳定选择器，例如 `data-testid="replay-animation"`，供 Playwright 自动点击。
- 导入数据后自动播放一次动画，也可以通过重新绘制按钮再次播放。
- 导出视频时，Playwright 在数据加载完成并进入可绘制状态后先开始录屏，再点击重新绘制按钮。
- 重新绘制期间按钮应禁用，避免重复触发导致动画状态错乱。

参考时间线
- 0.0s - 0.3s：页面背景、主卡片、标题淡入
- 0.3s - 1.8s：CDF 曲线从左到右绘制
- 1.2s - 2.2s：分位线依次出现
- 1.8s - 2.6s：右侧统计卡片依次出现
- 2.4s - 3.0s：底部规则说明与注释出现
动画应当克制、平滑，不使用夸张弹跳效果。

# 输出规格

默认输出目录为 `outputs/`。

- PNG：`outputs/cdf-result.png`
  - 尺寸：1920x1080
  - 时机：动画完成后截图
  - 用途：视频静态截图素材

- WebM：`outputs/cdf-animation.webm`
  - 尺寸：1920x1080
  - 帧率：60 FPS
  - 时长：约 3 秒
  - 时机：数据加载完成并进入可绘制状态后开始录屏，点击重新绘制按钮，等待动画时长结束后停止录屏
  - 用途：浏览器原始录屏文件

- MP4：`outputs/cdf-animation.mp4`
  - 由 FFmpeg 从 WebM 转码得到
  - 编码：H.264
  - 用途：剪辑软件导入

导出环境要求：
- 浏览器视口固定为 1920x1080。
- 设备缩放固定为 1。
- 截图与录屏前等待字体加载完成。
- 导出素材中不显示文件选择弹窗、错误提示、开发调试信息。
- 导出脚本通过重新绘制按钮触发动画，不依赖前端暴露的全局完成信号。
- 动画总时长应使用前端常量集中定义，Playwright 等待该时长加少量缓冲后截图或停止录屏。
- Playwright 导出失败时不生成部分成功的最终产物；如 WebM 转 MP4 失败，应保留 WebM 以便排查。

# 前端脚本命令

前端可视化子项目通过仓库根目录 `package.json` 的 npm scripts 提供统一入口，避免开发、测试和导出流程依赖手工命令。

推荐命令：

```json
{
  "dev": "vite",
  "typecheck": "tsc --noEmit",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "test:e2e": "playwright test",
  "export:cdf": "tsx src/visualize/export/export_cdf.ts"
}
```

- `npm run dev`
  - 启动 Vite dev server，用于日常开发、人工检查页面布局、调试动画和导入状态。
  - 面向开发过程，不作为正式导出素材的默认运行方式。

- `npm run typecheck`
  - 执行 TypeScript 类型检查，不生成构建产物。
  - 用于快速验证类型、组件 props、数据结构和导出脚本的静态正确性。

- `npm run build`
  - 先执行 TypeScript 类型检查，再使用 Vite 生成生产构建产物。
  - 用于验证前端源码、资源路径、字体、schema 引用和打包配置是否完整。

- `npm run preview`
  - 启动 Vite preview server，预览 `build` 后的 `dist/` 产物。
  - 正式截图、录屏和导出流程应优先基于 preview 页面，而不是 dev server 页面。

- `npm run test:e2e`
  - 执行 Playwright 端到端测试。
  - 用于验证页面可加载、输入数据可导入、错误状态可展示、重新绘制按钮可点击，以及导出流程依赖的稳定选择器可用。

- `npm run export:cdf -- --input <json文件路径>`
  - 执行 CDF 可视化素材导出。
  - 默认输出 PNG、WebM 和 MP4 到 `outputs/`。
  - 导出脚本应基于 `build + preview` 产物运行，确保导出结果接近最终交付状态。

命令约定：
- `export:cdf` 必须支持 `--input` 参数；如果未提供输入，应失败退出并给出明确错误。
- `export:cdf` 默认输出目录为 `outputs/`，后续可扩展 `--out-dir`，但第一版不强制支持。
- 正式导出流程应使用 `build + preview`，避免 dev server 的开发模式行为影响截图、录屏、字体加载和资源路径。

# 输入数据格式

输入为模拟器导出的json文件，包含以下数据：
- title：标题
- target：模拟目标
- draw_counts：累积实际模拟抽数
- note：注释
- statistic：对象，各统计量及其数值
- termination_reason：数组，终止原因及其比例,比例合计为100
- timestamp：时间戳
- draws：数组，排序后的抽数，单调不减
- cumulative：数组，排序后draws中每个抽数对应的分位，单调不减

模拟器导出json文件的具体数据类型及范围遵循[schema](./visualize_input.schema.json)

# 项目目录结构

前端可视化子项目使用仓库根目录作为前端包根目录，源码放在 `src/visualize/` 下。这样可以直接复用现有的 `docs/`、`fonts/`、`outputs/` 等目录，避免导出脚本处理复杂的跨目录路径。

推荐目录结构：

```text
D:\codes\MonteCarlo-GachaSimulate\
  package.json              # 前端依赖、npm scripts 和项目元数据
  package-lock.json         # npm 依赖版本锁定文件
  index.html                # Vite 应用入口 HTML，挂载 React 根节点
  vite.config.ts            # Vite 配置，定义 React 插件、路径别名和开发服务器选项
  tsconfig.json             # TypeScript 编译配置
  playwright.config.ts      # Playwright 测试与导出浏览器环境配置

  src\
    simulate\
      ...

    visualize\
      main.tsx              # React 应用入口，挂载 App 并引入全局样式
      App.tsx               # 可视化页面根组件，组织加载状态、布局、动画和数据流

      components\
        TopBar.tsx          # 顶部标题区，显示标题、目标摘要和导入入口
        CDFChart.tsx        # CDF 主图表，绘制曲线、坐标轴、网格线和统计标记
        StatisticPanel.tsx  # 右侧统计面板，展示九个核心统计量
        TerminationBar.tsx  # 底部终止原因 PK 条及比例展示
        ImportButton.tsx    # JSON 文件选择按钮，触发本地数据导入
        ReplayButton.tsx    # 重新播放动画按钮，提供 Playwright 使用的稳定选择器
        EmptyState.tsx      # 未导入数据时的空状态展示
        LoadingState.tsx    # 数据加载中的状态展示
        ErrorState.tsx      # 数据加载或校验失败时的错误状态展示

      data\
        load_input.ts       # 从文件选择或 URL 参数读取 JSON 输入
        validate_input.ts   # 使用 schema 校验输入 JSON，并输出可读错误
        normalize_input.ts  # 将合法输入转换为前端组件更易使用的数据结构
        cdf.ts              # CDF 曲线、标记高度、统计点等辅助计算

      animation\
        timeline.ts         # 动画总时长、分段时间线和缓冲时间常量

      export\
        export_cdf.ts       # Playwright 导出入口，生成 PNG、WebM 并触发 MP4 转码
        ffmpeg.ts           # FFmpeg 调用封装，将 WebM 转为 H.264 MP4
        paths.ts            # 输入、输出、项目根目录等路径解析工具

      styles\
        tokens.css          # 颜色、字体、间距、尺寸等设计 token
        globals.css         # 全局样式、字体加载、基础元素样式
        layout.css          # 固定 1920x1080 页面布局和主要区域排版

      types\
        visualize_input.ts  # 输入 JSON 的 TypeScript 类型定义

      fixtures\
        example_input.json # 前端开发、截图和导出测试使用的示例输入

  e2e\ # 前端端到端测试代码

  docs\
    VISUALIZE_DEVELOP.md
    visualize_input.schema.json
    Sentry.md
    NVIDIA.md

  fonts\
    SourceHanSansSC-Medium.otf

  outputs\
    cdf-result.png
    cdf-animation.webm
    cdf-animation.mp4
```

目录职责：
- `components/`：页面组件，只负责展示和用户操作入口。
- `data/`：输入文件加载、schema 校验、数据规范化和 CDF 辅助计算。
- `animation/`：动画时间线与动画总时长常量，供前端和导出脚本共用。
- `export/`：Playwright 截图、录屏以及 FFmpeg 转码逻辑。
- `styles/`：设计 token、全局样式和固定 1920x1080 布局样式。
- `types/`：前端 TypeScript 类型定义，和 `docs/visualize_input.schema.json` 对应。
- `fixtures/`：前端开发和导出测试使用的示例输入数据。

# 非目标

以下不是项目目标，不应该开发相关功能
- 执行抽卡模拟；
- 修改模拟概率；
- 生成模拟数据；
- 校验概率模型是否正确；
- 提供复杂交互式数据分析功能；
- 做成通用 BI 系统；
- 提供互联网访问服务。

# 开发步骤

开发按“先跑通工程与数据，再实现静态画面，再实现动画和导出”的顺序推进。每个阶段都应有明确产出和验证方式；细节的视觉取舍允许在人工检查点中再对齐。

- [x] 1. 搭建前端工程入口
  - 产出：补齐 `package.json` scripts、`index.html`、`vite.config.ts`、`tsconfig.json`、React 入口文件和基础目录结构。
  - 验证：`npm run typecheck` 和 `npm run build` 可以执行；`npm run dev` 可以打开空白或基础布局页面。

- [x] 2. 建立输入数据契约
  - 产出：根据 `docs/visualize_input.schema.json` 定义 TypeScript 类型、schema 校验、业务一致性校验、数据规范化。
  - 验证：src\visualize\fixtures\examlpe_input.json 可以通过校验；缺字段、数组长度不一致、非单调数据、终止原因比例异常等输入可以给出明确错误。

- [x] 3. 实现统一导入状态流
  - 产出：实现文件选择导入、`?input=<json文件路径>` 导入、未导入/加载中/失败/成功状态，以及供 Playwright 查询的加载完成信号。
  - 验证：两种导入方式进入同一套解析和展示逻辑；导入失败时页面保留重新导入入口，导出流程可识别失败。

- [ ] 4. 实现静态页面布局
  - 产出：实现固定 1920x1080 画布、顶部标题区、左侧 CDF 图表区、右侧统计面板、底部终止原因区域和可选注释区域。
  - 验证：导入 fixture 后不播放动画也能看到完整静态信息；无数据时不展示伪造图表数据。
  - 人工检查点：确认整体信息层级、图表主体地位、统计面板密度、底部说明可读性和 Sentry + NVIDIA 风格方向。

- [ ] 5. 实现 CDF 曲线和统计标记
  - 产出：绘制 CDF 主曲线、坐标轴、低对比网格、P5/P25/P50/P75/P95/MIN/MAX/MEAN 标记线、交点和文字标注。
  - 验证：曲线严格使用输入 `draws` 和 `cumulative` 数据；统计标记位置与输入统计值一致；P50/MEAN 等相近标注不发生明显重叠。

- [x] 6. 实现动画时间线
  - 产出：集中定义动画总时长、分段时间线和缓冲时间；实现首次导入自动播放、重新绘制按钮、按钮禁用状态和 `data-testid="replay-animation"`。
  - 验证：动画约 3 秒完成；重复点击不会造成状态错乱；Playwright 可以等待数据加载完成后点击重新绘制按钮。
  - 人工检查点：确认曲线绘制、分位线、统计面板和底部说明的出现节奏克制、平滑，适合视频素材。

- [x] 7. 实现导出脚本
  - 产出：实现 `export:cdf`，基于 `build + preview` 打开页面，加载输入，等待字体和数据状态，导出 PNG、WebM，并通过 FFmpeg 转 MP4。
  - 验证：输出文件位于 `outputs/`；PNG 尺寸为 1920x1080；WebM 为 1920x1080、60 FPS、约 3 秒；MP4 可被常见播放器打开；失败时返回非 0 退出码。

- [x] 8. 补充端到端测试
  - 产出：添加 Playwright 测试，覆盖页面加载、fixture 导入、错误状态、重新绘制按钮、导出前置状态和关键选择器。
  - 验证：`npm run test:e2e` 可以稳定通过；测试视口固定为 1920x1080，设备缩放为 1。

- [ ] 9. 最终验收
  - 产出：使用代表性 fixture 执行完整导出流程，生成最终 PNG、WebM 和 MP4。
  - 验证：`npm run typecheck`、`npm run build`、`npm run test:e2e` 和 `npm run export:cdf -- --input <json文件路径>` 均通过。
  - 人工检查点：确认最终 PNG 和 MP4 的信息准确性、画面可读性、动画节奏和视频剪辑可用性。
