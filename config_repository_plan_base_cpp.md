# 配置仓库开发计划

## 1. 状态、目标与范围

本计划用于建立独立配置仓库 `GachaSimulate-Configs`，并让 Electron 客户端安全地消费其中的配置。配置仓库负责：

- 维护 YAML 配置源码；
- 使用主仓库指定 commit 的 `config-compiler` 校验全部配置；
- 在 PR 和 `main` CI 中执行完整构建检查；
- 生成客户端可消费的 `dist/`。

配置仓库不运行模拟，也不生成 IR。Config Compiler 仍是 YAML 校验的唯一权威，C++ 不解析 YAML；实际模拟继续使用现有带 `result_item` 的编译入口。

### 1.1 MVP

MVP 包含：

- 一个内置且不可由用户修改的官方 HTTPS 配置源；
- 官方源配置的下载、安装、更新判断和卸载；
- 直接加载并持久化用户选择的本地配置目录，用于开发和测试；
- 以「来源 + 配置 ID」区分本地配置和已安装配置。

### 1.2 后续版本

后续版本再提供：

- 用户可设置并恢复默认值的兼容 HTTPS 配置源；
- 配置源切换语义；
- 独立的 `GachaSimulate-Configs-Template` 模板仓库。

模板仓库包含完整目录、构建脚本、示例配置和 CI，并与官方配置仓库遵循相同的构建契约。维护者可将其 `dist/` 托管于 GitHub Raw、Pages、自建服务器或其他静态文件服务，无需由主项目接纳和审核全部第三方配置。

### 1.3 明确不包含

MVP 不包含：

- 第三方配置源、多源聚合或用户修改源地址的入口；
- 模板仓库；
- 多个源之间的来源关系或冲突处理；
- 安装 backup 或旧配置恢复机制。

## 2. 配置仓库契约

### 2.1 仓库结构

```text
GachaSimulate-Configs/
├─ configs/
│  └─ <id>/
│     ├─ manifest.yaml
│     ├─ config.yaml
│     └─ termination*.yaml
├─ dist/
│  ├─ index.json
│  └─ packages/
│     └─ <id>.zip
├─ scripts/
│  ├─ prepare_compiler.ts
│  └─ build_repository.ts
├─ .github/workflows/ci.yml
├─ GACHASIMULATE_COMMIT
├─ package.json
├─ pnpm-lock.yaml
├─ .gitattributes
├─ .gitignore
├─ README.md
└─ LICENSE
```

### 2.2 Compiler commit 固定与批量校验 API

配置仓库不依赖发布到 npm 的 Compiler 包。`GACHASIMULATE_COMMIT` 固定主仓库 commit：

```text
<commit sha>
```

`prepare_compiler.ts` 负责准备依赖：

```text
读取 commit
→ checkout GachaSimulate 到 .deps/
→ 安装依赖
→ build packages/config-compiler
→ build packages/config-repository-contract
```

`.deps/` 不进入 Git。

主仓库为 `config-compiler` 增加批量配置校验 API。该 API 接受一个 `config.yaml` 和多个 termination 文件，只校验一次 `config.yaml`，再逐个校验 termination，并返回校验失败的文件名列表；首版不要求返回具体错误信息，也不要求 `result_item`。

Compiler 负责 YAML 语法、定义对象未知字段和配置语义校验，并通过现有 manifest 读取入口校验 manifest 语法。批量 API 不负责仓库级 manifest 限制、目录名和目录文件集合校验。

### 2.3 共享协议校验包

主仓库新增 `@gachasimulate/config-repository-contract`，统一配置仓库构建端和 Electron 消费端都需要的纯协议校验：

- index 的必填字段、类型、大小、未知字段、SHA-256 和相对路径；
- 仓库级 manifest 字段长度和文件名限制；
- 配置包文件集合、数量、重复路径和 `manifest.id` 一致性；
- 协议使用的 TypeScript 类型和数值上限常量。

该包复用 `config-compiler` 的 manifest 读取入口，不重复解析 YAML。配置仓库通过 `GACHASIMULATE_COMMIT` 使用该包，Electron 直接使用主仓库 workspace 包；双方不得各自实现另一套协议校验。

该包不执行网络请求、ZIP 压缩或解压、文件系统扫描、staging 提交和 Electron IPC。这些操作及其宿主安全边界仍由配置仓库脚本或 Electron main 负责。

### 2.4 源码与 manifest 约束

每个 `configs/<id>/` 必须满足：

