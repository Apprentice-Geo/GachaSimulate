# GachaSimulate Electron 配置仓库 MVP 实施计划

> 该功能仍后置。本文早期 Python 兼容门禁已失效；未来实现必须直接复用 TS Compiler 与 C++ Runtime，不恢复 Python 依赖。

## 1. 状态与目标

本文是 Electron 开发的第二阶段实施计划，状态为**设计已确认，尚未实现**。

第一阶段已经完成开发环境可运行的 Electron 模拟流程。第二阶段在不改变模拟语义的前提下，引入独立配置仓库，使用户可以在桌面应用中浏览、安装、重新安装和卸载配置。

本阶段仍以 Windows 11 开发环境为验收环境，默认具备 Node.js、pnpm、Python 3.12、uv 和 GachaSimulate 仓库源码。安装包、内置运行时和无开发环境运行不属于本阶段。

## 2. 当前实现基线

第二阶段从以下既有能力继续开发：

- Electron 使用 main、preload、renderer 三层边界和单个 `BrowserWindow`。
- 应用从 `<userData>/configs/installed/` 扫描本地配置。
- 当前 manifest 包含 `id`、`name`、`description` 和 `terminations`。
- main 会校验配置 ID、termination 白名单和目录边界。
- Renderer 中的配置仓库仍是占位页面。
- Python CLI 已支持显式配置目录、JSONL 事件、进度、取消和成对结果保存。
- 当前四个匿名预置用于开发阶段启动模拟；安装目录为空时会自动复制。
- 当前配置没有 `metrics` manifest 契约，Renderer 会对所有配置展示 `draw` 和 `cost`。

这些事实是迁移起点，不是第二阶段目标状态。第一阶段完成情况见 [Electron 模拟 MVP 完成记录](<electron_simulation_mvp_plan.md>)。

## 3. 范围

### 3.1 包含

- 在主仓库建立可复用的纯 TypeScript 配置校验包。
- 将当前 Python 静态 validator 的规则迁移到 TypeScript，并建立跨语言一致性检查。
- 将校验包作为公共 `0.x` npm 包发布，供独立配置仓库固定版本使用。
- 定义语义化格式版本、manifest、metrics、配置包和远端 index 契约。
- 创建独立公开配置仓库 `GachaSimulate-Configs` 的结构、构建脚本和 CI。
- 将配置源码构建为确定性的 ZIP、SHA-256 和 `dist/<format_version>/index.json`。
- 通过 GitHub Raw 提供已提交的 `dist/`。
- Electron main 拉取、校验并展示固定官方仓库的 index。
- 安全下载、校验、解压、安装、同 ID 重新安装和卸载配置。
- 安装提交前失败恢复旧目录，以及中断后的启动恢复。
- 安装或卸载后刷新仓库页面和模拟配置列表。
- 根据 manifest 的 `metrics` 禁用无效统计维度。
- 配置仓库接通后移除开发预置及自动初始化逻辑。
- 与边界风险匹配的 TypeScript、Python、Electron 和仓库构建测试。

### 3.2 不包含

- 确定或迁移现有真实配置清单；该工作在独立配置仓库中另行确认。
- 完整的 TypeScript IR 编译和 C++ 模拟执行。
- 配置版本比较、更新提示、历史版本和回滚 UI。
- 多配置源、用户自定义源或本地配置导入。
- 仓库索引缓存和离线仓库浏览。
- 搜索、分类、标签、截图和作者主页。
- 配置图片、角色立绘、宣传图、音频、字体或其他游戏资源。
- 多个并行安装任务。
- 模拟任务并行和结果历史。
- 统一的全局错误弹窗。
- 模拟进度即时性、百分比或进度条改造。
- Electron 安装包、内置 Python、代码签名和自动更新。
- 专门的权利投诉或移除流程。

## 4. 总体架构

稳定数据流为：

```text
配置仓库 packages/<id>/
    -> 共享 TypeScript 校验
    -> 当前 Python builder 兼容性检查
    -> ZIP + SHA-256 + dist/<format_version>/index.json
    -> GitHub Raw
    -> Electron main 下载和容器安全检查
    -> 共享 TypeScript 校验
    -> <userData>/configs/installed/<id>/
    -> 当前 Python 模拟运行期再次校验
```

