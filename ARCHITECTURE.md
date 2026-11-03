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
- `src/main/`：受信任的 Electron 宿主；`SimulationTask` 管理配置编译准备、core 与模拟产物，`ResultEditor` 管理 analyzer、带身份的结果会话与导出快照，`ExportTaskCoordinator` 管理导出 reservation、main-owned 目录选择、目标文件身份、最近任务目录授权和统一准入，内部 `ExportHost` 管理隐藏导出窗口、CDP 截图、FFmpeg、逐产物安全提交与可重试的残留资源清理。`ConfigManager` 管理配置来源与安装事务；`config_snapshot.ts` 集中文件快照、内容摘要、协议校验和运行编译，由 `config_worker.ts` 在受控线程中执行，`ConfigWorkerClient` 管理请求身份、线程故障及可重试的有界退出。`native_process.ts` 提供可信原生程序定位、终止和有界等待，不拥有业务任务状态。
- `src/preload/`：main 与桌面 renderer、隐藏导出 renderer 之间相互隔离的固定 IPC 桥。
- `src/renderer/`：桌面界面与任务状态，不直接访问 Node.js。`App.tsx` 管理顶层 Shell、页面切换、工作台主题与 ExportWorkflow，并持有 `ResultSessionController`；controller 集中保留当前结果、草稿、已保存字段、载入与保存队列、错误和准备好的数值模型，页面切换不销毁这些业务状态。`pages/` 分别承载模拟、结果编辑、配置仓库和设置页面。`theme.ts` 在 React 渲染前恢复本地主题偏好，设置页切换后即时应用并保存。软件信息从构建时的项目元数据读取，外部链接仅向 preload 传递固定目标 ID，由 main 校验桌面 sender 与 ID 后打开。结果编辑的普通摘要由 Workbench 渲染，只有 CDF 预览使用 Visualization 画面组件。
- `src/export-renderer/`：只消费 CDF view model 与逐帧消息的隐藏 Electron renderer；不访问桌面 preload API、文件系统或子进程。
- `src/visualize/`：平台无关的 Analysis/DisplayConfig 校验、CDF 视图模型和共享场景。
- `test-fixtures/configs/`：主仓库测试与语义 fixture；`benchmark/cases/`：独立 benchmark 配置。
- 正式配置由 `GachaSimulate-Configs` 维护，不纳入主仓库运行时目录。

## 桌面配置与存储

Electron main 在 `app.getPath("userData")` 下管理桌面数据：已安装配置位于 `configs/installed/`，模拟结果位于 `results/`。结果展示字段保存为 GSR 对应的独立 sidecar，格式与保存规则见 [DisplayConfig](<docs/DISPLAY_CONFIG.md>)。

模拟表单的统计物品列表由 Compiler 从当前 `config.yaml` 的 `items` 读取。表单按大小写敏感的完整 ID 选择物品，默认优先选择 `draw_count`，否则选择第一项。

## 边界与不变量

