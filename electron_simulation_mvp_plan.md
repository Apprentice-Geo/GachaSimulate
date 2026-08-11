# GachaSimulate Electron 模拟 MVP 完成记录

> 历史记录：其中 Python、worker、NPZ 和旧 sidecar 描述已被 `cpp-backend-plan.md` 第五阶段替代，不代表当前契约。

## 1. 状态

Electron 开发第一阶段已经完成。本文不再作为待执行计划，只记录当前实现基线、稳定契约和仍有效的后续事项。

第二阶段配置仓库工作见 [Electron 配置仓库 MVP 实施计划](<electron_config_repository_mvp_plan.md>)。具体命令、架构边界和可视化维护要求分别以 README、Architecture、Development Checks 和 Visualize Frontend Implementation 为准。

## 2. 第一阶段成果

当前开发环境可以完成以下桌面流程：

```text
启动 Electron
→ 选择已安装配置和终止条件
→ 设置目标、种子、worker 和统计维度
→ 启动、观察或取消模拟
→ 查看结果状态并打开结果目录
→ 选择 _visualize.json 展示结果
```

已实现：

- electron-vite 驱动的 main、preload 和 React renderer。
- 单个 `BrowserWindow` 和固定侧边栏导航。
- 运行模拟、配置仓库占位、结果可视化三个页面。
- `<userData>/configs/installed/` 配置扫描和 manifest 校验。
- 四个匿名开发预置及空安装目录初始化。
- 固定次数和目标累计抽数两种互斥目标。
- 串行及多进程模拟的统一进度回调。
- Python CLI 的显式配置目录和 JSONL 机器输出。
- Renderer/main 双层请求校验和单任务保护。
- Windows Python 进程树取消、失败恢复和关闭窗口清理。
- `.npz` 与 `_visualize.json` 成对保存。
- 打开结果目录和选择任意位置的 `_visualize.json`。
- 复用平台无关的可视化输入校验、view model、画面和导出能力。
- Electron 配置扫描、IPC、任务生命周期和结果输入行为测试。

配置仓库页面仍是占位页；远端 index、下载、安装、重新安装和卸载不属于第一阶段实现。

## 3. 当前源码边界

```text
src/main/       操作系统、用户数据、配置扫描、文件对话框、模拟子进程
src/preload/    明确的 desktopApi
src/renderer/   桌面导航、模拟表单、状态和结果宿主
src/shared/     IPC 请求、事件和返回类型
src/visualize/  平台无关的可视化输入、模型、画面、动画和导出
src/gachasimulate/ Python 模拟核心、CLI、进度和结果保存
```

Renderer 不直接访问 Node.js、文件系统、任意 IPC channel 或子进程。main 对 Renderer 请求重新校验，Python 通过独立 CLI 和 JSONL 协议与桌面端交互。

## 4. 已安装配置契约

当前安装目录为：

```text
<userData>/configs/installed/<id>/
├─ manifest.yaml
├─ config.yaml
└─ termination YAML
```

当前 manifest 结构为：

```yaml
id: basic_probability
name: 基础概率样例
description: 展示基础概率池和单目标终止
terminations:
  - file: termination.yaml
    name: 获得目标物品
```

扫描和启动边界：

- `id` 必须与目录名一致，只允许 ASCII 字母、数字、下划线和连字符。
- `config.yaml` 必须存在。
- termination 必须是 manifest 声明的单个相对文件名，并且文件存在。
- 损坏配置被跳过，不能阻止应用启动或其他配置运行。
- 启动模拟前，main 再次确认配置 ID 和 termination 组合属于扫描结果。

第一阶段 manifest 没有格式版本或 `metrics`。第二阶段会执行破坏性升级，不保留旧 manifest 兼容。

## 5. 开发预置现状

当前 `configs/presets/` 包含：

- `basic_probability`
- `staged_pool`
- `point_exchange`
- `duplicate_resolve`

应用启动时，如果安装目录为空，会复制全部预置；目录非空时不覆盖或补齐。它们只用于配置仓库尚未实现时运行和验收模拟，不是长期产品内容。

第二阶段远端安装流程可用后，将删除预置目录、自动初始化逻辑和对应测试。应用不会主动删除开发机用户数据中已经复制的文件。