信任边界保持不变：

```text
Renderer
    -> 明确的 preload API
    -> Electron main
    -> 网络、临时目录、安装目录和子进程
```

Renderer 不接收任意下载 URL、安装路径、ZIP 路径或文件系统能力。远端 index、ZIP、manifest 和 YAML 都是不受信任输入，必须在拥有边界的层重新校验。

## 5. 共享 TypeScript 配置包

### 5.1 所有权和发布

共享包位于 GachaSimulate 主仓库，例如：

```text
packages/config-compiler/
```

建议 npm 名称为：

```text
@gachasimulate/config-compiler
```

它由客户端版本拥有和发布，不从配置仓库运行时下载。Electron 使用工作区版本；独立配置仓库在 lockfile 中固定公共 npm 包的明确版本。npm 名称在首次发布前确认可用，本文名称为预定名称而非已占用声明。

共享契约变化时，先更新主仓库行为测试并发布新的 npm 包版本，再由配置仓库更新精确依赖和 lockfile、重新构建 `dist/`。配置仓库不得直接引用未发布的主仓库工作区源码。

### 5.2 本阶段职责

本阶段共享：

- index 解析和校验；
- manifest 解析和校验；
- 配置包文件集合校验；
- `metrics` 与 `config.yaml` 的一致性校验；
- 当前 Python `validate_config` 和 `validate_termination` 的静态规则。

共享核心不依赖 Electron、网络或 ZIP。调用方读取文件后，以未知对象、YAML 文本或文件映射作为输入。文件系统、下载和解压适配器保留在各自宿主。

共享包提供两层入口：

- 模拟语言校验只处理 config 和 termination，拒绝 `metadata` 和其它未知根字段。
- 仓库包校验组合模拟语言校验与 manifest、文件白名单等严格规则。

未来基础编译和版本化 IR 继续在同一包中演进，但不属于本阶段。

### 5.3 Python 过渡边界

当前模拟仍由 Python 执行，因此过渡期保留两道门禁：

- 配置仓库构建在 TypeScript 校验后，对每个 termination 调用当前 Python builder，阻止发布当前运行时无法构建的配置。
- 模拟启动时继续由 Python validator/builder 校验已安装文件，防止安装后篡改或 TypeScript/Python 行为漂移。

对于 config 和 termination 的模拟语言静态规则，两种实现必须针对同一组语言无关的合法和非法 fixture 给出一致结果，包括拒绝根级 metadata 和未知字段。manifest 与包布局属于 TypeScript 包级约束，不要求现有 Python validator 重复实现。

Python 仍是当前执行运行时，因此过渡期以 Python validator/builder 的行为测试为执行权威；TS 结果不一致时阻断发布和客户端合入，修正 TS 或被测试证明错误的 Python 实现，并同步更新 YAML 语法文档。切换执行权威必须作为未来 TS/C++ 迁移的明确决策，不能在配置仓库改动中隐式发生。

## 6. 格式版本

index 和 manifest 首版共用：

```yaml
format_version: "0.1.0"
```

规则：

- 格式版本是符合 SemVer 的字符串，不是 YAML 或 JSON 数值。
- 当前客户端只接受与自身支持版本完全相同的值，不实现版本范围兼容。
- `0.y.z` 期间允许破坏性修改；破坏性修改至少提升次版本。
- 共享 npm 包版本与配置格式版本独立管理。
- index 与配置包确实需要独立演进后，再拆分两种格式版本。

模拟 DSL 另有独立版本：

```yaml
schema_version: 1
```

`schema_version` 是 `config.yaml` 的必填整数，termination 继承同目录 config 的版本。它管理 config / termination 的语法和执行语义，不替代 manifest / index 的 `format_version`；共享 npm 包版本也继续独立管理。

## 7. Manifest 契约

最小 manifest：

