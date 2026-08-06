# GachaSimulate Electron 模拟 MVP 实施计划

## 1. 目标

本计划只实现开发环境可运行的 Electron 模拟 MVP。用户不需要手动执行模拟命令，即可在桌面应用中选择预置配置、填写参数、运行或取消模拟，并加载生成的可视化结果。

开发环境默认具备：

- Windows 11
- Node.js 与 pnpm
- Python 3.12
- uv
- GachaSimulate 仓库源码

本计划完成后，配置商店仍然只是占位页面。远端配置仓库、下载、校验、安装和卸载由后续 `electron_config_store_mvp_plan.md` 单独规划。

## 2. 范围

### 2.1 包含

- 使用 electron-vite 启动 Electron main、preload 和 React renderer。
- 单个 `BrowserWindow` 和侧边栏导航。
- 运行模拟、配置商店占位、结果可视化三个页面。
- 从 Electron 用户数据目录扫描已安装配置。
- 开发模式首次启动时放置匿名的典型预置配置。
- 模拟参数填写、校验、启动、进度、取消和结果状态。
- Python CLI JSONL 机器输出模式。
- 固定次数和累计抽数在串行、多进程模式下的统一进度上报。
- 打开结果目录。
- 选择任意位置的 `_visualize.json` 并复用现有输入校验和可视化页面。
- 与影响范围匹配的 Python、TypeScript 和 Electron 行为检查。

### 2.2 不包含

- 配置仓库和配置商店实际功能。
- 配置下载、SHA-256、ZIP 解压、安装、卸载和更新。
- 本地配置导入功能。
- React Router。
- 多任务并行、任务历史和结果历史。
- 结果文件冲突处理或自动打开最新结果。
- 完整实时日志页面或错误摘要/详情分层。
- 表单参数持久化。
- Electron 安装包、ASAR、代码签名、自动更新和最终打包工具选型。
- 内置 Python、无开发环境运行和干净机器验证。

## 3. 已确认设计

### 3.1 源码布局

采用 electron-vite 的 main、preload、renderer 边界，保留现有 `src/visualize/`：

```text
src/
├─ main/
├─ preload/
├─ renderer/
│  ├─ App.tsx
│  ├─ pages/
│  └─ ...
├─ visualize/
└─ gachasimulate/
```

`src/visualize/` 继续维护可视化输入处理、视图模型和画面组件。Electron renderer 只组合这些能力，不复制 CDF 计算或输入校验。

### 3.2 页面导航

- 不引入 React Router。
- renderer 顶层使用简单页面状态切换。
- 使用侧边栏切换三个固定页面。
- 模拟完成后停留在运行模拟页面。
- 配置商店页面显示后续提供的空状态。

出现深层链接、浏览历史或多个详情页需求后，再评估路由库。

### 3.3 用户数据目录

应用运行数据从一开始写入 `app.getPath("userData")`：

```text
<userData>/
├─ configs/
│  └─ installed/
├─ results/
└─ temp/
```

Renderer 不接收或拼接这些目录。路径解析、目录创建和文件读写全部位于 main。

### 3.4 开发命令

```text
pnpm dev       -> 启动 electron-vite 开发环境
pnpm dev:web   -> 保留现有浏览器可视化开发环境
```

Electron main 在开发阶段以仓库根目录作为 `uv run` 的工作目录，确保 uv 能找到当前项目。

### 3.5 Electron 安全边界

`BrowserWindow` 至少启用：

```text
contextIsolation: true
nodeIntegration: false
```

preload 只暴露明确的 `desktopApi`，不暴露通用 IPC channel、Node API、文件系统或子进程能力。main 必须重新校验 Renderer 发来的所有参数。

## 4. 预置配置

### 4.1 目的

模拟 MVP 尚无配置商店。如果首次启动后没有配置，桌面模拟流程无法验收。因此仓库提供几个不指涉现实作品或卡池的典型预置配置。

建议最小集合：