- Config Compiler 是 YAML 到 IR 的唯一权威；C++ 不解析 YAML。
- Config Compiler 定义 IR 的结构及 YAML 到 IR 的表示规则；C++ loader 将临时 IR 文件视为不可信输入并执行防御性校验，但不独立扩展 IR 表示。IR 只用于配套的 Compiler 与 Runtime 之间传递单次任务，不是持久化或兼容格式。
- C++ Runtime 是模拟语义的唯一权威；GSR 是持久化模拟结果，analyzer 不重新模拟。
- 固定 `global_seed` 时，每个 run 的随机流只由 `global_seed + run_index` 派生，不依赖 threads、chunk 数、执行顺序或 `total_runs`。该算法不兼容旧版基于 chunk 的随机序列，因此切换后相同 seed 的历史结果会改变一次；跨标准库的浮点分布也不承诺逐位一致。
- Electron renderer 不决定可执行文件和受信任文件路径；这些能力只存在于 main，并通过 preload 暴露固定操作。
- 桌面请求、响应和事件的静态契约集中在 `src/shared/desktop_ipc.ts`。preload 的受类型约束桥与 main 的统一注册入口消费同一映射；main 先确认 sender 为有效主窗口、senderFrame 为主 frame 且当前 URL 为配置的应用页面，再执行运行时参数校验、准入与业务操作。主窗口限制页面导航与新窗口，桌面事件只发往有效应用主窗口；隐藏导出 renderer 保留独立桥和逐帧身份校验。
- 配置列表与仓库状态查询每次都在线程中重新读取当前包的完整文件集合和内容。摘要相同才复用完整校验结论；远程 index TTL 不控制本地快照有效性。目录与配置变更使查询代次失效，旧查询不能发布旧目录结果。模拟编译重新读取、验证并消费同一份输入快照，准备期间已占有模拟任务身份；取消、准入变化或退出后不能迟到启动 core。
- 桌面 renderer 与隐藏导出 renderer 不直接通信；桌面 preload 只接受受限格式、基础文件名、会话标识和取消标识，目录及完整目标路径只在 main 内流转。系统目录选择器必须由受信任主窗口作为 parent；覆盖确认只往返 reservation id 和已存在文件的 basename。main 在覆盖确认及每个产物提交前复核目标身份，`ExportHost` 验证隐藏 renderer 消息的发送方、job id 和帧范围后才允许截图或写入编码器。
- 导出目标替换成功即为提交点；提交后的正式产物不因取消或 backup 清理失败而回滚。清理失败时保留任务、资源引用、准入所有权及重试入口，renderer 只接收残留 basename，打开目录也只提交最近合格任务的 task id。
- 关闭窗口、退出应用与导出清理后的退出共享一轮去重协调。协调器聚合等待已启动的停止操作，清理成功后才销毁主窗口；失败时先恢复配置 worker 服务，再恢复全局准入，仍有效的导出占用和已接受的模拟取消决定继续生效。worker 停止等待有界，超时仍保留退役线程所有权；旧线程尚未清理时不创建更多线程。配置下载对应的变更事务与刷新收尾也有界；超时保留原 Promise 和变更互斥，恢复后旧下载回包仍因代次失效被拒绝。
- `src/visualize/` 不依赖 Electron、Node.js 或导出宿主；Electron 展示与素材导出复用同一套输入处理和场景。
- 启动原生进程的一层负责终止、等待和清理；失败任务不得留下临时 IR 或半成品结果。
- 模拟取消决定一经接受，在该任务内不可撤销；main 停止转发后续进度并丢弃本次输出，即使 core 已写出完整结果或终止尝试失败。renderer 从点击取消起屏蔽已排队的进度和成功消息，保持读数冻结；终止失败时保留任务所有权与重试入口。
- 修改跨层契约时，必须同时检查生产方、消费方、机器定义、兼容策略和行为测试。

## 可视化与导出

`src/visualize/` 是平台无关的结果可视化层，将经过校验的 `Analysis + DisplayConfig v2` 转换为 CDF view model，供 Electron 展示与素材导出共享。导航、模拟表单、GSR 对话框、结果编辑页与任务交互属于桌面宿主，不进入本层；本层不依赖 Electron 或 Node.js API。

```text
Analysis -------> validate_analysis -> prepare_cdf_data --+
                                                         +-> apply_cdf_display
DisplayConfig -> validate_display_config ----------------+   -> CDF view model
                                                             -> shared scene
                                                             -> Electron display or export
```

Analysis 和 DisplayConfig 不能绕过各自校验直接进入视图模型。组件只消费 CDF view model，不承担 schema 校验、数值转换、CDF 计算或展示规则编排。结果编辑和结果可视化共享 main 管理的当前 GSR 会话；数据来源与保存规则见 [DisplayConfig](docs/DISPLAY_CONFIG.md)。

`build_cdf_view_model` 是数值准备与展示字段组合的共享入口；桌面 controller 按会话复用 `prepare_cdf_data` 的曲线点、marker 与范围，再分别组合已保存字段和草稿预览。main 在提交新会话前确认输入可建模，renderer 在载入异步流程中准备模型，失败时保留最后有效结果；页面局部错误边界仍保留重新选择入口。保存 IPC 只返回会话标识与实际保存的 DisplayConfig，完整 Analysis 只随载入传递。

### 共享层职责