```yaml
format_version: "0.1.0"
id: lixin_wenxinjian
name: 李信·问心剑
description: 对应活动抽取规则

metrics:
  - draw
  - cost

terminations:
  - file: termination_all.yaml
    name: 收集全部目标

metadata:
  game: 王者荣耀
  source: https://example.com/probability
  collected_at: "2026-02-15"
  note: 可选补充说明
```

### 7.1 必填字段

- `format_version`：配置包格式版本。
- `id`：稳定配置 ID，也是安装目录名。
- `name`：用户界面展示名称。
- `description`：简短说明。
- `metrics`：可用统计维度。
- `terminations`：至少一个可选终止条件。

`id` 只允许 ASCII 字母、数字、下划线和连字符，不允许点号、路径分隔符或空白。

### 7.2 Metrics

- 只允许 `draw` 和 `cost`。
- `draw` 必须声明。
- `config.yaml` 定义 `cost` item 时必须声明 `cost`。
- `config.yaml` 未定义 `cost` item 时禁止声明 `cost`。
- Renderer 只展示所选配置声明的统计维度，main 和运行时仍执行最终校验。

### 7.3 Metadata

- `metadata` 整体可选，不强制提供来源。
- 如果存在，必须是由 JSON 兼容值组成的 mapping；内部字段在 `0.1.0` 中不作为稳定公共契约。
- `metadata` 不进入 `index.json`，客户端首版不消费。
- `metadata` 只保存来源和说明，不参与 metrics 判断、成本计算或模拟编译。
- 需要用于筛选或 UI 的字段应在后续格式版本中提升为正式字段。
- `name`、`description`、`metrics` 和 termination 展示信息不得在 metadata 中维护第二份。

配置仓库包中，名称、描述、metrics 和 termination 展示名称迁入 manifest 的正式字段；来源、采集时间、备注及旧配置中的成本说明可以原样迁入可选 `metadata`，但不获得运行语义。config 和 termination 中不再允许 metadata；迁移时必须先把仍需保留的信息移动到 manifest，再删除模拟 YAML 中的旧字段。

## 8. 配置包结构

每个 ZIP 根目录只允许：

```text
manifest.yaml
config.yaml
manifest 声明的 termination YAML
```

首版不允许嵌套目录、未声明 termination 或额外资源。所有 termination 文件名必须是单个相对文件名，解析后仍位于包根目录。

ZIP 安全由 Electron main 负责，至少拒绝：

- 绝对路径；
- `..` 路径穿越；
- Windows 和 POSIX 路径分隔符绕过；
- 符号链接及其他特殊文件；
- 重复条目和大小冲突；
- 超出下载大小、条目数或解压后总大小限制的包。

首版安全上限为：index 响应 `1 MiB`、ZIP 下载 `10 MiB`、ZIP 条目 `64` 个、单条目解压后 `2 MiB`、总解压大小 `20 MiB`。这些是客户端运行限制，不属于配置格式；调整时必须同步行为测试。

index、manifest、metrics 项和 termination 声明拒绝未知字段；`metadata` 内部字段例外。config 和 termination 在所有调用模式下都拒绝未知根字段和 metadata。

## 9. 远端 Index

`dist/0.1.0/index.json` 由构建脚本生成，不手工维护：

```json
{
  "format_version": "0.1.0",
  "configs": [
    {
      "id": "lixin_wenxinjian",
      "name": "李信·问心剑",
      "description": "对应活动抽取规则",
      "metrics": ["draw", "cost"],
      "download_url": "packages/lixin_wenxinjian.zip",
      "sha256": "..."
    }
  ]
}
```

约束：

- 展示字段从 manifest 生成，避免两份人工元数据。
- 配置 ID 不得重复。
- `download_url` 必须是相对于 index URL 的普通路径，不允许绝对 URL、协议相对 URL、根路径、`..`、反斜杠或编码后的路径分隔符。解析结果必须与 index 同 origin，且仍位于当前格式版本的 `packages/` 前缀下。
- SHA-256 使用小写十六进制字符串。
- index 顺序即首版界面顺序，不增加搜索和排序设置。

## 10. 独立配置仓库

正式仓库采用：

```text
Apprentice-Geo/GachaSimulate-Configs
```

默认分支为 `main`，建议结构为：