- `<id>` 等于 `manifest.id`；
- `<id>` 只允许小写 ASCII，格式为 `^[a-z0-9][a-z0-9_-]{0,63}$`；
- `<id>` 不得是 Windows 保留设备名；
- `manifest.yaml`、`config.yaml` 和每个 termination YAML 的 UTF-8 编码大小均不超过 1 MiB；
- 只包含 `manifest.yaml`、`config.yaml` 和 manifest 声明的 termination 文件；
- 不包含嵌套目录或额外资源。

manifest 沿用现有字段：

```text
id
name
description
terminations
metadata?
```

字段限制均按 UTF-8 编码字节数计算：

- `id` 最多 64 字节；
- `name` 最多 256 字节；
- `description` 最多 8 KiB；
- `terminations` 最多 62 项；
- termination 的 `file` 最多 255 字节，且必须是安全的单级 `.yaml` 文件名；
- termination 的 `file` 格式为 `^[a-z0-9][a-z0-9_-]*\.yaml$`；
- termination 的 `name` 最多 128 字节。

Windows 保留设备名按不区分大小写的文件名 stem 判断，包括 `con`、`prn`、`aux`、`nul`、`com1` 至 `com9` 和 `lpt1` 至 `lpt9`。该规则同时用于配置 ID 和 termination 文件名；客户端和仓库脚本直接拒绝非法名称，不自动转换大小写。

`config.yaml`、termination YAML 和 manifest 的定义对象均拒绝未知字段。`metadata` 是 manifest 明确声明的开放值，其内部字段不作为本协议字段解释。

共享协议校验包调用 Compiler 现有的 manifest 读取校验，并额外校验字段长度、目录名和文件集合。配置格式升级时全仓迁移，不维护旧格式仓库。

### 2.5 确定性构建

`build_repository.ts` 是纯本地构建，不联网，也不 checkout 主仓库：

```text
扫描 configs/*
→ 共享协议校验包校验目录、manifest 和文件集合
→ Compiler 批量校验 config.yaml 与全部 termination
→ 生成确定性 ZIP
→ 计算 SHA-256
→ 按 id 排序
→ 生成 dist/index.json
```

ZIP 固定文件顺序、时间戳、权限和压缩参数，使相同源码与工具版本产生完全相同的产物。每个 ZIP 必须且只能包含 `manifest.yaml`、`config.yaml` 和 manifest 声明的 termination 文件。

以下任一条件都会导致构建失败：

- 单个 ZIP 超过 8 MiB；
- 单个 ZIP 超过 64 个文件条目；
- 任一 ZIP 文件条目的解压输出超过 1 MiB；
- `dist/index.json` 的 UTF-8 编码大小超过 1 MiB；
- `configs` 超过 1024 项。

协议不设置 ZIP 总解压大小上限。

### 2.6 Index 协议

`dist/index.json` 的格式为：

```json
{
  "format_version": 1,
  "configs": [
    {
      "id": "example",
      "name": "Example",
      "description": "...",
      "download_url": "packages/example.zip",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

规则如下：

- 根对象必须且只能包含整数 `format_version` 和数组 `configs`；
- `format_version` 是配置仓库协议版本，客户端只接受已支持的版本；
- 每个配置项必须且只能包含字符串 `id`、`name`、`description`、`download_url` 和 `sha256`；
- 展示字段全部来自 manifest；
- 每个条目的 `id` 同时等于配置目录名和 `manifest.id`，且不可重复；
- `id`、`name` 和 `description` 遵循 manifest 的格式及 UTF-8 字节长度限制；
- `download_url` 只能是相对于 index 的路径，不允许绝对 URL、根路径或包含 `..` 的路径；
- `sha256` 必须是 64 位小写十六进制字符串；
- `index.json` 的 UTF-8 编码大小不超过 1 MiB；
- `configs` 最多包含 1024 项；
- index 根对象和配置项均拒绝未知字段；
- `configs` 按 ID 字典序排列；
- SHA-256 用于下载完整性与更新判断；
- index 不记录 size、构建时间或 Compiler commit；Compiler commit 只由 `GACHASIMULATE_COMMIT` 指定。

### 2.7 CI

PR 与 `main` 使用相同门禁：

```text
checkout 配置仓库
→ checkout GachaSimulate@GACHASIMULATE_COMMIT
→ 安装并编译 config-compiler 与 config-repository-contract
→ format / lint / typecheck / test
→ build_repository
→ git diff --exit-code -- dist/
```

触发条件为：

```yaml
pull_request:
push:
  branches: [main]