| ID | 展示名称 | 主要覆盖能力 |
|---|---|---|
| `basic_probability` | 基础概率样例 | probability 池、单目标终止 |
| `staged_pool` | 阶段切换样例 | weight 池、计数器、once/per_draw rule、change pool |
| `point_exchange` | 积分兑换样例 | cost、积分累计、repeat rule、多条终止路径 |
| `duplicate_resolve` | 重复物分解样例 | item_resolve、retained_items、二级 pool、收集型终止 |

配置只描述抽象规则，不使用现实作品、角色、卡池、货币名称或现实概率。

### 4.2 存放和初始化

```text
configs/presets/
├─ basic_probability/
├─ staged_pool/
├─ point_exchange/
└─ duplicate_resolve/

tests/fixtures/configs/
└─ 仅测试使用的正常、损坏和边界配置
```

开发模式启动时，如果 `<userData>/configs/installed/` 为空，则复制预置配置。目录非空时不覆盖、不补齐，避免修改用户已有数据。测试专用配置不复制到用户数据目录。

后续配置商店计划再决定预置配置能否卸载和更新。

### 4.3 最小 manifest 契约

每个可展示配置包含：

```yaml
id: basic_probability
name: 基础概率样例
description: 展示基础概率池和单目标终止

terminations:
  - file: obtain_target.yaml
    name: 获得目标物品
```

扫描时必须确认：

- `id` 与安装目录名一致。
- `id` 只包含 ASCII 字母、数字、下划线和连字符。
- `config.yaml` 存在。
- `terminations` 非空，展示名称非空。
- termination 使用相对文件名，解析后仍位于当前配置目录。
- 每个 termination 文件存在。

非法配置不进入运行列表，同时记录诊断信息；单个配置损坏不能阻止应用启动。

## 5. 桌面模拟流程

```text
选择已安装配置
→ 选择终止条件
→ 设置互斥目标和其他参数
→ 启动模拟
→ 查看阶段与进度
→ 完成、失败或取消
→ 打开结果目录，或进入结果页选择可视化 JSON
```

### 5.1 表单字段

- 目标类型：固定模拟次数或目标累计抽数，二选一。
- 目标值：正整数。
- 随机种子：整数；留空按 `0` 处理。
- worker 数：正整数，默认 `1`，上限为系统逻辑 CPU 数。
- 统计维度：`draw` 或 `cost`。

选择 `cost` 时，如果配置未定义 cost item，main 或 Python 必须拒绝运行并返回明确错误。

### 5.2 单任务约束

同一时间只允许一个活动任务。Renderer 的按钮禁用只是交互反馈，main 仍须拒绝重复启动请求。

任务状态：

```text
idle
→ starting
→ running
→ saving
→ completed | failed | cancelled
```

`starting`、`running` 或 `saving` 状态下，用户发出取消后进入 `cancelling`，直到进程树退出；该状态下不能再次启动或取消。

## 6. Python CLI 契约

### 6.1 路径参数

现有 `--config <name>` 行为保持兼容。Electron 调用需要增加显式配置目录能力：

```text
--config-dir <directory>
--termination <filename>
--results-dir <directory>
```

`--config` 和 `--config-dir` 互斥。使用 `--config-dir` 时，配置文件固定为目录内的 `config.yaml`，termination 必须解析在同一目录内。

开发调用示例：

```text
uv run gachasimulate \
  --config-dir <userData>/configs/installed/basic_probability \
  --termination obtain_target.yaml \
  --total-runs 10000 \
  --seed 0 \
  --workers 1 \
  --metric draw \
  --results-dir <userData>/results \
  --output-format jsonl
```

### 6.2 JSONL 模式

新增：

```text
--output-format jsonl
```

默认模式继续输出当前人类可读文本。JSONL 模式约束：

- stdout 只输出逐行 JSON 事件。
- stderr 输出诊断和异常文本。
- 每行是一个完整 JSON 对象并立即 flush。
- 不输出 tqdm 或其他普通日志到 stdout。

最小事件：

