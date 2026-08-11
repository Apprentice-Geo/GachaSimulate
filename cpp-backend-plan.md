# GachaSimulate C++ Backend Implementation Plan

## 1. 状态与目标

本文是 [C++ Backend / TypeScript Compiler Design](cpp-backend-draft.md) 的实施计划，当前**阶段一至五均已完成**。

目标是用共享 TypeScript Compiler 和 C++ Runtime 替换当前 Python 模拟后端，同时保持配置仓库、Electron、CLI 和可视化之间清晰的契约边界。实施只分五个可验收阶段；阶段内可以拆任务，但不再把每个文件或组件提升为独立里程碑。

相关边界：

- 当前代码地图和信任边界：[Architecture](docs/ARCHITECTURE.md)。
- 当前 YAML 行为基线：[YAML Config Syntax](docs/YAML_CONFIG_SYNTAX.md)。
- 配置仓库与 manifest：[Electron Config Repository MVP Plan](electron_config_repository_mvp_plan.md)。
- 检查矩阵：[Development Checks](docs/DEVELOPMENT_CHECKS.md)。

## 2. 已确认决策

- `@gachasimulate/config-compiler` 是不依赖宿主的纯 TypeScript 包，由 Electron、CLI 和独立配置仓库共同使用。
- manifest / index 的 `format_version`、模拟 DSL 的 `schema_version`、JSON IR 的 `ir_version` 和 GSR 的二进制版本分别管理各自契约。
- config 和 termination 禁止 metadata 与未知根字段；展示、metrics、termination 名称和来源说明属于 manifest。
- `draw_count` 是 Runtime 通过保留合成槽位维护的只读内建变量；`every_draw` 没有其它 Action 时可以省略。
- TS Compiler 完成全部静态校验、符号解析、默认值、CDF 和 termination retain 合并；C++ 不解析 YAML。
- RuntimeState 只保留执行所需状态，不保存 `acquired` / `reduced`。
- `AddItem` 和 `SetItem` 在修改库存后立即触发完整批次 resolve；`ReduceItem` 不触发。
- C++ 同时支持固定 run 数和累计抽数目标；后者允许最终 `total_draw` 超过请求值。
- C++ 只输出 GSR，不双写 NPZ 或 `_visualize.json`。
- 独立 C++ result 模块统一负责 GSR 编解码和 draw / cost 统计；`gachasimulate-analyze` 读取 GSR 并输出纯分析 JSON，统计不进入 `gachasimulate-core` 的执行路径。
- TypeScript 只向 analyzer 传递 `draw` 或 `cost`，不传递物品索引；随后合并通用展示信息并生成内存中的 `VisualizeInput`，既有展示和导出层继续消费规范化后的数据。
- JSONL completed 事件包含 `result_path`、`total_runs` 和 `total_draw`，不包含 `visualize_path`。
- Python/C++ 不承诺相同 seed 逐样本一致；同一 C++ core 构建在相同 seed、线程数和 chunk 策略下必须可复现，不承诺跨编译器或跨 core 版本逐样本一致。

## 3. 执行原则

### 3.1 权威切换

Python 在前三个阶段继续作为现有行为参考，不在 C++ 单线程语义和批量路径通过门禁前删除。对照测试只比较公开行为，不复制 Python 内部对象结构。

第四阶段完成 CLI 和 TS 结果链路后，Python 与 C++ 可以并行用于验收。只有第五阶段完成 Electron 切换、全量检查和代表性 benchmark 后，C++ 才成为默认执行权威，并删除不再需要的 Python 产品路径。

### 3.2 兼容边界

本迁移明确包含以下破坏性协议变更，不提供长期双写或隐式兼容层：

- YAML 增加 `schema_version`，移除模拟 YAML metadata 和显式 `draw_count` 维护。
- `SetItem` 开始触发 item resolve。
- `.gsr` 替换 `.npz`，不再保存 `lifetime_acquired`。
- 可视化改为通过独立 C++ analyzer 读取并统计 GSR，再由 TS 数据层适配为 `VisualizeInput`。
- completed JSONL 事件移除 `visualize_path`。