## 6. 模拟请求和任务状态

表单字段：

- 目标类型：固定模拟次数或目标累计抽数，二选一。
- 目标值：正整数。
- 随机种子：整数，默认 `0`。
- 工作进程数：`1` 到系统逻辑 CPU 数。
- 统计维度：`draw` 或 `cost`。

Renderer 在提交前使用共享校验，main 保留最终校验。配置没有 `cost` item 时，当前运行时会拒绝 `cost`；第一阶段界面尚不能提前判断配置能力。

任务状态为：

```text
idle
→ starting
→ running
→ saving
→ completed | failed | cancelled
```

取消期间使用 `cancelling`。main 同一时间只保存一个活动任务，并拒绝重复启动。致命 JSONL 协议错误、用户取消和应用退出共用进程树终止边界。

## 7. Python CLI 和 JSONL 契约

桌面端使用以下已有参数：

```text
--config-dir <directory>
--termination <filename>
--total-runs <value> | --target-total-draw <value>
--seed <value>
--workers <value>
--metric draw | cost
--results-dir <directory>
--output-format jsonl
```

`--config` 旧命令行路径继续存在；`--config` 和 `--config-dir` 互斥。使用显式目录时，termination 不能离开配置目录。

JSONL 约束：

- stdout 只包含逐行 JSON 事件并立即 flush。
- stderr 用于诊断和异常文本。
- 已知事件包括 `started`、`stage`、`progress`、`completed` 和 `error`。
- 固定次数进度单位是 `runs`，累计抽数进度单位是 `draws`。
- `completed` 提供绝对结果路径、总 run 数和实际总抽数。
- 非空非法 JSON 或已知事件缺少字段属于致命协议错误。
- 未知事件被忽略并记录诊断。

成功需要同时满足：收到 `completed` 且进程退出码为 `0`。事件和退出码矛盾、零退出但没有 completed、非零退出但没有有效错误都按失败处理。

## 8. 取消和退出

Windows 使用 `taskkill /PID <pid> /T /F` 终止 Python 及 worker 进程树；其他平台发送 `SIGTERM`。

取消失败或等待进程关闭超时时：

- 任务不会永久停留在 `cancelling`；
- Renderer 收到可理解的错误并可重试；
- 关闭窗口时保留窗口并显示错误，而不是无限等待或静默遗留进程。

## 9. 结果和可视化

每次成功模拟继续生成：

- `.npz` 原始结果；
- `_visualize.json` 可视化输入。

相同参数允许覆盖现有结果。运行页面显示结果文件名，并通过 title 保留完整路径；用户可以打开结果目录。模拟完成后不自动切换页面或自动加载结果。

文件选择由 main 完成，Renderer 只接收路径和 UTF-8 文本。内容继续通过既有 schema、业务校验、normalize、view model 和共享画面，不复制 CDF 或输入校验逻辑。

## 10. 第一阶段审查结果

第一阶段审查发现均已处理，详细过程保留在 Git 历史中，不再维护独立问题清单；只有仍有效的配置能力和进度反馈进入下节。

## 11. 仍有效的后续事项

### 11.1 配置能力展示

第一阶段所有配置都能选择 `cost`，缺少 cost item 时只能在启动后报错。该问题已经迁入第二阶段：新 manifest 强制声明 `metrics`，Renderer 按声明展示可用维度，main 和运行时继续最终校验。

### 11.2 模拟进度反馈

当前 Renderer 只显示 `completed/total`。实际反馈即时性需要先单独诊断，再决定是否增加百分比、进度条和更丰富阶段说明。

该问题不属于配置仓库第二阶段，也不得通过只增加视觉进度条掩盖底层事件不及时。

### 11.3 产品化运行

Electron 当前只支持从源码启动的开发环境。安装包、内置 Python、无开发环境运行、代码签名和自动更新仍然后置。

## 12. 当前检查入口

命令和 CI 对应关系只在 [Development Checks](<docs/DEVELOPMENT_CHECKS.md>) 维护。Electron 模拟相关改动至少执行其中的 `test:simulation`、类型检查和 Electron 构建；跨 Python、可视化或导出边界时按文档扩大检查范围。
