# 桌面应用架构审查与修复记录（已归档）

初审日期：2026-11-01。代码基线：`eead8f0d47ab3464c09e764d81b08c08d8d8bcaf`。复审及修复策略更新：2026-11-02。

状态：已完成。完成日期：2026-11-03。归档日期：2026-11-04。

本文保留 D01–D08 的初审证据、修复决策、实施结果与验收记录，供历史追溯；实现、测试与性能数据均记录任务完成时的状态，不随项目后续变化维护，也不作为当前规范。“原始审查”章节保留修复前的实现描述。

长期知识已迁移至 [Architecture 的代码地图](../../ARCHITECTURE.md#代码地图)、[边界与不变量](../../ARCHITECTURE.md#边界与不变量)、[可视化与导出](../../ARCHITECTURE.md#可视化与导出)，检查入口与适用范围见 [Development Checks](../DEVELOPMENT_CHECKS.md)。

## 修复完成状态（2026-11-03）

按依赖分四批实施，每批由修复 agent 实现、另一 agent 独立审查，由主 agent 统筹验证和提交。四批修复提交为 `608ca4b`、`4784cc8`、`4a008bc`、`f176c67`；最终汇总检查见末尾实施与验收记录。

| 编号 | 状态与最终实现 | 主要验收依据 |
| --- | --- | --- |
| D01 | 完成。App 持有 [ResultSessionController](../../src/renderer/result_session_controller.ts)，会话、草稿代次、保存身份和载入状态独立管理，切页不销毁队列与错误；导出前等待 renderer 保存队列尾。 | controller 交错、失败重试、扩展队列尾及导出取消测试；[真实 Electron](../../src/dev/desktop_lifecycle.test.ts) 覆盖跨会话旧响应及同会话返回后的新草稿两种顺序。 |
| D02 | 完成。统一退出协调有界等待全部停止分支和配置事务/刷新收尾，失败后恢复 worker 服务和全局准入；超时保留配置事务/刷新身份，导出资源、任务与占用保留至清理成功。 | [shutdown](../../src/main/shutdown.test.ts)、[导出任务](../../src/main/export_task.test.ts) 依赖注入；真实 Electron 覆盖关闭、before-quit 终止失败，以及 PNG 导出清理失败后的 close、exit-after-export-cleanup、重试与恢复。 |
| D03 | 完成。轴范围比较末项及统计 MAX，不再展开数组；main 和 renderer 在发布会话前确认建模成功，失败保留有效结果，页面保留恢复入口。 | 200,000 点合法输入、单点/零值/不一致 MAX、超范围数值和失败后再次载入的回归测试。 |
| D04 | P1/P2 均完成。analyzer 按子进程身份去重取消，有界等待并锁定输出超限；[native_process](../../src/main/native_process.ts) 集中定位、终止和等待基础能力，模拟、分析及 FFmpeg 复用适用部分。 | 并发取消、超时/终止失败重试、旧子进程终止迟到、输出超限及已有 FFmpeg 背压/提交/清理回归；线程终止也有界，超时不丢所有权。 |
| D05 | 完成。保存 IPC 仅返回 session_id 和实际保存的 DisplayConfig；共享层拆出数值准备与文案组合，controller 按会话复用曲线及 marker，导出仍独立复制快照。 | 精简响应键集合、数值数组/marker 复用、单位编辑与新会话隔离、导出快照不随后续保存变化；测量见下文。 |
| D06 | 完成。依据测量将读取、摘要、协议/Compiler 校验和运行编译移入受控 worker；每次查询重新读取完整包，摘要不变才复用校验。安装元数据步骤与首次 installed 查询复用已验 YAML receipt。 | [快照](../../src/main/config_snapshot.test.ts)、[worker](../../src/main/config_worker.test.ts)、[配置管理](../../src/main/config_manager.test.ts) 测试覆盖同 size/mtime 外部修改、文件增删、非法包、目录切换、迟到安装/刷新、慢下载收尾超时、线程故障、退役超时及退出恢复；production Electron 实际启动构建后的 worker 查询和编译。 |
| D07 | 完成。所有桌面 handler 统一检查有效主窗口、主 frame 和精确应用 URL，限制导航；桌面事件只投递当前有效应用窗口。 | [真实 IPC](../../src/dev/desktop_ipc.test.ts) 正常往返、其他窗口/子 frame 拒绝、隐藏窗口事件隔离、导航与强制更换页面后的请求拒绝；隐藏导出通道继续独立校验。 |
| D08 | 完成。[共享桌面契约](../../src/shared/desktop_ipc.ts) 集中 channel 请求/响应/事件和 DesktopApi；preload 使用 typed helpers 与 satisfies，main 注册消费相同映射，原始参数仍运行时校验。 | 常规 typecheck 包含[类型负例](../../src/main/desktop_ipc.typecheck.ts)；正常 CPU/保存响应真实跨层往返，以及非法请求在业务操作前拒绝。 |

稳定知识已同步到 Architecture 与 Development Checks。未改动 YAML、IR、GSR、Analysis 或 DisplayConfig 持久化协议；没有新增分布点数、配置数量或模拟规模限制。

## 修复测量与边界

### D05：200,000 点 Analysis

同一代表性输入下，原完整保存状态的 JSON 为 3,379,007 字节，精简保存响应为 390 字节。数值准备及文案组合的完整建模中位耗时为 10.69 ms，已准备数据的文案组合中位耗时为 0.189 ms，controller 单次文字修改的 CPU 中位耗时为 0.160 ms。

这些是 Windows Node 下的 JSON 大小与模型/controller 测量，不是 Electron wire 实际传输字节或用户键入总延迟；不包含 React、DOM/SVG 绘制、IPC 运输或内存峰值。未据此宣称 200,000 点绘制流畅。

### D06：同一配置集合的冷、热查询

| 输入集合 | 修复前查询总耗时 | worker 冷查询总耗时 | worker 热查询总耗时 |
| --- | --- | --- | --- |
| 5 包 × 3 个终止条件 × 20 个物品，YAML 总量 5,095 字节 | 约 9–22 ms | 266.72 ms | 2.53–4.57 ms |
| 60 包 × 20 个终止条件 × 200 个物品，YAML 总量 455,260 字节 | 约 485–646 ms | 656.80 ms | 75.45–83.22 ms，中位 78.39 ms |

较大集合在修复前的零延迟 timer 延后约 485–646 ms，与同步查询阻塞一致；修复后冷查询 timer 延后 1.98 ms，热查询为 0.11–5.27 ms。修复前较大集合的阶段测量包括读取约 89.4 ms、摘要约 4.2 ms、协议约 37.4 ms、Compiler/物品解析约 414.2 ms，因此读取与摘要也一并移入 worker。

测量环境为 Windows 原生 Node/tsx，冷查询包含源码 worker 的 tsx 启动成本，不能作为 production Electron 首次载入耗时。热查询仍重新读取所有包内容，只复用摘要相同的完整校验结论；这里测得的是本次样例的总耗时和等价 main 事件循环响应，不代表所有机器或配置集合，也不声称已有用户卡顿报告。

## 原始审查：范围与总体判断

本次重点检查 Electron main、preload、renderer、隐藏导出 renderer，以及共享可视化层的调用关系、状态归属、进程生命周期和数据传递。C++ Runtime 与 Compiler 仅核对整体职责及桌面调用入口，未做同等深度的逐模块审查。

当前主链路：

```text
YAML -> TS Compiler -> IR -> C++ Runtime -> GSR -> Analyzer -> Analysis
                                                               |
                                         Analysis + DisplayConfig
                                                               |
                                                        CDF ViewModel
                                                        /           \
                                                   桌面预览       素材导出
```

| 层 | 当前职责 | 审查判断 |
| --- | --- | --- |
| `src/main/` | 配置安装、原生进程、结果会话、保存与导出 | 主要职责归属正确，内部生命周期处理不统一 |
| `src/preload/` | 固定 IPC 操作与事件订阅 | 桥接能力受限，但实现与静态契约缺少直接约束 |
| `src/renderer/` | 页面、表单、交互与任务反馈 | 部分跨页业务状态依附页面生命周期 |
| `src/visualize/` | 输入校验、CDF 模型、画面与动画 | 桌面与导出共享实现，边界值得保留 |
| `src/export-renderer/` | 隐藏窗口中的逐帧渲染 | 与桌面宿主隔离合理 |

没有发现足以支持整体重写的大量业务代码复制。主要问题是状态和生命周期分散、同一数据被反复传递与计算，以及部分实现没有完整落实既有边界。

## 原始问题清单与修复策略

优先级表示建议处理顺序：P1 为已暴露正确性或失败恢复问题；P2 为职责、性能和边界问题；P3 为类型组织及冗余整理。

| 编号 | 优先级 | 问题 | 证据状态 |
| --- | --- | --- | --- |
| D01 | P1 | 旧保存响应覆盖新会话或同会话的新草稿 | 两种顺序均在真实 Electron 中注入延迟 IPC 后复现 |
| D02 | P1 | 退出失败后准入无法恢复，恢复时还可能丢失资源所有权 | 源码及准入状态确认；导出清理失败后释放所有权已用依赖注入确认 |
| D03 | P1 | CDF 建模触发数组展开异常，载入错误处理不完整 | 大数组及超出可视化数值范围的小输入均通过校验后在建模阶段失败 |
| D04 | P1 / P2 | analyzer 取消缺少保护；进程基础能力重复 | P1 为取消恢复问题，P2 为公共能力整理；并发重复终止已用依赖注入确认 |
| D05 | P2 | 文案保存和预览反复传递、重建完整分析数据 | 源码确认，未测量实际交互耗时 |
| D06 | P2 | 配置列表和状态查询同步执行整包校验 | 源码确认，未测量实际卡顿时长 |
| D07 | P2 | 桌面 IPC sender 检查和事件接收范围不统一 | 源码确认，非桌面窗口调用 CPU 查询已验证 |
| D08 | P3 | IPC 类型与实现需要多处手工同步 | 源码确认 |

### D01：旧保存响应覆盖新会话或同会话的新草稿

相关代码：[ResultEditorPage](../../src/renderer/pages/ResultEditorPage.tsx)、[App](../../src/renderer/App.tsx)。

编辑页维护自己的 `save_queue`、`save_version` 和 `fields_ref`。保存成功后，`apply_state()` 会通过 `on_state()` 更新 App 的共享结果。App 切换页面时会卸载编辑页，但已经发出的异步操作仍可回调父组件。

局部版本号只区分当前组件内的保存请求，不能判断 App 是否已经切换结果会话；卸载时也没有使旧回调失效。

复现顺序：

1. 在结果编辑页载入 A，修改标题。
2. 点击结果可视化导航，字段失焦触发保存，测试暂缓返回保存响应。
3. 在结果可视化页载入 B，确认画面已经显示 B。
4. 返回 A 的保存响应。
5. 已卸载编辑页的回调更新 App，画面从 B 变回修改后的 A。

复现使用真实 Electron 与 production renderer，IPC 数据和响应延迟由临时测试脚本注入，未修改真实结果文件。临时脚本已移除，当前仓库尚无覆盖该顺序的回归测试。

复审还确认了同一会话内的变体：修改 A 并离开编辑页，暂缓保存响应；返回编辑页后输入新草稿，再返回旧响应。旧组件更新 App 后，新组件的 `useEffect([state])` 会把新草稿覆盖为旧响应中的字段。因此只检查 `session_id` 不足以解决全部问题。

修复策略：

- 在 renderer 中建立由 App 持有的结果会话 controller，集中管理载入、已保存字段、当前草稿、保存队列和错误；页面只订阅状态和提交操作。页面切换不销毁这些业务状态，载入忙碌状态跨页共享，同一时刻只发起一次选择和分析。main 仍是文件和结果会话身份的权威。不引入通用状态框架。
- 分别跟踪载入请求、会话身份、草稿修改代次和保存请求身份。保存响应只能确认对应的已保存快照；若当前草稿已变化，不回填覆盖。旧会话响应不能修改新会话的字段、错误或忙碌状态。
- 保留失焦保存及同会话保存串行执行。保存失败后保留草稿和可重试错误，返回页面后仍可恢复；更换结果成功后，旧会话回调不再影响当前状态。
- 导出前由 controller 等待 renderer 保存队列完成，再进入现有 main reservation 和保存屏障流程；不能只等待尚未收到 renderer 排队请求的 main `save_queue`。保存失败或会话切换时停止该次导出准备，并沿用导出流程的身份检查。

验收条件：跨页载入 B 后 A 的旧响应不能恢复 A；返回 A 后新输入不能被旧响应覆盖；保存失败后跨页返回仍可重试；多个排队保存后的导出使用最后成功保存的字段；旧响应不能解除新请求的忙碌状态。controller 行为测试覆盖异步交错，真实 Electron 补充上述两种已复现顺序。

### D02：退出失败后的准入和资源所有权无法一致恢复

相关代码：[main 入口](../../src/main/index.ts)、[UserRequestAdmission](../../src/main/request_admission.ts)、[ExportTaskCoordinator](../../src/main/export_task.ts)。

`shutdown_all()` 首先调用 `admission.begin_shutdown()`，将 `shutting_down` 设为 `true`。后续原生进程终止失败时，窗口关闭及应用退出的错误分支会恢复 `quitting = false`，但准入对象没有对应恢复操作。

结果是窗口仍存在，用户可以继续操作，但新的模拟、分析、保存和配置变更会被拒绝，提示 `application is shutting down`。即使原任务随后结束，该状态也不会自行恢复。

源码确认了退出失败分支；额外检查确认准入对象进入 shutdown 后持续拒绝请求。本次没有对真实进程执行终止失败注入。

复审发现恢复准入的额外前提：`ExportTaskCoordinator.shutdown()` 在最终清理重试失败后仍清空任务并释放导出占用。这仅在应用确定退出时才符合其实现意图；若另一个 shutdown 分支失败而保留窗口，未清理资源就失去了可重试所有者。依赖注入检查已确认“host 清理仍失败，但 coordinator 不再 active 且导出占用已释放”的状态。`shutdown_all()` 的 `Promise.all()` 还会在单个分支拒绝时提前返回，此时其他分支可能仍在收尾。

修复策略：

- 沿用退出失败时保留窗口并反馈错误的交互，恢复到受现有任务约束的可操作状态。退出请求在 main 中统一协调、去重，不再由各关闭入口分别恢复部分布尔值。
- 区分“尝试停止和清理”与“已确定退出后的最终释放”。仍可返回窗口的退出尝试中，清理失败必须保留 host、任务身份、导出占用及重试入口。不能通过清空进程或任务引用制造清理成功。
- 聚合并等待本次已启动的停止操作结束，再决定恢复准入；对等待 `close` 的路径先落实 D04 的超时。恢复的只是本次 shutdown 的全局阻塞，不能清除仍有效的导出占用，也不能撤销已接受的模拟取消决定。
- 在原生终止失败而进程仍存活时，继续保留任务的互斥和取消重试约束。对话框等异步操作返回后，在真正启动任务或变更会话前重新检查准入，避免退出前已进入的 handler 绕过 shutdown。
- 成功清理后才销毁主窗口。包括 `exit-after-export-cleanup` 在内的入口，不应先销毁窗口再执行仍可能失败的其他任务清理；已有导出产物提交点和清理重试语义保持不变。

验收条件：终止失败后窗口和任务重试入口保留；残留导出资源仍阻止冲突请求；一个分支失败时不能在其他分支仍收尾期间提前恢复准入；重试清理成功后可再次正常操作和退出；重复退出只执行一轮协调；退出前打开的文件选择对话框返回后不能启动被准入拒绝的操作。覆盖真实 Electron 关闭入口和注入的终止、清理失败，不要求真实制造无法终止的进程。

### D03：CDF 数组展开异常及建模失败的载入边界

相关代码：[CDF view model](../../src/visualize/view/cdf_view_model.ts)、[Analysis 校验](../../src/visualize/data/analysis.ts)、[Analysis Schema](../schemas/analysis.schema.json)。

`build_cdf_view_model()` 使用 `Math.max(...values, statistic.MAX)` 计算横轴范围。该写法把每个分布点展开为函数实参，输入较大时会超过运行时允许的实参数量。

本次构造了 200,000 个递增分布点及对应累计概率，JSON 大小为 3,378,184 字节。输入通过现有 `validate_analysis()`，但建模抛出 `RangeError: Maximum call stack size exceeded`。该体积低于 analyzer 输出的 64 MiB 限制；具体失败点数依赖运行时，不能将 200,000 当作固定阈值。

App 在 React 渲染阶段构建模型，异常没有在结果选择请求内转成载入失败反馈，因此还需要检查页面错误处理边界。

200,000 是不同结果值的数量，不是模拟 run 数。此处受限的是一次函数调用的实参数量，而不是数组容量或遍历能力。复审构造的另一份 200,000 点输入为 3,378,112 字节，同样复现该异常；样例不同，字节数不作为验收阈值。另外，一份仅 469 字节、包含超出 safe integer 范围整数的输入，也可通过 Analysis 校验后在建模时被拒绝。这类数值拒绝符合现有可视化范围契约，缺陷是没有在载入流程中妥善反馈。

修复策略：

- 保留现有 Analysis 校验和逐值 safe integer 转换，用 `Math.max(values[values.length - 1], statistic.MAX)` 替代数组实参展开，保留原有横轴留白和最小范围规则。数组非空和严格递增由现有 validator 保证；仍需比较 `statistic.MAX`，因为 validator 不重新验证统计量与分布的数学关系。
- main 在提交新结果会话前，使用共享可视化建模入口确认候选输入可用；renderer 在结果选择的异步流程中准备模型并捕获错误，成功后才发布新的共享结果状态。已构建的 renderer 模型交由 D05 复用，不再把首次建模仅留给 React 渲染阶段。
- 建模失败时反馈载入错误并保留最后有效结果；页面渲染增加可恢复的局部错误边界作为兜底，不能仅捕获 IPC 异常或仅显示一个无法重新选择文件的错误页。
- 本修复不新增分布点数上限，不降低 64 MiB Analysis 上限，不修改模拟规模或 CDF 精度。图表绘制成本另作测量，不把未验证的性能担忧改成输入限制。

验收条件：200,000 点的合法输入可建模，横轴范围正确；单点、零值及 `statistic.MAX` 与末项不一致的已校验输入保持既有范围规则；超范围整数能反馈载入失败且不替换 main/renderer 的有效会话；失败后可再次成功载入。测试不固定 JavaScript 引擎的实参数量阈值，也不将“模型可构建”表述为已验证大数据绘制流畅。

### D04：原生进程生命周期重复实现且保护不一致

相关代码：[SimulationTask](../../src/main/simulation.ts)、[ResultEditor](../../src/main/result_editor.ts)、[ExportHost](../../src/main/export_host.ts)。

三个模块各自维护子进程、退出 Promise、错误输出、终止和清理状态，但保护措施不同：

- 模拟进程有取消 Promise 去重、等待退出超时和重试入口。
- 分析进程的 `cancel()` 直接终止后等待 `close`，没有等待退出超时，也没有取消去重。输出超限后的每次数据到达还可能再次触发取消。
- FFmpeg 有独立的等待退出超时和清理重试机制，使用自己的终止路径。

不同进程的协议和产物提交语义确实不同，不宜把全部业务合并成一个通用任务类。但“终止、等待退出、超时、保留所有权”这些基础能力存在重复维护，且已出现保护差异。

另外，`resolve_native_executable()` 和 `terminate_native_process()` 位于模拟业务模块，结果编辑模块通过导入 `simulation.ts` 使用公共能力，依赖方向不够清晰。

复审通过注入子进程确认，两次并发 analyzer 取消会调用两次终止；未收到 `close` 时，两次取消都保持等待。尚未复现真实 analyzer 无法退出的场景，不能将故障注入结果描述为真实原生进程故障。

修复策略：

- P1：先给 analyzer 取消增加进行中 Promise 去重和有界的 `close` 等待。终止失败或超时后保留子进程及重试入口；后续收到 `close` 时才能释放。进程退出已完成时不重复终止，退出与终止错误竞态采用现有模拟任务的处理原则。
- 输出超限时锁定该次失败和停止决定，后续数据不再触发重复终止；退出后仍报告原始超限错误。已关闭进程的旧回调不能清除新任务状态。
- P2：再将原生可执行文件定位、终止和有界等待等基础能力迁出 `simulation.ts`，由模拟及分析任务复用。FFmpeg 按其 stdin、背压和清理语义接入适用的基础能力，不强行统一终止策略。
- 各任务继续负责自己的协议、取消决定、产物提交与清理。公共工具不管理整个任务状态机，也不能自动吞掉清理错误或替调用方释放所有权。

验收条件：并发取消只执行一次终止；无 `close` 时在可配置超时内失败且仍可重试；自然退出与取消竞态不误报存活进程；连续超限数据只触发一次停止；关闭后可启动下一次分析。保留现有模拟取消、FFmpeg 背压、逐产物提交及清理失败重试检查。

### D05：文案保存和预览反复传递、重建完整分析数据

相关代码：[ResultEditor](../../src/main/result_editor.ts)、[ResultEditorState](../../src/shared/result_editor.ts)、[ResultEditorPage](../../src/renderer/pages/ResultEditorPage.tsx)、[App](../../src/renderer/App.tsx)。

修改六个展示字段中的任意一项，失焦保存后 main 返回完整 `ResultEditorState`，包含整份 `analysis`。因此仅保存少量文字也会通过 Electron IPC 再次序列化和传递分布数组。

编辑页在函数体中直接调用 `build_cdf_view_model()`，字符输入和其他状态变化都会重新转换 `values`、创建 `chart_points` 并计算 marker。App 另外维护正式画面的模型；该模型在已有结果时即会构建，不以可视化页是否打开为前提。

修复策略：

- 依托 D01 的 controller 按会话保留稳定的 Analysis 引用；载入时传递完整结果，保存响应只返回会话标识和经 main 校验、实际保存的 DisplayConfig。同步修改共享响应类型、main、preload 和 renderer，不能只在接收后丢弃已跨 IPC 传输的 Analysis。
- 在 `src/visualize/` 内拆分可复用的数值准备与展示字段组合：数值转换、分布点、marker 位置和横轴范围以 Analysis 为依据；标题、名称、说明、单位及格式化文本以 DisplayConfig 为依据。桌面和导出继续经过同一套共享入口。
- controller 复用数值准备结果，按已保存字段构建正式画面、按草稿构建编辑预览。纯文案变化不重新转换分布数组或查询数值 marker；不能只给依赖每次输入都变化的 `fields` 加 `useMemo` 就视为完成。
- 导出快照保留必要的独立复制和冻结边界，不能与后续编辑共享可变数据。不引入全局无界缓存，切换会话后释放无消费者的旧数据。

验收条件：保存响应不包含分布数组；纯文案编辑复用数值数据且即时更新展示文本；修改单位不会改变曲线和 marker；新会话不复用旧分析数据；导出快照不随后续编辑变化。记录代表性大分布输入的保存响应体积、建模和输入耗时，不以未测量的收益决定进一步重构。

导出快照为保证任务隔离而执行的复制有实际用途，不能据此把所有 `structuredClone()` 都判定为冗余。本次未测量 IPC、内存或输入延迟的实际增量。

### D06：配置列表和状态查询同步执行整包校验

相关代码：[ConfigManager](../../src/main/config_manager.ts)、[SimulationTask](../../src/main/simulation.ts)、[批量配置校验](../../packages/config-compiler/src/batch.ts)。

`list_configs()` 和 `state()` 通过目录扫描调用 `validate_config_directory()`，同步读取文件，并校验配置及全部终止条件，再读取物品列表。运行模拟时又对所选配置执行整包校验，随后重新读取文件进行单次编译。安装流程在写入安装元数据前后也连续执行目录校验。

这些操作都位于 Electron main。普通列表和状态查询承担完整配置验证，使查询成本随配置数量、文件体积和终止条件数量增长；网络刷新 TTL 不会缓存这些本地扫描结果。

修复策略：

- 先记录典型及较大配置集合的扫描、解析、校验和 main 阻塞耗时，再决定 worker 范围；“同步整包校验存在”与“用户已遇到可感知卡顿”分别陈述。
- 分离文件快照读取、完整协议及 Compiler 校验、列表投影和运行编译。让 `list_configs()` 与 `state()` 复用同一份已验证的本地快照；远程 index TTL 与本地快照有效性分开管理。
- 安装、更新、卸载、切换本地目录后立即使对应快照失效；用户显式刷新同时重新读取本地配置。查询仍按现有文件安全和大小检查读取当前包的文件集合与内容，以包文件集合及全部内容摘要为依据，复用未变化包的完整校验结果；包内任一配置或终止条件改变时重新验证该包。本地外部修改应在下一次查询反映，不能只依赖文件监听或时间戳。若测量表明读取和摘要仍有明显阻塞，也纳入后述 worker 范围。模拟前仍重新读取、验证实际输入，不能依赖旧列表中的合法性结论。
- 保留非法配置不进入有效列表的行为。安装时只改变安装元数据的步骤复用此前已验证的包内容，单独核对新增元数据及文件集合，不为相同内容重复执行整包 Compiler 校验。运行校验与编译尽量消费同一份已读取的输入，避免重复读取导致使用另一份内容。
- 若测量确认解析或编译持续阻塞 main，再移入受控 worker。异步扫描与编译也必须受目录身份、请求代次、任务准入和 shutdown 约束，不能发布旧目录扫描结果或在退出后启动原生进程。

验收条件：两个查询得到一致的有效配置集合；增删改配置、删除目录、安装失败和切换目录后不会长期展示错误快照；启动模拟仍拒绝失效输入；扫描并发不发布过期结果。对比同一输入集合的耗时，worker 是否需要实施以测量结果决定，不设置未经讨论的新配置数量或大小上限。

### D07：桌面 IPC sender 检查和事件接收范围不统一

相关代码：[main IPC 注册](../../src/main/index.ts)、[桌面 preload](../../src/preload/index.ts)、[导出 preload](../../src/preload/export.ts)。

导出请求和外部链接请求检查 sender 是否属于主窗口；多数配置、模拟和结果接口没有同样检查。模拟事件还通过 `BrowserWindow.getAllWindows()` 广播，接收范围包括隐藏导出窗口。

额外创建的非桌面测试窗口成功调用了 `get-logical-cpu-count`，确认该桌面 IPC 未统一限制 sender。测试窗口显式开启 Node 能力，仅用于验证 main 侧检查；本次没有证明正式隐藏 renderer 能直接调用这些接口，也没有验证可利用攻击链。

修复策略：

- 建立桌面 IPC 注册入口，所有桌面操作先检查 sender 为仍有效的主窗口 `webContents`，并检查 `senderFrame` 为该窗口主 frame；通过后再执行参数校验、准入及业务操作。不能因为查询只读就跳过身份检查。
- 模拟和导出事件均只投递到当前有效的主窗口。窗口销毁后停止投递，不通过全窗口广播补发；导出 renderer 保持独立 preload、消息校验和 job/frame 身份检查。
- 桌面窗口身份检查不等同于任意载入页面都可信；同时核对主窗口导航边界，避免主窗口导航到非应用内容后继续获得桌面操作能力。开发 renderer URL 与 production 本地页面分别按应用配置识别，不扩大到任意 URL。

验收条件：主窗口正常操作；其他窗口及非主 frame 的请求在业务副作用前被拒绝；隐藏导出窗口不再收到模拟事件；销毁窗口后的发送不抛出未处理错误；导出逐帧通道继续正常工作。该修复落实边界，不宣称已存在或已验证攻击利用链。

### D08：IPC 类型与实现需要多处手工同步

相关代码：[DesktopApi](../../src/shared/installed_config.ts)、[preload 实现](../../src/preload/index.ts)、[main handlers](../../src/main/index.ts)。

新增或修改操作通常需要分别维护 main handler、preload 对象和 `DesktopApi`。preload 对象没有直接接受 `satisfies DesktopApi` 等约束，`ipcRenderer.invoke()` 的返回值也没有形成可靠的跨层静态契约检查。

整个桌面 API 定义在 `installed_config.ts`，该文件同时承载配置、模拟、结果和导出入口，与文件主题不符。

修复策略：

- 将 `DesktopApi` 和桌面 channel 的请求、响应、事件映射集中到独立共享契约模块；配置数据类型保留在其主题模块中。只做职责迁移，不变更持久化协议或引入版本字段。
- preload 暴露对象直接接受 `DesktopApi` 约束，并通过受 channel 映射约束的 invoke helper 发起调用；main 注册 helper 使用同一映射约束经过运行时校验后的 handler 参数及返回值。与 D07 的 sender 检查组合，避免各 handler 自行选择是否接入。
- `ipcRenderer.invoke()` 当前返回 `Promise<any>`，所以只加 `satisfies DesktopApi` 不能验证 wire channel 或实际响应。将原始 Electron API 的无类型边界限制在 helper 内，业务代码不靠任意 `as` 断言绕过映射；main 仍将原始请求视作不可信输入。
- 保留独立的运行时校验与行为测试，确认实际跨 IPC 的响应符合契约；静态映射不能证明运行时对端返回的数据正确。当前规模不引入代码生成框架。

验收条件：错误 channel、错误参数和错误 handler 返回类型能由类型检查检出；preload 操作及事件订阅满足统一契约；覆盖至少一条正常跨层往返及非法输入拒绝；D05 的精简保存响应在三层一致。类型检查使用有意义的类型负例，不通过测试源文件精确拼写来验证契约。

## 原实施顺序与保留边界

1. 修复 D03 的建模及载入错误路径；完成 D04 的 P1 取消保护，再实施依赖其有界收尾的 D02 退出恢复。
2. 修复 D01 的会话、草稿和保存归属，随后实施 D05 的精简保存响应及数值准备复用；导出保存屏障一并验收。
3. 合并设计 D07、D08 的桌面 IPC 注册和类型入口，保证统一 sender 检查与请求、响应约束落在同一套接入路径。
4. 整理 D04 的 P2 公共能力；对 D06 先测量再收敛查询与校验，worker 按测量结果实施。

上述策略沿用现有持久化契约、失焦保存和失败后保留窗口的行为，不需要新增支持范围或用户可见的数据限制。本文明确修复方向，不代表已经授权一次性实施所有代码改动；具体开发按后续任务范围进行。

保留现有 Compiler、Runtime、Analyzer 和共享可视化的分层。导出流程中的 reservation、目标身份检查、逐产物提交和清理重试各有用途；不能仅因 `ExportHost` 文件较大或状态较多就删除这些语义。后续可以按独立职责拆出进程工具和文件提交模块，暂不需要通用任务框架。

检查命令及完整影响矩阵以 [Development Checks](../DEVELOPMENT_CHECKS.md) 为准。实施 D01/D02/D04/D05/D07/D08 时执行 Electron 行为、typecheck、lint 和 build；D03/D05 另覆盖 CDF、布局及共享导出消费；涉及真实导出宿主时执行对应集成检查。验收条件是后续应补的检查，不能用初审测试通过代替。

## 已执行验证与限制

### 2026-11-01 初审

- Production build 通过，包括现有 TypeScript 检查。
- 通过直接调用 `tsx --test` 执行下列 12 个测试文件，共 135 项通过：
  - `src/main/config_download.test.ts`
  - `src/main/config_manager.test.ts`
  - `src/main/native_pipeline.test.ts`
  - `src/main/simulation.test.ts`
  - `src/main/result_editor.test.ts`
  - `src/renderer/simulation_items.test.ts`
  - `src/renderer/export_workflow_controller.test.ts`
  - `src/export-renderer/export_renderer.test.ts`
  - `src/main/export_host.test.ts`
  - `src/main/export_task.test.ts`
  - `src/visualize/test/cdf.test.ts`
  - `src/visualize/test/analysis.test.ts`
- 额外通过 TypeScript Compiler API 启用 `noUnusedLocals`、`noUnusedParameters` 检查，检出 `ExportHost.cancelled`。未修改项目检查配置。
- D01 使用独立临时用户目录及隐藏 Electron 实例复现；D03 使用内存构造的 Analysis 复现。临时脚本和用户目录已移除，这些额外检查尚未转为仓库回归测试。
- 未运行完整布局测试、真实导出宿主集成检查、打包检查或 C++ 全量检查。本次没有修改业务源码，也没有执行架构重构。

### 2026-11-02 复审与后续更新

- 复审 production build 通过；直接运行配置管理、模拟、结果编辑、导出宿主、导出任务、导出 controller、CDF 和 Analysis 共 8 个测试文件，118 项通过。该集合与初审 12 文件集合不同，不能据此推断测试数量减少。
- 隐藏真实 Electron 使用隔离用户目录和延迟 IPC，再次复现跨会话旧保存响应，并新增复现同会话返回页面后的新草稿被旧响应覆盖。仅注入测试响应，未修改真实结果文件。
- 内存构造的 200,000 点 Analysis 通过校验后在建模时抛出 `RangeError`；469 字节的超范围整数输入通过校验后被可视化范围转换拒绝。
- 依赖注入确认 analyzer 并发取消会重复终止，且未收到 `close` 时保持等待；导出最终清理重试失败后仍释放 coordinator 任务和占用。没有制造真实 analyzer 或 FFmpeg 无法终止的故障。
- 用户随后明确移除 WSL 支持，已删除 main 中的 WSL 路径转换、Explorer 启动分支和相关导入；此次代码改动后 `test:simulation` 共 48 项、typecheck、lint、改动文件格式检查及 production build 通过。未执行其他冗余清理。
- 临时复现脚本及隔离用户目录已清理，额外复现尚未转为仓库回归测试。复审未执行完整布局、真实导出集成、打包或 C++ 全量检查。
- 本次文档更新只确定修复策略，未实施 D01–D08 的代码修复；文档链接检查结果在本次交付时单独报告。

### 2026-11-03 修复实施与验收

- D01–D08 的实现与回归测试已完成，按四批执行独立审查；历史复现已经转为常驻测试，不再依赖初审的临时脚本。
- 配置事务/刷新收尾等待同样有界，超时保留原 Promise 与事务占用，旧响应由代次拒绝；慢下载超时后的恢复、迟到响应拒绝及正常重试已有回归覆盖。
- 最终标准 `test:simulation` 84/84、`test:visualize:cdf` 24/24、`test:electron-export` 65/65、typecheck、全量 lint、全量格式检查及普通 production build 通过。
- 新 production Electron 定向检查 5/5 通过：真实 worker 的 list/state/模拟准备编译、IPC sender/frame/URL 边界、旧保存响应、非法载入恢复、退出失败恢复和真实 PNG 导出清理失败重试。原生进程和隐藏窗口失败由注入模拟，没有真实制造无法终止的 analyzer/FFmpeg 或锁死资源。
- 较大合法 CDF 仅确认可建模，不等于验证绘制流畅；D05/D06 性能测量范围与冷启动成本已单独标明。
- 最终 `test:electron-layout` 12/12 通过，包含四尺寸布局、三个原有专项及五个真实桌面生命周期/IPC 场景；上述标准回归合计 185 项通过，无 skip。17 个 UI 场景截图完成，并人工查看小/大窗口的结果编辑、可视化及导出画面。
- 强制真实 ExportHost 像素探针 PNG/MP4 集成通过，随后普通 `pnpm run build` 通过，构建产物已恢复为无探针版本；仓库 Markdown 链接检查 1/1 通过。未改 C++ 或发布依赖，未执行无关的 C++ 全量检查及 Windows 安装包验证。