迁移在同一阶段机械更新仓库内配置、fixture、共享类型和文档，不让新旧契约长期共存。

### 3.3 暂不实施

- Condition jump bytecode、完整 VM、固定宽度 opcode 和 active rule list。
- Alias Method、SIMD、mmap、lock-free result pipeline。
- Protobuf、FlatBuffers、自定义 Binary IR 或 GSR 压缩。
- 不同线程数之间的逐样本一致。
- GSR 到 JSON 的持久化导出。
- 任意物品统计、结果展示信息编辑及其持久化协议。
- 未经测量证明必要的分段读取或额外缓存层。

### 3.4 本地 C++ 构建约定

- C++ 原生模块位于 `cpp/`，使用 CMake 3.25 及以上版本构建独立可执行文件，语言标准为 C++20。CMake 工程不得写死编译器或生成器。
- 首个已验证的开发环境是 Windows x64 + MSVC；当前本机为 MSVC 19.50、CMake 4.2.3。MSVC 专用参数必须放在 `if(MSVC)` 分支中，Windows 专用入口和路径处理必须与 Runtime core 隔离，因此首阶段不承诺 Linux 支持，也不主动阻止其它编译器构建。
- 本机从 Visual Studio x64 Developer PowerShell 或 Native Tools Command Prompt 构建，默认使用 Visual Studio 生成器：

  ```powershell
  cmake -S cpp -B build/cpp -A x64
  cmake --build build/cpp --config Debug
  ctest --test-dir build/cpp -C Debug --output-on-failure
  ```

- Release 构建通过 `cmake --install` 安装到稳定的 `build/native/` 前缀，core 和 analyzer 位于其 `bin/` 子目录；Electron 本地开发只依赖该安装布局，不解析生成器内部目录：

  ```powershell
  cmake --build build/cpp --config Release
  ctest --test-dir build/cpp -C Release --output-on-failure
  cmake --install build/cpp --config Release --prefix build/native
  ```

- MSVC 构建静态链接对应配置的 C/C++ Runtime（Release 使用 `/MT`，Debug 使用 `/MTd`）。不得启用 `/fp:fast`、`-ffast-math` 或面向本机 CPU 的指令集选项。
- JSON parser 使用 CMake `FetchContent` 获取固定版本的成熟库，下载归档必须校验 `URL_HASH`；首版不引入 vcpkg、Conan 或自研依赖包装。只有实际出现离线构建需求时才改为 vendoring。
- C++ 测试使用 GoogleTest 提供断言、fixture 和参数化能力，由 CTest 通过 `gtest_discover_tests` 发现并运行。GoogleTest 仅在 `BUILD_TESTING` 启用时通过 `FetchContent` 获取固定版本和校验哈希，沿用项目的 `/MT`、`/MTd` 设置；测试目标不安装，首版不使用 GoogleMock。
- Windows 命令行入口必须接收 Unicode 路径，IR、JSONL 和诊断文本统一使用 UTF-8；不得依赖当前控制台代码页。
- sanitizer 使用独立开发构建，不作为普通 Debug 或 Release 产物。首版不增加 CMake Presets 或额外构建包装脚本，出现第二套重复构建参数后再引入。

## 4. 阶段一：冻结契约与共享 Compiler

**完成状态：已完成。** 已建立独立的 `@gachasimulate/config-compiler`，冻结 YAML v1 到 JSON IR 的基础契约，并将 `draw_count` 固定为 Compiler-owned 只读槽位。IR 已使用平坦 arena、整数 ID、ActionRange、CDF 和有效 retain；`item_resolve` 额外输出 `reduce_per_batch`，供 Runtime 无需重新解释 action DSL 即可计算分解批次。

### 目标