```text
GachaSimulate-Configs/
├─ packages/
│  └─ <config-id>/
│     ├─ manifest.yaml
│     ├─ config.yaml
│     └─ termination*.yaml
├─ dist/
│  └─ 0.1.0/
│     ├─ index.json
│     └─ packages/
│        └─ <config-id>.zip
├─ scripts/
│  └─ build_repository.ts
├─ package.json
├─ pnpm-lock.yaml
├─ pyproject.toml
├─ uv.lock
├─ CONTRIBUTING.md
└─ LICENSE
```

### 10.1 构建

构建脚本按以下顺序工作：

1. 扫描 `packages/*/manifest.yaml`。
2. 使用固定版本的共享 TypeScript 包校验每个包。
3. 使用 lockfile 中固定到 GachaSimulate 明确 Git commit 的 Python 包验证每个 termination 与现行运行时兼容。
4. 为每个配置生成确定性 ZIP。
5. 计算 ZIP 的 SHA-256。
6. 生成确定性的 `dist/<format_version>/index.json`。

配置仓库使用 `uv.lock` 和冻结安装固定 Python 依赖。升级 Python 执行权威时，先更新固定 commit 和 lockfile，再重新完成全部兼容性检查。

确定性 ZIP 使用按 POSIX 相对路径排序的文件顺序、固定时间戳、固定普通文件权限、固定压缩算法和级别，并删除宿主相关额外字段。仓库通过 `.gitattributes` 固定文本文件为 LF，Node、pnpm、ZIP 库和构建脚本版本由 lockfile 固定。相同源码和工具版本重复构建必须产生相同字节；源码未变化时重新构建不应产生 diff。

### 10.2 Dist 与 GitHub Raw

`dist/<format_version>/` 是客户端直接消费的发布产物，必须提交到 `main`：

- GitHub Raw 只能提供已经提交的文件。
- 源码、ZIP、哈希和 index 可在同一个 PR 中审查。
- CI 重新构建后检查 `dist/` 无差异，防止忘记更新或手工篡改产物。

客户端 URL 固定到自己支持的格式目录，例如 `dist/0.1.0/index.json`。发布 `0.2.0` 时保留旧目录，避免可变 `main` 使旧客户端突然失去仓库；是否停止维护旧格式由未来产品化阶段决定。

首版不使用 GitHub Pages 或 Releases。配置版本、回滚或长期二进制分发成为需求后，可再评估 Pages 提供 index、Releases 提供版本化 ZIP。

### 10.3 CI

配置仓库 CI 至少执行：

- TypeScript 格式、lint、类型和测试检查；
- 全部配置包的共享校验；
- 当前 Python builder 兼容性检查；
- 仓库完整构建；
- `dist/` 可复现且与提交一致的检查。

`dist/` 由开发者随源码提交；首版不自动创建 Release 或执行独立发布任务。

### 10.4 许可证与贡献约束

配置仓库与主仓库统一使用 Apache-2.0。主仓库后续应修正 `package.json` 中与 `LICENSE.txt` 不一致的 ISC 标识。

贡献约束：

- 只接受基于公开资料、由贡献者自行编写的 YAML。
- 允许用游戏名普通文字识别数据来源。
- 不使用官方 Logo，不以可能造成官方关联误认的方式命名或设计页面。
- 不收录图标、角色立绘、宣传图、音频、字体或其他游戏资源。
- 不大段复制公告、概率说明或活动文案，只记录模拟所需的数值和规则。
- README 明确声明项目非官方，与相关游戏及权利方无关联。
- 可选 metadata 用于记录来源、采集时间和规则说明，但首版不强制来源字段。
- Apache-2.0 只覆盖贡献者有权授权的代码和原创配置表达，不授予第三方名称、商标或素材权利。

首版不建立专门的权利投诉或移除流程。

## 11. 客户端仓库访问

客户端只使用一个编译时固定到格式版本目录的官方 index URL。开发环境允许通过明确的环境变量覆盖 URL，以便使用本地 HTTP 测试服务器或测试仓库；普通用户界面不提供配置源设置。

main 负责：