```json
{"type":"started"}
{"type":"stage","stage":"loading_config"}
{"type":"stage","stage":"simulating"}
{"type":"progress","completed":5000,"total":10000,"unit":"runs"}
{"type":"stage","stage":"saving"}
{"type":"completed","result_path":"C:/.../result.npz","visualize_path":"C:/.../result_visualize.json","total_runs":10000,"total_draw":523417}
{"type":"error","message":"完整错误文本"}
```

首版不增加协议版本和错误码。

### 6.3 事件规则

- `progress.completed` 单调递增。
- 固定次数使用 `unit: "runs"`。
- 累计抽数使用 `unit: "draws"`。
- 累计抽数进度钳制到目标值，实际总抽数由 `completed.total_draw` 报告。
- 模拟阶段结束时强制输出一次 `completed == total` 的进度。
- CLI 最多每 100 ms 输出一次进度，阶段切换和最终进度不受节流影响。
- `completed` 中的结果路径使用绝对路径。
- 应用异常时输出一个 `error` 事件并以非零状态退出；详细诊断仍可写入 stderr。

### 6.4 Electron 对进程结果的判定

| 事件和退出情况 | UI 结果 |
|---|---|
| 收到 `completed` 且退出码为 0 | 成功 |
| 收到 `error` 且非零退出 | 显示 `error.message` |
| 未收到 `error` 且非零退出 | 显示完整 stderr 文本 |
| 收到 `completed` 但非零退出 | 协议失败 |
| 收到 `error` 但退出码为 0 | 协议失败 |
| 退出码为 0 但没有 `completed` | 协议失败 |
| Electron 主动终止进程 | cancelled |

空行可以忽略。无法解析的非空 stdout 行属于致命协议错误，main 应终止进程树并报告失败。
未知事件类型忽略并记录诊断；已知事件缺少必填字段属于致命协议错误。

首版错误区域直接显示完整错误文本，不增加摘要、展开详情或完整日志页面。stderr 必须设置内存长度上限，超出时保留末尾内容。

## 7. Python 统一进度接口

`core` 的两种公开批量模拟入口接受同一种可选累计进度回调：

```python
progress_callback(completed: int, total: int) -> None
```

约束：

- core 不感知 JSONL。
- 串行固定次数每完成一个 run 增加 `1`。
- 串行累计抽数每完成一个 run 增加该 run 的抽数。
- 多进程 worker 只通过进程安全队列报告增量。
- Python 父进程聚合增量并调用回调；worker 不写 JSONL。
- 普通 CLI 使用同一回调更新 tqdm。
- JSONL CLI 使用同一回调输出节流后的 progress 事件。

现有累计抽数多进程队列可以收敛为统一机制；固定次数多进程补充相同的增量队列。不要引入常驻服务、HTTP、Socket 或 Node 原生 Python 绑定。

## 8. Preload API 与 IPC

Renderer 只获得以下最小能力：

```ts
interface DesktopApi {
  listInstalledConfigs(): Promise<InstalledConfig[]>;
  startSimulation(request: SimulationRequest): Promise<void>;
  cancelSimulation(): Promise<void>;
  selectVisualizeFile(): Promise<SelectedVisualizeInput | null>;
  openResultsDirectory(): Promise<void>;
  onSimulationEvent(listener: (event: SimulationEvent) => void): () => void;
}
```

要求：

- 不提供任意 channel 的 `invoke` 或 `send`。
- `startSimulation` 只接收配置 ID、termination 文件名和模拟参数，不接收命令或配置绝对路径。
- main 根据已扫描配置解析真实路径，并再次验证所有字段。
- `totalRuns` 与 `targetTotalDraw` 必须且只能提供一个。
- 事件订阅返回取消订阅函数，React 组件卸载时移除监听。
- main 只保存一个活动子进程和对应任务状态。

## 9. 取消与应用退出

Windows 开发阶段使用：

```text
taskkill /PID <pid> /T /F
```

取消时：

1. main 将任务标记为 cancelling。
2. 执行 `taskkill` 终止 Python 主进程及 worker。
3. 等待原进程退出。
4. 发送 cancelled 事件并清除活动任务。