先把 YAML、manifest、IR、GSR 和 JSONL 的边界固定为可测试契约，并建立唯一的 TS 编译实现。此阶段不实现 C++ 模拟语义。

### 工作

- 建立可发布的 `@gachasimulate/config-compiler` workspace 包，公共核心不依赖 Electron、网络、ZIP 或文件系统。
- 在 config 中加入 `schema_version`；termination 继承该版本。
- 将仓库内模拟 YAML metadata 移入 manifest，禁止 config / termination metadata 和未知根字段。
- 把 `draw_count` 改为只读内建符号；Compiler 为它分配固定的合成运行时物品槽位，YAML 不得声明同名物品，Action / Loader 不得写入该槽位。机械移除现有 item 声明和 `every_draw` 自增，并保留当前“每轮先计数，再执行 every_draw”的顺序。
- 收紧静态校验：重复 YAML key、非有限数、不安全整数、重复 retained item、无 Action 的 repeat 成功路径和所有现有引用约束。
- 实现 YAML 到版本化 JSON IR 的编译，包括整数 ID、ActionRange、condition arena、effective retain 和 Pool CDF。
- 固定 GSR v1 的完整 header、字段宽度、endianness、section 布局、字符串编码、可选 cost 表示及资源上限。
- 固定 JSONL stage、progress 和 completed 事件结构。
- 更新 Python 参考实现和行为测试以采用已确认的新 YAML 语义；建立 TS/Python 共用的合法与非法 fixture。

### 门禁

- 所有迁移后的仓库配置都能由 TS Compiler 编译，并仍能由更新后的 Python 参考实现运行。
- TS 与 Python 对共享合法/非法 fixture 给出相同结论。
- IR、GSR 和 JSONL 都有语言无关的有效、截断、越界和版本错误 fixture。
- `config-compiler` 的打包产物能从工作区外真实导入。

## 5. 阶段二：C++ 单线程语义闭环

**完成状态：已完成最小单线程闭环。** `cpp/` 现提供 C++20 Runtime 库、严格 JSON IR Loader、`single_run()` 与 CTest；阶段三已将诊断 CLI 替换为批量任务 CLI。Runtime 覆盖 initial、every_draw、pool draw/change、嵌套 draw、resolve、once/per_draw/repeat 规则、AND/OR 条件及 terminate。C++ 单次和批量结果与 Python 参考统计的正式对照，待阶段四 C++ GSR reader 和统计能力完成后实施。

### 目标

使用单线程 C++ Runtime 跑通完整 DSL；在正确性门禁通过前不加入并行和性能专用结构。

### 工作

- 按 3.4 的本地构建约定建立最小 C++ core、CTest 入口和 install target，使用固定版本的成熟 JSON parser 加载 IR，不自行实现 JSON。
- 实现严格 IR Loader 和只读 `RuntimeProgram`。
- 实现 RuntimeState、ActionFrame executor、Pool draw、condition evaluator、rule modes、termination 和 item resolve。
- 保持父节点 Action 先于 child、OR 首个成功分支、AND 声明顺序聚合、嵌套 Action 深度优先和 terminate 全栈停止。
- 用确定性配置覆盖 initial、every_draw、pool change、nested draw、once、per_draw、repeat、多路径 termination、retain 合并以及 Add/Set resolve。

### 门禁

- 单线程 C++ 对无随机歧义 fixture 与 Python 得到相同库存、draw count、终止原因和 Action 顺序。
- 所有非法 IR 在 Loader 边界失败，不进入 Runtime。
- terminate、nested draw 和 resolve 不依赖 C++ 调用栈递归执行 Action。
- 代表性真实配置能够完成单次 run，且 sanitizer 或等价运行时检查不报告越界和未定义行为。

## 6. 阶段三：批量、并行与 GSR

