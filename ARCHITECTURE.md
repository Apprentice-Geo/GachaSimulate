# Architecture

本文档提供 GachaSimulate 的代码地图，帮助贡献者判断“功能在哪里”和“改动应落在哪一层”。这里只记录稳定边界；具体协议、参数和检查命令见专项文档。

## 鸟瞰

GachaSimulate 将 YAML 抽卡规则编译为中间表示，由 C++ Runtime 执行 Monte Carlo 模拟并保存 GSR。analyzer 从 GSR 生成平台无关的分析数据，供 Electron 展示和素材导出使用。Electron 负责组织这条流水线，不实现模拟语义。

```text
YAML -> Config Compiler -> IR -> C++ Runtime -> GSR -> Analyzer -> Analysis
     -> Analysis + DisplayConfig v2 -> CDF ViewModel
```

## 代码地图

- `packages/config-compiler/`：YAML 校验与 IR 编译；单次编译入口是 `compile_yaml`，配置仓库批量校验入口是 `validate_config_files`。
- `packages/config-repository-contract/`：配置仓库 index、manifest 和包文件清单的纯协议校验；不执行网络、ZIP 或文件系统操作。
- `cpp/`：Runtime 执行 IR；同层还包含 GSR 编解码、统计、core、analyzer 和 benchmark。
- `src/main/`：受信任的 Electron 宿主；`SimulationTask` 管理 core 与模拟产物，`ResultEditor` 管理 analyzer、带身份的结果会话与导出快照，`ExportTaskCoordinator` 管理导出 reservation、main-owned 目录选择、目标文件身份、最近任务目录授权和统一准入，内部 `ExportHost` 管理隐藏导出窗口、CDP 截图、FFmpeg、逐产物安全提交与可重试的残留资源清理。
- `src/preload/`：main 与桌面 renderer、隐藏导出 renderer 之间相互隔离的固定 IPC 桥。
- `src/renderer/`：桌面界面与任务状态，不直接访问 Node.js。
- `src/export-renderer/`：只消费 CDF view model 与逐帧消息的隐藏 Electron renderer；不访问桌面 preload API、文件系统或子进程。
- `src/visualize/`：平台无关的 Analysis/DisplayConfig 校验、CDF 视图模型和共享场景。
- `test-fixtures/configs/`：主仓库测试与语义 fixture；`benchmark/cases/`：独立 benchmark 配置。
- 正式配置由 `GachaSimulate-Configs` 维护，不纳入主仓库运行时目录。

## 边界与不变量

- Config Compiler 是 YAML 到 IR 的唯一权威；C++ 不解析 YAML。
- Config Compiler 定义 IR 的结构及 YAML 到 IR 的表示规则；C++ loader 将临时 IR 文件视为不可信输入并执行防御性校验，但不独立扩展 IR 表示。IR 只用于配套的 Compiler 与 Runtime 之间传递单次任务，不是持久化或兼容格式。
- C++ Runtime 是模拟语义的唯一权威；GSR 是持久化模拟结果，analyzer 不重新模拟。
- 固定 `global_seed` 时，每个 run 的随机流只由 `global_seed + run_index` 派生，不依赖 threads、chunk 数、执行顺序或 `total_runs`。该算法不兼容旧版基于 chunk 的随机序列，因此切换后相同 seed 的历史结果会改变一次；跨标准库的浮点分布也不承诺逐位一致。
- Electron renderer 不决定可执行文件和受信任文件路径；这些能力只存在于 main，并通过 preload 暴露固定操作。
- 桌面 renderer 与隐藏导出 renderer 不直接通信；桌面 preload 只接受受限格式、基础文件名、会话标识和取消标识，目录及完整目标路径只在 main 内流转。系统目录选择器必须由受信任主窗口作为 parent；覆盖确认只往返 reservation id 和已存在文件的 basename。main 在覆盖确认及每个产物提交前复核目标身份，`ExportHost` 验证隐藏 renderer 消息的发送方、job id 和帧范围后才允许截图或写入编码器。
- 导出目标替换成功即为提交点；提交后的正式产物不因取消或 backup 清理失败而回滚。清理失败时任务和准入所有权保留到重试成功或应用退出，renderer 只接收残留 basename，打开目录也只提交最近合格任务的 task id。
- `src/visualize/` 不依赖 Electron、Node.js 或导出宿主；Electron 展示与素材导出复用同一套输入处理和场景。
- 启动原生进程的一层负责终止、等待和清理；失败任务不得留下临时 IR 或半成品结果。
- 修改跨层契约时，必须同时检查生产方、消费方、机器定义、兼容策略和行为测试。

## 可视化与导出

`src/visualize/` 是平台无关的结果可视化层，将经过校验的 `Analysis + DisplayConfig v2` 转换为 CDF view model，供 Electron 展示与素材导出共享。导航、模拟表单、GSR 对话框、结果编辑页与任务交互属于桌面宿主，不进入本层；本层不依赖 Electron 或 Node.js API。

```text
Analysis -------> validate_analysis -----------+
                                               +-> build_cdf_view_model
DisplayConfig -> validate_display_config ------+   (safe-integer conversion + merge)
                                                   -> CDF view model
                                                   -> shared scene
                                                   -> Electron display or export
```

Analysis 和 DisplayConfig 不能绕过各自校验直接进入视图模型。组件只消费 CDF view model，不承担 schema 校验、数值转换、CDF 计算或展示规则编排。结果编辑和结果可视化共享 main 管理的当前 GSR 会话；数据来源与保存规则见 [DisplayConfig](docs/DISPLAY_CONFIG.md)。