```

`dist/` 必须随源码提交，CI 不自动修改或提交产物。

## 3. 客户端消费契约

### 3.1 官方源 index

MVP 只使用一个内置的官方 HTTPS 配置源，默认值指向官方配置仓库的：

```text
dist/index.json
```

真实 URL 待第 18 项确认。客户端只依赖以下标准协议：

```text
index.json
→ 相对 download_url
→ ZIP
```

客户端解析 index 后，将相对 `download_url` 解析为下载地址，并拒绝绝对 URL、根路径或包含 `..` 的路径。

### 3.2 下载与安全校验

下载请求与响应必须满足：

- index 响应正文以流式读取的实际字节数限制为 1 MiB，超限后立即取消响应；
- ZIP 下载响应正文以流式读取的实际字节数限制为 8 MiB，超限后立即取消响应；
- 客户端不读取或依赖 `Content-Length`；
- HTTPS 最大重定向次数为 5 次；
- 响应正文连续 30 秒没有收到数据则超时；
- ZIP 最多包含 64 个文件条目，不允许目录条目；
- 每个 ZIP 文件条目的实际解压输出最多 1 MiB；
- 解压前拒绝路径穿越、绝对路径、`..`、符号链接、特殊文件、重复路径和大小写折叠后重复的路径。

安装前必须校验 SHA-256、安全解压 ZIP、通过 Compiler 完整校验，并确认 ZIP 内 `manifest.id` 与 index 条目的 `id` 一致。下载大小、ZIP 路径或特殊文件、单条目解压大小、SHA-256、Compiler 校验中的任一检查失败，都不得改变旧安装。

### 3.3 Staging 安装生命周期

远端安装流程为：

```text
读取官方源 index
→ 下载 ZIP 到临时目录
→ 校验 SHA-256
→ 在 <userData>/configs/.staging/<task-id>/ 安全解压
→ Compiler 完整校验
→ 在 staging 中写入 .gachasimulate.json
→ 删除 installed/<id>
→ 将 staging/<id> 重命名为 installed/<id>
```

staging 必须与 `installed/` 位于同一用户数据卷。只有新配置完成全部校验后才进入提交阶段；提交时先删除 `installed/<id>`，再将已验证的 staging 目录重命名为正式目录。

MVP 不保留 backup，也不恢复旧配置。若进程在删除和重命名之间中断，该配置可能暂时不存在，客户端将其视为未安装，用户可重新下载。应用启动时清理残留 staging 目录；安装提交失败不得留下半安装的新目录。

### 3.4 已安装状态与更新判断

客户端将已安装配置保存在：

```text
<userData>/configs/installed/<id>/
```

安装时额外生成客户端私有文件 `.gachasimulate.json`，首版只记录：

```json
{
  "sha256": "..."
}
```

当 `index.sha256 != local.sha256` 时，客户端认为存在更新。远端删除配置后，本地版本仍可运行和卸载，但无法从当前源重新安装；官方源离线时，已安装配置仍可运行。

### 3.5 本地配置目录

用户选择的本地目录直接包含多个配置目录：

```text
<selected-local-dir>/
├─ <id>/
│  ├─ manifest.yaml
│  ├─ config.yaml
│  └─ termination*.yaml
└─ ...
```

使用流程为：

```text
用户选择本地目录
→ 直接读取 YAML
→ Compiler 校验
→ 运行模拟
```

本地配置：

- 不复制到 `installed/`；
- 不生成 `.gachasimulate.json`；
- 不参与 SHA-256 更新判断；
- 每次使用时直接读取当前磁盘内容，修改 YAML 后重新运行即可生效；
- 在 UI 中明确标记为「本地配置」；
- 始终由客户端只读访问。

客户端必须持久化用户选择的目录，应用重启后继续使用，不自动清空或恢复默认。配置列表中的每项至少区分 `local` 和 `installed` 来源；配置选择和模拟请求使用「来源 + 配置 ID」定位，不能只使用裸配置 ID。

本地配置与已安装配置可以使用相同的 `manifest.id`，但必须作为两个可区分的配置项展示和运行。main 根据来源解析实际目录；Renderer 不直接提交本地路径。即使官方源存在相同 ID，远端安装操作也不得覆盖或修改用户选择的本地目录。

本地配置也使用共享协议校验包检查 manifest、配置 ID 和文件名，确保其路径在 Windows 和 Linux 上具有相同语义。

### 3.6 任务互斥与 Electron 信任边界

同一时间只允许一个安装、更新或卸载任务。配置变更期间禁止启动模拟，模拟期间禁止配置变更。Renderer 的按钮状态只负责反馈，main 必须执行最终互斥校验。

MVP 的远端安装由 main 使用内置官方源；Renderer 不提交下载 URL、文件路径或哈希。Renderer 只以来源和配置 ID 发起固定操作，由 main 解析受信任路径并刷新状态；preload 只暴露固定 IPC 能力。

### 3.7 后续版本的源切换语义

后续版本允许用户设置兼容的 HTTPS `index.json` URL，并恢复默认源。当前源是唯一远端权威；切换时：

- 不自动下载；
- 不自动卸载任何配置；
- 已安装配置仍可运行；
- 当前源不存在的已安装配置标记为「当前源已移除」；
- 当前源存在相同 ID 时，以当前源版本为权威；
- 用户执行更新或重新安装后，新源配置覆盖 `installed/<id>`。

首版源切换不记录和处理多个源之间的来源关系或冲突。

模板仓库的使用流程为：

```text
Use this template
→ 添加或修改 configs/*
→ 本地 build
→ 提交 configs + dist
→ CI 验证
→ 获取 dist/index.json URL
→ 在后续版本客户端设置为配置源
```

## 4. 实施、验收与待确认项

### 4.1 实施顺序

1. 为 `config-compiler` 增加独立的批量 validate API。
2. 创建 `config-repository-contract` 共享协议校验包。
3. 创建标准配置仓库、`build_repository.ts`、确定性 ZIP、index 和 CI。
4. Electron 接入内置官方 HTTPS 配置源，实现下载、安装和 SHA-256 更新判断。
5. 实现本地配置目录入口及来源区分。
6. 按第 17 项确认的范围处理现有配置迁移和开发预置清理。
7. 后续创建模板仓库，实现可更改的远端配置源和源切换。

### 4.2 验收门禁

#### Compiler

- fixture 覆盖一个 config 与多个 termination 的批量校验、失败文件名和未知字段；实际模拟编译入口覆盖 `result_item` 边界。
- fixture 覆盖 YAML 1 MiB 的边界值及超限值。

#### 共享协议校验包

- 配置仓库构建端和 Electron 消费端使用同一组 index、manifest 和配置包校验入口及常量。
- fixture 覆盖 index 必填字段和类型、未知字段、SHA-256、ID 一致性及相对路径规则。
- fixture 覆盖 `id` 64 字节、`name` 256 字节、`description` 8 KiB、termination 62 项、`.yaml` 文件名 255 字节和 termination 名称 128 字节的边界值及超限值。
- fixture 拒绝大写 ID、非法 termination 文件名、Windows 保留设备名、重复路径和大小写折叠后重复的路径。

#### 仓库构建

- 相同源码和工具版本重复构建得到相同 ZIP、SHA-256 和 `dist/index.json`；CI 拒绝未提交的 `dist/` 差异。
- 测试覆盖 `index.json` 的 `format_version`，以及 index 1 MiB、配置项 1024 条、ZIP 8 MiB、ZIP 64 个文件条目和单条目解压 1 MiB 的边界值及超限值；ZIP 不设置总解压大小上限。

#### 下载安全

- 下载大小、ZIP 路径、特殊文件、单条目解压大小、Compiler 校验和 SHA-256 失败不会改变旧安装。
- 响应有无 `Content-Length` 或其值是否准确均不影响流式大小限制；超过 5 次重定向和连续 30 秒无响应数据会失败，且不会改变旧安装。

#### 安装生命周期

- 安装提交失败不会留下半安装的新目录。
- 进程中断后允许配置暂时不存在；应用重启会清理残留 staging，用户可重新下载。
- MVP 使用内置官方 HTTPS 源；官方源离线时已安装配置仍可运行。

#### 本地配置

- 本地配置目录选择会跨应用重启持久化。
- 本地配置与已安装配置即使 ID 相同，也能按来源分别选择和运行；远端安装不会覆盖本地目录。

#### Electron 边界

- Renderer 不能传入任意 URL、路径或哈希。
- 安装、卸载与模拟的互斥和状态刷新通过 Electron 行为测试。

### 4.3 待确认项

以下原编号事项只保留占位，不在本计划中自行决定：

17. 现有配置迁移和开发预置清理范围：待后续确认，configs目录可以暂时保留，后续人工完成迁移再移除。
18. 官方配置仓库建立后的真实默认 URL：待官方仓库建立后填写。