- HTTP 状态、重定向策略和响应大小检查；
- 明确的请求超时和取消；
- index JSON 解析及共享校验；
- 将相对下载路径解析到固定 index 基址；
- 网络错误转换为稳定的 Renderer 错误；
- 保留当前页面会话所使用的已校验内存快照，不把 index 持久化到磁盘。

首版不自动跟随跨 origin 或离开当前格式目录的重定向。最终响应 URL 必须继续满足官方源或开发覆盖源的 origin 与路径前缀约束。

Renderer 展示和安装操作使用同一个已校验内存快照。用户重新加载仓库成功后整体替换快照；重新加载失败时页面进入失败状态，不用旧快照伪装远端仍可用。

仓库无法访问时：

- 应用仍可启动；
- 已安装配置仍可模拟；
- 仓库页面显示上下文错误和“重新加载”；
- 没有已安装配置时，模拟页面引导用户前往配置仓库。

## 12. 安装、重新安装与恢复

### 12.1 安装流程

```text
选择 index 中的配置 ID
→ main 按已校验 index 解析 URL
→ 下载至 <userData>/temp/ 的任务目录
→ 校验响应大小和 SHA-256
→ 安全解压到同一用户数据卷的暂存目录
→ 使用共享 TypeScript 包校验完整配置包
→ 提交到 configs/installed/<id>/
→ 刷新已安装配置
```

Renderer 只提交配置 ID，不提交 URL、哈希或安装路径。main 必须从当前已校验 index 中查找全部真实参数。

### 12.2 同 ID 重新安装

同一 ID 已安装时允许再次下载。新包在暂存目录完全通过校验前，不修改旧目录。

提交阶段采用可恢复事务：

1. 新内容保存在同卷、带任务 ID 的暂存目录。
2. 将旧目录移动为同 ID、同任务 ID 的备份目录。
3. 将已验证暂存目录移动到正式位置。
4. 正式目录就位后删除备份；删除失败只留下待清理备份，不回退已经提交的新配置。

Windows 目录替换不是单个无条件覆盖操作，因此本计划中的“原子替换”定义为：

- 不向 Renderer 暴露半安装目录；
- 新正式目录尚未就位时发生正常失败，旧配置仍可用；
- 应用启动时按目录状态恢复中断任务。

启动恢复规则：

| 正式目录 | 备份目录 | 暂存目录 | 处理 |
|---|---|---|---|
| 存在 | 存在 | 任意 | 正式目录视为已提交；删除备份和残留暂存 |
| 不存在 | 存在 | 存在 | 恢复备份为正式目录；删除暂存 |
| 不存在 | 存在 | 不存在 | 恢复备份为正式目录 |
| 存在 | 不存在 | 存在 | 保留正式目录；删除未提交暂存 |
| 不存在 | 不存在 | 存在 | 删除未提交暂存 |

恢复操作本身失败时，不猜测或删除含糊目录；阻止该配置继续安装、卸载或模拟，并向仓库页面报告需要人工处理的本地状态错误。任务目录名和恢复扫描都必须重新验证配置 ID 与安装根目录边界。

首版不比较新旧内容、不显示配置版本，也不保留可供用户选择的历史版本。

### 12.3 并发约束

- 同一时间只允许一个配置仓库变更任务。
- 模拟任务活动期间，main 拒绝安装、重新安装和卸载。
- 配置变更活动期间，main 拒绝启动模拟。
- Renderer 禁用按钮只是反馈，不能代替 main 的最终约束。

## 13. 卸载

```text
用户选择已安装配置
→ Renderer 显示确认对话框
→ main 按配置 ID 重新解析并验证安装目录
→ 删除 configs/installed/<id>/
→ 刷新仓库页和模拟页
```

main 不接受绝对路径，并拒绝删除安装根目录外的任何目标。卸载后可以从官方仓库重新安装；首版不保留本地回收站或备份。