**完成状态：已完成。** Runtime 支持 fixed runs 和 target total draw，chunk 定义与 worker 数可独立控制，使用稳定 chunk seed 和按 index 归并保证调度无关的可复现结果。core 输出严格 JSONL stage/progress/completed/error 事件并写入 GSR v1；CTest 覆盖两种目标、固定 chunk 的串并行一致性、重复执行、可选 cost、协议事件和语言无关的 GSR 字节 fixture。完整路径 benchmark 已覆盖 IR 加载、批量模拟和 GSR 写入，并保留按 run、按 draw 的性能基线。

### 目标

完成可复现的批量模拟、进度、结果归并和 GSR 写入，并用完整模拟路径衡量性能。

### 工作

- 实现 fixed runs 和 target total draw 两种任务拆分。
- 使用编号稳定的 chunk、确定的 seed 派生和按 chunk index reduce；线程只共享只读 RuntimeProgram 与原子进度。
- target total draw 为每个 chunk 预分配目标并完成完整 run，不使用竞争式全局停止。
- 实现 ResultChunk、确定性归并和 GSR writer；可选 cost section 由 IR 是否包含 cost item 决定。
- 输出严格 JSONL started、stage、progress、completed 和 error 事件；普通诊断只写 stderr。
- benchmark 覆盖从 RuntimeProgram 到 GSR 的完整批量路径，并按每抽或每 run 成本解释不同配置。

### 门禁

- fixed runs 返回精确 run 数；target total draw 达到或超过目标。
- 同一 core 构建以相同 seed、线程数和 chunk 策略重复运行得到相同 GSR 语义数据。
- 多线程结果与相同 chunk 定义的串行执行一致，完成顺序不影响 reduce 顺序。
- GSR writer 通过阶段一固定的字节 fixture、截断检查和边界值测试。
- 代表性 benchmark 证明新后端具备切换价值；未达到目标时先 profile 已实现路径，不提前引入暂缓优化。

## 7. 阶段四：C++ 结果分析与 TS CLI

**完成状态：已完成。** 独立 `gachasimulate_result` 统一维护 GSR writer、严格 reader 和 draw/cost 统计，`gachasimulate-analyze` 输出 analysis v1 JSON。`@gachasimulate/cli` 已打通 YAML Compiler、临时 IR、core 与 analyzer；TypeScript 适配器严格校验整数边界并复用现有 `VisualizeInput` 校验。本阶段未切换 Electron 或修改其文件选择流程。

### 目标

从 YAML 到 GSR、纯分析 JSON 再到现有可视化视图模型，形成不依赖 Electron 的完整命令行链路。

### 工作

- 建立独立 C++ result 模块，统一维护 GSR v1 writer、reader 和统计；core 只调用 writer，统计不进入 core 的执行路径。
- 先固定 analysis JSON 的版本、字段、数值范围和错误边界，再新增并安装 `gachasimulate-analyze`；它接收 GSR 路径和 `draw | cost`，对 magic、version、section、长度、偏移、UTF-8 和资源上限重新校验，并把单个纯分析 JSON 写到 stdout，普通诊断写到 stderr。
- analyzer 计算 draw / cost CDF、分位数、mean level 和 termination reason distribution，并保持现有 Python 的线性 percentile 后取整、mean 取整及 termination 百分比最大余数分配规则；首版只对所选 metric 做一次内存排序，不实现任意物品统计、mmap 或分段算法。
- TS 结果适配器校验 analyzer 输出，合并通用标题、固定说明、空价格/单位和 GSR 文件修改时间，生成内存中的 `VisualizeInput`；不写回 GSR，也不生成 sidecar。
- 在转为 `VisualizeInput` 前拒绝超出 JavaScript 安全整数范围的 totals、CDF 值和统计量，避免 `u64` 静默丢失精度。
- 建立 CLI 包装层：调用 config-compiler、写临时 IR、启动 C++ core、转发 JSONL，并管理临时文件生命周期。
- 同步共享 SimulationEvent 类型，completed 删除 `visualize_path`，保留 totals。
- 保持 React 组件不解析二进制、调用进程或计算统计；Electron 的 GSR 文件选择和错误展示留到阶段五统一切换。

