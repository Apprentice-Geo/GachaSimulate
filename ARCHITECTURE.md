# Architecture

从下面的代码地图定位模块。跨进程的数据格式、版本和维护入口列在[契约索引](#契约索引)中。

## 鸟瞰

GachaSimulate 将 YAML 抽卡规则编译为中间表示，由 C++ Runtime 执行 Monte Carlo 模拟并保存 GSR。analyzer 从 GSR 生成平台无关的分析数据，供 Electron 展示和素材导出使用。Electron 负责组织这条流水线，不实现模拟语义。

```text
YAML -> Config Compiler -> IR -> C++ Runtime -> GSR -> Analyzer -> Analysis
Analysis + DisplayConfig v2 -> CDF ViewModel -> 桌面展示或素材导出
```

## 代码地图

- `packages/config-compiler/`：YAML 校验与 IR 编译；单次编译入口是 `compile_yaml`，配置仓库批量校验入口是 `validate_config_files`。
- `packages/config-repository-contract/`：配置仓库 index、manifest 和包文件清单的纯协议校验；不执行网络、ZIP 或文件系统操作。
- `cpp/`：Runtime 执行 IR；同层还包含 GSR 编解码、统计、core、analyzer 和 benchmark。
- `src/main/` 管理桌面应用的文件、原生进程和隐藏导出窗口。按任务定位入口：
  - `ConfigManager` 管理配置来源与安装。配置 worker 读取文件快照，用同一份输入完成校验与编译。
  - `SimulationTask` 启动 core，管理模拟、取消和结果提交。`native_process.ts` 提供原生程序定位与进程终止、等待操作。
  - `ResultEditor` 调用 analyzer，管理当前 GSR 会话、展示字段保存与导出快照。
  - `ExportTaskCoordinator` 管理导出请求、目录选择与目标文件。`ExportHost` 驱动隐藏窗口截图、FFmpeg 编码和产物提交。
- `src/preload/` 为桌面窗口和隐藏导出窗口分别提供固定的 IPC 接口。
- `src/renderer/` 承载工作台。`pages/` 下是各个页面，`App.tsx` 管理导航、主题和导出对话框。当前结果、编辑草稿和保存队列由顶层的 `ResultSessionController` 持有，切换页面后仍可继续编辑。
- `src/export-renderer/`：只消费 CDF view model 与逐帧消息的隐藏 Electron renderer；不访问桌面 preload API、文件系统或子进程。
- `src/visualize/`：平台无关的 Analysis/DisplayConfig 校验、CDF 视图模型和共享场景。
- `test-fixtures/configs/`：主仓库测试与语义 fixture；`benchmark/cases/`：独立 benchmark 配置。
- 正式配置由 `GachaSimulate-Configs` 维护，不纳入主仓库运行时目录。

## 桌面配置与存储

Electron main 在 `app.getPath("userData")` 下管理桌面数据：已安装配置位于 `configs/installed/`，模拟结果位于 `results/`。结果展示字段保存为 GSR 对应的独立 sidecar，格式与保存规则见 [DisplayConfig](<docs/DISPLAY_CONFIG.md>)。

模拟表单的统计物品列表由 Compiler 从当前 `config.yaml` 的 `items` 读取。表单按大小写敏感的完整 ID 选择物品，默认优先选择 `draw_count`，否则选择第一项。

## 边界与不变量

- Config Compiler 校验 YAML 并定义 IR。C++ loader 将临时 IR 文件视为不可信输入，检查后交给配套的 Runtime 执行。模拟语义由 Runtime 实现，analyzer 从保存的 GSR 计算统计量。
- 每次模拟的随机流由全局种子和该次模拟的序号决定。使用同一实现时，改变线程数、分块方式、执行顺序或总次数，都不影响同一序号的随机流。不同标准库的浮点分布实现可能产生不同结果。
- Electron renderer 不决定可执行文件和受信任文件路径；这些能力只存在于 main，并通过 preload 暴露固定操作。
- “查看本次结果”通过无参数 IPC 请求分析当前已成功提交的 GSR。main 从 `SimulationTask` 取得路径，经分析准入后交给 `ResultEditor`；桌面与手动选择文件共用结果会话及可视化流程。
- 桌面 IPC 的请求、响应和事件类型见 `src/shared/desktop_ipc.ts`。main 核验主窗口、主 frame 和页面 URL 后才接受请求，随后校验参数与任务状态。主窗口限制导航和新窗口，外部链接以预定义 ID 打开。桌面事件仅发往有效主窗口。
- 本地配置每次查询都重新读取整包文件，内容摘要一致时才复用校验结论。目录或配置变更会使在途的本地查询失效。远程 index 单独刷新和节流，退出取消或被拒绝的刷新不更新时间戳。模拟任务在编译前取得执行权，使用经过校验的同一份快照；取消或退出后不得启动 core。
- 导出目录由 main 通过主窗口的系统对话框选择。桌面 renderer 用任务标识和文件名确认覆盖，完整目标路径留在 main。main 在确认覆盖和提交每个文件前复核目标身份。隐藏导出窗口使用独立 IPC，`ExportHost` 核验发送方、任务标识和帧号后才截图。
- 每个导出文件替换成功即提交。此后即使取消任务或备份清理失败，也保留已提交的文件。清理失败的任务保留资源、占用与重试入口。桌面只显示残留文件名，通过任务标识请求打开最近一次合格任务的目录。
- 窗口关闭与应用退出共用清理流程，所有已启动的停止操作完成后才销毁主窗口。退出失败时先恢复配置 worker，再接受新任务。超时的线程和配置事务保留所有权，避免重启重复线程或并发修改同一配置。已失效的下载响应不能提交。
- `src/visualize/` 不依赖 Electron、Node.js 或导出宿主；Electron 展示与素材导出复用同一套输入处理和场景。
- 启动原生进程的一层负责终止、等待和清理；失败任务不得留下临时 IR 或半成品结果。
- 模拟取消决定一经接受，在该任务内不可撤销；main 停止转发后续进度并丢弃本次输出，即使 core 已写出完整结果或终止尝试失败。renderer 从点击取消起屏蔽已排队的进度和成功消息，保持读数冻结；终止失败时保留任务所有权与重试入口。
- 修改跨层契约时，必须同时检查生产方、消费方、机器定义、兼容策略和行为测试。

## 可视化与导出

`src/visualize/` 是平台无关的结果可视化层，将经过校验的 `Analysis + DisplayConfig v2` 转换为 CDF view model，供 Electron 展示与素材导出共享。导航、模拟表单、GSR 对话框、原位编辑交互与任务交互属于桌面宿主，不进入本层；本层不依赖 Electron 或 Node.js API。

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
- `styles/`：图表预览、结果画面与导出窗口在 `.visualize-scope` 内加载同一套 `index.css`。交互宿主的适配样式位于 `preview.css`。工作台与结果画布只共享基础样式与字号层级，各自管理主题。
- `types/`：Analysis、DisplayConfig 和 CDF view model 的静态类型。

定位实现时优先搜索 `Analysis`、`DisplayConfig`、`build_cdf_view_model` 和 `VisualizeScene`。Electron 接入只提供输入并承载共享画面，不复制输入校验、视图模型或导出逻辑。

### 宿主与逐帧语义

Electron 展示与素材导出复用同一套输入处理、视图模型、画面组件和动画进度。`src/export-renderer/` 负责导出页面与逐帧提交，`src/main/export_host.ts` 负责 CDP、FFmpeg 和输出提交；两者均位于平台无关的可视化层之外。

工作台侧栏发起导出。`ExportWorkflow` 管理对话框与键盘焦点，`export_workflow_controller.ts` 协调格式选择、覆盖确认、进度和取消。文件名、目录和任务状态由桌面层处理。

导出前，renderer 等待当前结果的保存队列完成。保存失败、切换会话或取消准备都会终止这次请求。main 等待保存完成后复制一份快照，后续编辑不会改变已接受的导出任务。

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

工作台布局和交互见 [Workbench Design](docs/WORKBENCH_DESIGN.md)，图表和导出画面见 [Visualization Design](docs/VISUALIZATION_DESIGN.md)。开发环境和检查命令见 [Development Checks](docs/DEVELOPMENT_CHECKS.md)，FFmpeg 构建与发布见 [维护脚本](scripts/README.md)。