模拟运行或取消处理中关闭窗口时，先显示确认对话框。用户放弃关闭则任务继续；用户确认后终止进程树再退出。应用不得留下 Python worker。

## 10. 结果和可视化

继续生成成对结果：

- `.npz`
- `_visualize.json`

相同参数重复运行仍允许覆盖。模拟成功后，运行页面显示结果路径和“打开结果目录”按钮，不自动切换页面或加载结果。

结果页面的文件流程：

```text
Renderer 请求选择文件
→ main 打开仅显示 JSON 的文件对话框
→ main 读取 UTF-8 文本
→ Renderer 使用现有 validate / normalize / view model
→ 展示现有可视化页面
```

允许选择任意位置的 `_visualize.json`。文件名和扩展名只用于文件对话框过滤，内容仍必须符合 `docs/schemas/visualize_input.schema.json`。Renderer 不直接访问文件系统，Electron 接入不得复制输入校验、CDF 计算或展示模型。

## 11. 实施阶段

### 阶段 1：Electron 开发脚手架

工作：

1. 安装并配置 Electron 和 electron-vite。
2. 新建 main、preload、renderer 入口。
3. 调整 TypeScript、ESLint、Prettier 和构建配置，使三个进程边界被检查。
4. 将 `pnpm dev` 切换为 Electron，增加 `pnpm dev:web`。
5. 创建安全配置的单个 `BrowserWindow`。

不在本阶段建立配置商店、模拟或文件 IPC 空壳。

验收：

- `pnpm dev` 启动 Electron。
- `pnpm dev:web` 仍能启动现有可视化网页。
- renderer 无 Node.js 全局能力。
- 前端格式、lint、typecheck 和 build 通过。

### 阶段 2：桌面应用外壳

工作：

1. 实现侧边栏和三个页面状态。
2. 配置商店页只显示占位空状态。
3. 把现有可视化能力作为结果页内容复用。
4. 保持现有深色数据监控台视觉方向和基础可访问性。

验收：

- 三个页面可切换。
- 不依赖 React Router。
- 现有浏览器可视化和 CDF 导出不回归。

### 阶段 3：预置配置与扫描

工作：

1. 创建四个匿名预置配置及 manifest。
2. 为每个预置配置运行现有 validator/builder 行为检查。
3. 开发模式为空目录执行一次性复制。
4. main 扫描、校验并返回可展示配置。
5. Renderer 实现配置和终止条件选择。

验收：

- 空安装目录在开发启动后出现四个预置配置。
- 再次启动不覆盖已有目录。
- 损坏配置被跳过，其他配置仍可使用。
- manifest 路径穿越和 ID 不匹配被拒绝。

### 阶段 4：Python JSONL 与统一进度

工作：

1. CLI 增加 `--config-dir` 和 `--output-format jsonl`。
2. core 增加统一进度回调。
3. 串行、多进程和两种目标统一父进程进度语义。
4. 普通 CLI 继续使用 tqdm，JSONL 模式只输出协议。
5. 错误输出和退出码遵守协议表。

验收：

- 现有 CLI 命令行为保持兼容。
- 四种模拟组合均输出单调进度和最终 100%。
- JSONL stdout 每个非空行都能独立解析。
- `.npz` 与 `_visualize.json` 仍成对生成。

### 阶段 5：Electron 模拟任务

工作：

1. 实现表单和 Renderer/main 双层校验。
2. main 使用固定命令启动 `uv run gachasimulate`。
3. 按行解析 JSONL 并转发类型化事件。
4. 实现任务状态机、重复启动保护和错误显示。
5. 实现 Windows 进程树取消。
6. 关闭窗口时实现确认和清理。

验收：

- 四种执行组合能从 UI 启动并完成。
- 运行期间不能开始第二个任务。
- 非法 JSONL 和非零退出显示完整错误。
- 取消多进程任务后没有残留 Python worker。

### 阶段 6：结果文件与可视化接入

工作：