### 门禁

- CLI 的两种目标模式都只产生一个 GSR，并输出合法 completed 事件。
- C++ reader 能读取 writer 生成的 GSR 和语言无关 fixture，并拒绝损坏、超版本和超限文件。
- 同一 GSR 的 draw / cost 统计与 Python 参考算法在数值规则上相同。
- analyzer 只接受 `draw` 和 GSR 实际包含的 `cost`，不接受 TS 提供的任意物品索引；其 JSON 输出通过版本、字段、未知字段和数值范围校验后才能进入可视化层。
- TypeScript 适配器与素材导出可共用现有视图模型；Electron 接入留到阶段五，不形成第二套统计实现。
- 代表性 GSR 未证明一次内存排序不可接受前，不引入 mmap、分段架构或额外缓存。

## 8. 阶段五：Electron 切换与收尾

### 目标

让 Electron 默认使用 TS Compiler、C++ core 和 C++ analyzer，完成生命周期、配置仓库和文档迁移后移除旧产品路径。

**完成状态：已完成。** Electron 直接编译临时 IR 并运行受信任的 core；结果页按 draw/cost 调用 analyzer 并原子保存完整展示 sidecar。Python 实现、测试、benchmark 工具和依赖已删除，最终验收记录见 [迁移收尾报告](docs/archived/CPP_MIGRATION_FINAL.md)。

### 工作

- SimulationTask 使用共享 compiler 和 CLI/core 进程协议，保持 main、preload、renderer 信任边界。
- 开发安装和最终应用打包同时包含 `gachasimulate-core` 与 `gachasimulate-analyze`，并从同一受信任的原生程序目录解析二者，不接受 Renderer 提供的可执行文件路径。
- Renderer 请求只保留受 CPU 数限制的 threads，并保持任务互斥、取消、关闭应用和异常退出行为。
- 配置仓库构建与安装继续使用同一个 compiler 包；manifest metadata 不进入 IR。
- 更新结果目录、GSR 选择、状态反馈和错误信息，使用按 metric 区分的完整 visualize sidecar。
- 运行完整检查、Electron 人工验收和代表性 benchmark；只根据 profile 结果决定后续优化。
- C++ 成为默认执行权威后，删除不再使用的 Python CLI/批量后端和旧结果保存代码；保留仍被开发工具或对照测试明确需要的最小部分。
- 同步 README、Architecture、YAML Config Syntax、Visualize Frontend Implementation 和 Development Checks。

### 门禁

- Electron 可以安装或选择配置，完成两种目标模式，取消任务并打开 GSR 结果；退出后没有残留进程。
- config repository、Electron 和 CLI 使用同一 compiler 公共入口。
- main 不接受 Renderer 提供的任意命令、IR 路径或结果路径。
- 删除前 Python 全量检查通过；删除后 TypeScript、Electron、可视化和 C++ 检查矩阵通过。
- 文档不再把 `.npz + _visualize.json`、Python runtime 或模拟 YAML metadata 描述为当前契约。

## 9. 完成标准

满足以下条件即完成迁移：

- YAML 只承载模拟语义，manifest 只承载包和展示信息。
- TS Compiler 是 YAML 到 IR 的唯一实现，并被主仓库与配置仓库复用。
- C++ Runtime 是默认模拟执行权威，支持单线程、多线程和两种目标模式。
- GSR 是唯一持久化模拟结果，C++ analyzer 能安全读取，TS 数据层能校验分析结果并生成现有可视化模型。
- GSR 编解码和统计只有一份 C++ result 模块实现，core 与 analyzer 保持独立可执行入口。
- JSONL、取消和 Electron 进程生命周期行为通过自动化和人工验收。
- 性能结论来自完整路径 benchmark；未证明必要的优化仍未实现。