### 共享层职责

- `data/`：Analysis、DisplayConfig 校验和 CDF 基础计算。
- `view/`：展示模型、统计配置和与画面有关的布局计算；CDF、marker、统计分组与布局计算不得散入组件。
- `components/`：共享画面与交互组件，保持偏渲染。
- `animation/`：交互展示和逐帧导出共用的时间轴与进度计算。
- `styles/`：共享设计 token、画面样式和宿主外壳样式，设计原则见 [UI Design](docs/UI_DESIGN.md)。
- `types/`：Analysis、DisplayConfig 和 CDF view model 的静态类型。

定位实现时优先搜索 `Analysis`、`DisplayConfig`、`build_cdf_view_model` 和 `VisualizeScene`。Electron 接入只提供输入并承载共享画面，不复制输入校验、视图模型或导出逻辑。

### 宿主与逐帧语义

素材导出是长期保留能力。Electron 展示和素材导出复用同一套输入处理、视图模型、画面组件和动画进度；替换宿主不得复制或分叉画面逻辑。`src/export-renderer/` 负责固定尺寸导出页面与逐帧提交，`src/main/export_host.ts` 负责 CDP、FFmpeg 和输出提交，两者均位于可视化层之外。

桌面素材导出入口通过 `VisualizeShell` 的宿主回调接入。可视化层只呈现固定操作按钮、可用状态和辅助技术可读的禁用原因，不接收 session id、GSR 文件名、reservation、目录或任务路径。格式、目标选择、覆盖及任务交互由桌面 renderer 与 main 负责，流程状态与模态框不得进入 `src/visualize/`。

`VisualizeScene` 通过 `render_mode` 区分交互与导出。export 模式固定图表尺寸并强制隐藏操作栏，不调用页面缩放 hook、真实时钟动画或宿主缩放；画布规格与适配原则见 UI Design。

共享动画使用 60 FPS 帧制时间轴。交互页面以 elapsed time 调用共享进度入口，由入口换算为浮点帧进度；逐帧导出换算为同一时间输入，避免维护两套视觉行为。修改动画节奏集中在 `animation/`，继续遵循 UI Design 中的缓动与透明度约束。

`resolve_export_frame_state` 是逐帧语义的唯一入口，只接受 0–59 的整数帧。动画在 `ANIMATION_COMPLETION_FRAME` 到达终态，当前值为第 57 帧；第 57–59 帧保持相同 idle 终态，静态 PNG 使用第 57 帧。从视频切换到 PNG 时不得出现布局或动画跳变。

修改共享视觉 token 或画布规格时，同时检查交互展示、Electron 导出 renderer、导出结果和相关文档。检查命令见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)，FFmpeg 构建与分发限制见 [FFmpeg 文档](scripts/README.md)。

## 契约索引

| 契约 | 用途与边界 | 版本与兼容性 | 定义权威 | 生产方 | 消费方 | 文档 |
| --- | --- | --- | --- | --- | --- | --- |
| YAML Config | 用户配置输入 | schema v2 | Config Compiler validator | 配置作者 | Config Compiler | [`YAML_CONFIG_SYNTAX.md`](docs/YAML_CONFIG_SYNTAX.md) |
| IR | TS 到 C++ 的临时 JSON 进程契约 | 仅供配套实现使用，不持久化 | Config Compiler；C++ loader 负责不可信输入防御 | Config Compiler | C++ Runtime | [`IR.md`](docs/IR.md) |
| GSR | 持久化模拟结果 | v2；不读取旧格式 | C++ codec 与固定 fixture | C++ Runtime | C++ analyzer | [`GSR.md`](docs/GSR.md) |
| Analysis | analyzer 的 JSON 输出 | 严格拒绝未知字段 | JSON Schema 定义结构，semantic validator 定义跨字段不变量 | C++ analyzer | Electron、素材导出 | [`ANALYSIS.md`](docs/ANALYSIS.md) |
| DisplayConfig | 独立可视化 sidecar | v2；不隐式兼容 v1 或旧字段 | JSON Schema | Electron 结果编辑 | Electron、素材导出 | [`DISPLAY_CONFIG.md`](docs/DISPLAY_CONFIG.md) |
| Config Repository | 配置仓库 index、manifest 和包文件集合 | v1 | config-repository-contract validator | 配置仓库 | Electron 配置安装 | [`CONFIG_REPOSITORY.md`](docs/CONFIG_REPOSITORY.md) |

JSON 契约按约束范围划分权威：JSON Schema 定义字段、类型、必填项和局部取值约束；semantic validator 定义 Schema 之外的跨字段不变量；TypeScript 类型只是消费方的静态视图。契约测试负责验证这些定义与生产方、消费方保持一致，不另行定义格式。

## 专项文档

配置语法见 `docs/YAML_CONFIG_SYNTAX.md`，IR 见 `docs/IR.md`，配置仓库协议见 `docs/CONFIG_REPOSITORY.md`，结果格式见 `docs/GSR.md`，分析格式见 `docs/ANALYSIS.md`，展示配置见 [DisplayConfig](docs/DISPLAY_CONFIG.md)，UI 设计原则与交互不变量见 [UI Design](docs/UI_DESIGN.md)，FFmpeg 开发与发布边界见 `scripts/README.md`，检查矩阵见 `docs/DEVELOPMENT_CHECKS.md`。