- `data/`：Analysis、DisplayConfig 校验和 CDF 基础计算。
- `view/`：展示模型、统计配置和与画面有关的布局计算；CDF、marker、统计分组与布局计算不得散入组件。
- `components/`：共享画面与交互组件，保持偏渲染。
- `animation/`：交互展示和逐帧导出共用的时间轴与进度计算。
- `styles/`：受 `.visualize-scope` 限定的共享设计 token 与画面样式，`index.css` 为桌面与导出共用入口，`preview.css` 提供交互宿主适配。ResultEditor CDF Preview、正式页面和导出根宿主建立相同 scope；Workbench token 独立位于 `src/renderer/tokens.css`，样式匹配在 Visualization 边界停止。Workbench 与 Visualization 的共享字号层级位于 `src/styles/typography.css`，Visualization 以固定倍率转换为画布坐标，保持独立深色主题；全局字体资源与 reset 位于 `src/styles/foundation.css`，设计原则见 [Workbench Design](docs/WORKBENCH_DESIGN.md) 与 [Visualization Design](docs/VISUALIZATION_DESIGN.md)。
- `types/`：Analysis、DisplayConfig 和 CDF view model 的静态类型。

定位实现时优先搜索 `Analysis`、`DisplayConfig`、`build_cdf_view_model` 和 `VisualizeScene`。Electron 接入只提供输入并承载共享画面，不复制输入校验、视图模型或导出逻辑。

### 宿主与逐帧语义

Electron 展示与素材导出复用同一套输入处理、视图模型、画面组件和动画进度。`src/export-renderer/` 负责导出页面与逐帧提交，`src/main/export_host.ts` 负责 CDP、FFmpeg 和输出提交；两者均位于平台无关的可视化层之外。

桌面素材导出入口由 Workbench 侧栏操作组接入 `ExportWorkflow`。renderer 中的 `export_workflow_controller.ts` 集中维护交互流程的唯一状态、IPC 协调与异步身份检查，`use_export_workflow.ts` 通过订阅连接 React 生命周期；`ExportWorkflow` 管理模态外壳与焦点，`ExportDialogs` 展示表单、确认、进度和通知。main 继续作为导出 reservation、任务执行与资源清理的权威。`src/visualize/` 不接收 session ID、GSR 文件名、reservation、目录或任务路径；格式、目标选择、覆盖和任务状态由桌面 renderer 与 main 管理。

发起 main reservation 前，导出 controller 等待结果 controller 的 renderer 保存队列尾；保存失败、会话变化或准备取消会停止该次导出准备。随后仍经过 main 的保存屏障和独立复制的导出快照，后续编辑不能改变已接受任务的内容。

`VisualizeScene` 使用 `render_mode` 标记交互与导出宿主，二者共用纯画面，不承载操作按钮。Workbench 侧栏操作组通过 portal 挂载；结果页管理文件选择和导出入口，Visualization 交互宿主管理重播和动画状态。导出模式不使用页面缩放、真实时钟动画或宿主缩放；画布及视觉表现由 [Visualization Design](<docs/VISUALIZATION_DESIGN.md#结果画布>) 维护。

交互展示和逐帧导出调用同一动画进度入口。交互页面传入 elapsed time，逐帧导出把帧号转换为相同的时间输入；动画节奏集中在 `animation/` 维护。

`resolve_export_frame_state` 是逐帧语义的唯一入口，只接受 0–59 的整数帧。动画在 `ANIMATION_COMPLETION_FRAME` 到达终态，当前值为第 57 帧；第 57–59 帧保持相同的 idle 终态，静态 PNG 使用第 57 帧。

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

配置语法见 `docs/YAML_CONFIG_SYNTAX.md`，IR 见 `docs/IR.md`，配置仓库协议见 `docs/CONFIG_REPOSITORY.md`，结果格式见 `docs/GSR.md`，分析格式见 `docs/ANALYSIS.md`，展示配置见 [DisplayConfig](docs/DISPLAY_CONFIG.md)，UI 设计原则与交互不变量见 [Workbench Design](docs/WORKBENCH_DESIGN.md) 与 [Visualization Design](docs/VISUALIZATION_DESIGN.md)，FFmpeg 开发与发布边界见 `scripts/README.md`，检查矩阵见 `docs/DEVELOPMENT_CHECKS.md`。