1. 实现打开结果目录。
2. 实现 main 文件选择和 UTF-8 文本读取。
3. 结果页复用现有输入校验、normalize、view model 和画面组件。
4. 显示文件取消、读取失败和 schema 校验失败状态。

验收：

- 模拟完成后可打开正确结果目录。
- 可选择任意位置的合法 `_visualize.json`。
- 损坏 JSON 或不符合 schema 的 JSON 显示错误且应用不崩溃。
- 现有可视化动画和交互保持可用。

### 阶段 7：收尾与文档

工作：

1. 更新 README、架构说明、前端实现边界和开发检查命令。
2. 明确 Electron 仍只支持开发环境。
3. 将配置商店未实现能力链接到独立后续计划。
4. 运行影响范围内的完整检查。

## 12. 测试策略

### 12.1 Python 自动化测试

至少覆盖：

- `--config` 旧路径和 `--config-dir` 新路径。
- JSONL 成功事件顺序与字段。
- JSONL 应用错误事件和非零退出。
- 固定次数串行、多进程进度。
- 累计抽数串行、多进程进度。
- 进度单调且最终达到目标。
- 结果文件成对生成并可由现有加载逻辑读取。

测试断言协议行为，不绑定进度回调的内部实现方式或精确输出次数。

### 12.2 TypeScript/Electron 自动化测试

至少覆盖：

- manifest 正常、损坏、ID 不匹配和路径穿越。
- 模拟请求互斥目标和数值边界。
- JSONL 分行、空行、非法 JSON、未知事件和缺失字段。
- `completed`、`error` 和退出码组合。
- 重复启动被 main 拒绝。
- 选中文件内容继续通过现有可视化校验。

不引入像素快照测试，不为纯类型或固定文案增加低价值测试。

### 12.3 人工 Electron 验收

- `pnpm dev` 可启动单窗口应用。
- 三个页面可切换。
- 四种模拟组合可运行并显示阶段、进度和结果。
- cost 不可用时有明确错误。
- 多进程任务可取消，任务管理器中无残留 worker。
- 运行时关闭窗口会确认并正确清理进程。
- 结果目录可打开。
- 合法结果可视化正常，损坏输入显示错误。
- 整个模拟操作流程不要求用户手动执行命令。

## 13. 检查命令

实施时先运行与当前阶段直接相关的检查，完成后运行：

```powershell
uv run ruff format --check .
uv run ruff check .
uv run pyright
uv build --wheel
uv run pytest

pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:visualize:cdf
pnpm run test:e2e
```

如果新增 Electron 专用测试脚本，应将其加入 `package.json` 和 `docs/DEVELOPMENT_CHECKS.md`，并在最终检查中执行。

## 14. 完成标准

满足以下条件即完成模拟 MVP：

- `pnpm dev` 可以启动 Electron。
- 单窗口内可以切换运行模拟、配置商店占位和结果可视化页面。
- 开发环境首次启动可获得匿名预置配置。
- 能扫描合法配置及终止条件，跳过损坏配置。
- 能填写和校验两种互斥模拟目标、种子、worker 和统计维度。
- 能调用本地 `uv run gachasimulate`。
- 四种执行组合都能显示阶段和进度。
- 能取消 Python 及其 worker 进程树。
- 能显示成功、完整失败文本和取消状态。
- 能打开结果目录。
- 能选择合法 `_visualize.json` 并使用现有页面展示。
- Python 普通 CLI、浏览器可视化和 CDF 导出没有回归。
- 自动化检查通过，人工 Electron 验收通过。

## 15. 后置计划边界

模拟 MVP 只产生和消费本地已安装配置目录，不实现配置来源管理。后续配置商店 MVP 复用以下既有契约：

- `<userData>/configs/installed/<id>/`
- `manifest.yaml`
- `config.yaml`
- manifest 中声明的 termination 文件

配置商店计划负责远端索引、下载、SHA-256、安全解压、原子安装、卸载、离线行为，以及预置配置的更新和卸载策略。不得把这些能力提前塞入模拟 MVP。