第二阶段不兼容旧 manifest，但必须让用户清理旧安装：main 额外枚举安装根目录中目录名仍符合 ID 规则的无效配置，将其作为“旧格式或已损坏”状态返回仓库页面。它们不能进入模拟列表，但可以按经过目录边界校验的 ID 卸载；如果当前 index 存在同 ID，也可以通过完整新包重新安装替换。目录名本身不符合 ID 规则的项只记录诊断，不向 Renderer 提供删除能力。客户端不解析或运行旧契约，这属于清理能力而非格式兼容。

## 14. Preload API 与共享状态

第二阶段扩展明确的 `desktopApi`，概念能力包括：

```ts
type ConfigInstallation =
  | { status: "valid"; config: InstalledConfig }
  | { status: "invalid"; id: string; reason: string };

type ConfigRepositorySnapshot = {
  configs: RepositoryConfig[];
  installations: ConfigInstallation[];
};

type DesktopApi = {
  listInstalledConfigs(): Promise<InstalledConfig[]>;
  loadConfigRepository(): Promise<ConfigRepositorySnapshot>;
  installConfig(configId: string): Promise<void>;
  uninstallConfig(configId: string): Promise<void>;
};
```

具体命名可按现有代码风格调整，但必须保持：

- 不暴露任意 IPC channel。
- 不接受任意 URL、文件路径或命令。
- 请求和返回值使用 `src/shared/` 中的明确类型。
- main 对 Renderer 参数重新校验。
- 安装或卸载成功后走同一个已安装配置刷新路径，使模拟页无需重启应用即可看到变化。

是否使用一次重新查询、共享 Renderer 状态或受限变更事件属于实现细节；不得维护两份可能漂移的安装状态。

## 15. 配置仓库页面

页面至少表达以下状态：

- 初始加载；
- 加载成功；
- 远端空列表；
- 加载失败和重新加载；
- 未安装；
- 已安装；
- 正在安装或重新安装；
- 正在卸载；
- 单项操作失败。
- 旧格式或已损坏安装项。

列表展示名称、描述和支持的统计维度。已安装项提供“重新安装”和“卸载”，未安装项提供“安装”。

错误展示遵循上下文原则：

- 仓库离线、下载失败和校验失败在仓库页面展示。
- 模拟启动错误保留在模拟表单。
- 卸载确认、关闭应用时无法终止任务等需要立即决策的情况使用模态对话框。
- 不建立所有错误共用的全局弹窗。

首版下载文件较小，只显示“下载中”，不展示百分比。

## 16. 开发预置退出策略

开发预置只用于第一阶段在配置仓库尚不存在时运行模拟。第二阶段按以下顺序退出：

1. 远端 index、安装、重新安装和模拟页刷新可用前继续保留预置。
2. 完整安装流程通过验收后，删除 `configs/presets/`。
3. 删除 `initialize_installed_configs()` 及其初始化测试。
4. 新用户数据目录不再自动获得配置。
5. 测试改用专用 fixture，不依赖产品预置。

应用不主动删除开发机用户数据目录中已经复制的预置，避免删除用户可能修改过的文件。开发者可以自行清理或在仓库页面卸载。

## 17. 实施步骤

### 步骤 1：共享契约与 TypeScript 校验包

工作：

1. 建立独立 workspace 包和公共 API。
2. 定义 `0.1.0` index、manifest、metrics 和包结构。
3. 定义模拟 DSL `schema_version`，并把模拟 YAML metadata 迁入 manifest。
4. 迁移 Python 静态 validator 规则。
5. 建立 Python/TypeScript 共用 fixture 和一致性测试。
6. 发布公共 `0.x` npm 包。

验收：

- 两种实现对模拟语言的合法和非法 fixture 结论一致。
- 包不依赖 Electron、网络或宿主文件路径。
- npm 产物可由独立临时项目安装并调用。

### 步骤 2：独立配置仓库骨架

工作：

1. 创建 `GachaSimulate-Configs`。
2. 接入固定版本共享包和当前 Python builder。
3. 实现确定性 ZIP、SHA-256 和 index 构建。
4. 提交 `dist/` 并建立 CI 可复现检查。
5. 加入最小合成配置完成端到端验收。

具体真实配置迁移不属于本计划的主仓库工作。

### 步骤 3：只读仓库接入

工作：

1. main 拉取并校验固定 index。
2. 增加最小 preload API 和共享类型。
3. 配置仓库页面展示远端列表、已安装状态、离线错误和重试。
4. 保证远端失败不影响已安装配置模拟。

### 步骤 4：安全安装与重新安装

工作：

1. 下载限制、SHA-256 和临时目录生命周期。
2. 安全 ZIP 检查和解压。
3. 共享包完整校验。
4. 新安装、同 ID 可恢复替换和启动恢复。
5. 配置变更与模拟任务互斥。

### 步骤 5：卸载、能力展示与状态同步

工作：

1. 实现确认后安全卸载。
2. 安装变更后刷新仓库页和模拟页。
3. 使用 `metrics` 限制统计维度。
4. 完成仓库页面各状态和上下文错误展示。

### 步骤 6：预置退出与收尾

工作：

1. 删除开发预置和自动初始化。
2. 更新 README、Architecture 和 Development Checks。
3. 修正主仓库许可证元数据不一致。
4. 运行跨仓库检查和人工 Electron 验收。

## 18. 测试策略

### 18.1 共享包

至少覆盖：

- SemVer 格式及不支持版本；
- manifest 必填字段、ID、metrics 和 termination；
- `cost` item 与 metrics 一致性；
- config / termination 根级 metadata 与未知字段拒绝；
- manifest metadata 的迁移和 JSON 兼容值约束；
- 当前 Python validator 的合法和非法语义；
- 未知字段、重复 ID 和路径边界；
- npm 打包后从真实入口导入。

### 18.2 配置仓库

至少覆盖：

- 全部源码配置通过共享包和当前 Python builder；
- ZIP 根结构和文件白名单；
- 相同输入构建相同字节和哈希；
- index 展示字段与 manifest 一致；
- `dist/` 与重新构建结果一致。

### 18.3 Electron main 与 IPC

至少覆盖：

- index 超时、HTTP 错误、响应过大、非法 JSON 和格式版本错误；
- 相对 URL 解析和绝对 URL 拒绝；
- SHA-256 不匹配；
- Zip Slip、符号链接、重复条目和解压膨胀；
- 新安装成功和失败清理；
- 同 ID 替换成功、提交前失败恢复旧目录、提交后清理失败保留新目录，以及启动恢复；
- 卸载目录边界；
- 旧格式或损坏安装项不能模拟，但能够安全卸载或被同 ID 新包替换；
- 模拟与配置变更双向互斥；
- Renderer 无法传入任意 URL 或路径；
- 安装状态刷新和 metrics 能力展示。

网络、文件系统、时间和子进程只在真实边界替换；测试保护可观察行为，不绑定具体 ZIP 库或内部函数调用顺序。

### 18.4 人工验收

- 新用户数据目录启动后没有预置配置。
- 仓库可用时可以浏览并安装合成或已确认配置。
- 安装后无需重启即可在模拟页面使用。
- 同 ID 重新安装后使用完整新内容，不出现半安装状态。
- 仓库离线时已安装配置仍可运行。
- 下载损坏、校验失败和解压攻击不会改变旧安装。
- 模拟期间不能安装或卸载，配置变更期间不能启动模拟。
- 卸载后配置从仓库状态和模拟选择中消失。
- 第一阶段遗留 manifest 不进入模拟列表，但可以从仓库页面清理。

## 19. 完成标准

满足以下条件即完成第二阶段：

- 共享 TypeScript 包已发布并由两个仓库使用。
- Python/TypeScript 静态校验一致性检查通过。
- 独立配置仓库能够确定性生成并提交 `dist/`。
- 固定 GitHub Raw index 可以被 Electron 拉取和校验。
- 安装、同 ID 重新安装、提交前旧目录恢复、提交后残留清理、启动恢复和卸载行为通过测试。
- main 保持 URL、路径、ZIP 和任务生命周期信任边界。
- `metrics` 阻止已知无效的成本统计选择。
- 配置仓库离线不影响已安装配置运行。
- 开发预置和自动初始化已移除。
- 第一阶段模拟、取消、结果保存和可视化没有回归。
- 主仓库与配置仓库的自动化检查和人工验收通过。
