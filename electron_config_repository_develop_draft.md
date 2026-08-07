# GachaSimulate Electron MVP 与配置仓库设计草案

## 1. 项目目标

当前阶段只实现**开发环境可运行的 Electron MVP**，不要求生成安装包或在无开发环境的机器上运行。

开发机器默认已经具备：

- Windows 11
- Node.js 与 pnpm
- Python 3.12
- uv
- GachaSimulate 仓库源码

当前阶段不处理：

- Windows 安装包
- 内置 Python 解释器
- 无 Python 环境运行
- ASAR 与资源打包
- 代码签名
- 自动更新
- Electron 应用发布流程
- 最终打包工具选型

实施顺序：

1. 搭建 Electron MVP 壳体
2. 接通 Python 模拟流程
3. 建立独立配置仓库
4. 接入配置仓库的安装与卸载
5. 后续再考虑打包、配置更新和兼容性

------

## 2. 技术栈

当前采用：

```text
Electron
electron-vite
React
TypeScript
Python CLI
uv
```

`electron-vite` 负责：

- Electron main 进程构建与开发启动
- preload 构建
- React renderer 开发服务器与热更新
- 开发环境下统一启动 Electron

当前不引入 `electron-builder` 或 Electron Forge 的打包能力。

------

## 3. Electron 应用结构

使用单个 `BrowserWindow`，应用内包含三个页面：

1. **运行模拟**
2. **配置仓库**
3. **结果可视化**

现有 React 可视化功能作为独立页面复用。

模拟完成后暂不自动打开结果。用户进入结果可视化页面，手动选择 `_visualize.json` 文件。

------

## 4. Electron 安全边界

Renderer 不直接访问 Node.js API。

基本结构：

```text
Renderer
   ↓ window.desktopApi
Preload / contextBridge
   ↓ IPC
Electron Main
   ↓ child_process / fs / net
Python CLI、文件系统、配置仓库
```

所有以下能力必须位于 main 进程：

- 启动和取消 Python 进程
- 读取配置目录
- 下载配置包
- SHA-256 校验
- ZIP 解压
- 安装和卸载配置
- 打开结果目录
- 文件选择对话框

------

## 5. 桌面模拟工作流

用户无需使用命令行即可完成一次模拟：

```text
选择已安装配置
→ 选择终止条件
→ 设置参数
→ 启动模拟
→ 查看阶段与进度
→ 完成或取消
→ 手动选择结果进行可视化
```

支持的模拟参数：

- 固定模拟次数
- 目标累计抽数
- 随机种子
- worker 数
- 统计维度：`draw` 或 `cost`

两种模拟目标互斥。

同一时间只允许运行一个模拟任务。

------

## 6. Python 调用模式

每次模拟启动一个独立 Python 子进程。

开发阶段调用形式：

```text
uv run gachasimulate ...
```

不使用：

- 常驻 Python 服务
- HTTP 服务
- Socket RPC
- Node 原生 Python 绑定

Electron main 进程负责：

- 组装参数
- 启动子进程
- 解析标准输出
- 收集标准错误
- 向 renderer 转发事件
- 取消整个进程树

Windows MVP 可使用：

```text
taskkill /PID <pid> /T /F
```

终止 Python 主进程及其 worker 子进程。

------

## 7. Python JSONL 事件协议

现有 CLI 增加显式机器输出模式，例如：

```text
--output-format jsonl
```

协议约束：

- `stdout`：只输出逐行 JSON 事件
- `stderr`：诊断日志与异常信息
- Electron 不解析普通人类日志
- 每一行必须是一个完整 JSON 对象

建议最小事件：

```json
{"type":"started"}
{"type":"stage","stage":"loading_config"}
{"type":"stage","stage":"simulating"}
{"type":"progress","completed":5000,"total":10000}
{"type":"stage","stage":"saving"}
{"type":"completed","result_path":"...","visualize_path":"...","total_runs":10000,"total_draw":523417}
{"type":"error","message":"..."}
```

模拟被用户取消时，由 Electron 根据进程退出状态转换为 `cancelled` UI 状态，不要求 Python 必须正常完成取消事件。

固定次数和累计抽数两种模式都需要支持进度上报。

------

## 8. 结果文件

当前继续沿用现有输出：

- `.npz` 原始模拟结果
- `_visualize.json` 可视化输入

MVP 提供：

- 打开结果目录
- 选择 JSON 文件进行可视化

相同参数重复运行时暂时允许覆盖旧结果。

暂不实现：

- 结果历史
- 文件名时间戳
- 冲突提示
- 自动打开最新结果
- 多结果对比

------

## 9. 配置管理原则

应用只使用自己管理的配置目录。

模拟页面不允许用户随意选择 YAML 文件或任意配置目录。

已安装配置目录：

```text
configs/
└─ installed/
   └─ <config-id>/
```

首版不支持本地配置导入。

应用不内置任何配置。首次启动时没有配置，用户必须从配置仓库安装至少一个配置后才能运行模拟。

仓库无法访问时：

- 应用仍可启动
- 已安装配置仍可运行
- 无已安装配置时不能开始模拟

------

## 10. 独立配置仓库

模拟器代码仓库与配置仓库完全分离。

示例：

```text
Apprentice-Geo/GachaSimulate
Apprentice-Geo/GachaSimulate-Configs
```

职责：

| 仓库                  | 职责                                  |
| --------------------- | ------------------------------------- |
| GachaSimulate         | 模拟器、Electron、React、配置安装逻辑 |
| GachaSimulate-Configs | 配置源码、构建脚本、ZIP 和远端索引    |

配置仓库为公开 GitHub 仓库。

首版只使用固定官方配置源。普通用户不能修改配置源地址。

开发环境允许通过环境变量覆盖索引 URL，以便本地测试。

------

## 11. 配置仓库结构

```text
GachaSimulate-Configs/
├─ packages/
│  ├─ dream_corridor/
│  │  ├─ manifest.yaml
│  │  ├─ config.yaml
│  │  └─ collect_all.yaml
│  └─ ...
├─ dist/
│  ├─ index.json
│  └─ packages/
│     ├─ dream_corridor.zip
│     └─ ...
└─ scripts/
   └─ build_repository.py
```

`packages/` 保存配置源码。

`dist/` 保存客户端直接下载的发布产物。

首版可以直接将 `dist/` 提交到 `main` 分支。

------

## 12. 配置清单

每个配置目录包含 `manifest.yaml`。

最小结构：

```yaml
id: dream_corridor
name: 梦之回廊
description: 模拟集齐全部碎片所需抽数

metrics:
  - draw
  - cost

terminations:
  - file: collect_all.yaml
    name: 集齐全部碎片
```

字段职责：

- `id`：配置稳定标识，也是本地安装目录名
- `name`：桌面端展示名称
- `description`：仓库说明
- `metrics`：配置支持的统计维度；必须声明 `draw`，支持成本统计时再声明 `cost`
- `terminations`：可选终止条件及其展示名称

Python 模拟核心仍然读取 `config.yaml` 和对应终止条件 YAML。
配置仓库在发布和安装阶段校验 `metrics` 声明与配置内容一致；模拟器按声明展示可用能力，main 仍校验实际配置。

------

## 13. 配置索引

`dist/index.json` 不手工维护，由构建脚本生成。

示例：

```json
{
  "configs": [
    {
      "id": "dream_corridor",
      "name": "梦之回廊",
      "description": "模拟集齐全部碎片所需抽数",
      "download_url": "packages/dream_corridor.zip",
      "sha256": "..."
    }
  ]
}
```

构建脚本负责：

1. 扫描 `packages/*/manifest.yaml`
2. 校验基础目录结构
3. 将每个配置目录打包为独立 ZIP
4. 计算 ZIP 的 SHA-256
5. 生成 `dist/index.json`

索引中的展示字段从 `manifest.yaml` 生成，避免维护两份元数据。

------

## 14. 配置 ZIP 结构

每个配置以独立 ZIP 分发。

ZIP 根目录直接包含：

```text
manifest.yaml
config.yaml
一个或多个终止条件 YAML
其他配置资源
```

ZIP 内不再嵌套 `<config-id>/` 顶层目录。

------

## 15. 配置仓库首版能力

首版支持：

- 拉取远端索引
- 展示配置名称和描述
- 判断配置是否已安装
- 安装单个配置
- 卸载已安装配置
- 安装后立即出现在模拟配置列表中

首版不支持：

- 配置更新
- 版本号比较
- 多配置源
- 搜索、分类和排序
- 本地配置导入
- 配置作者、截图和标签
- 模拟器版本兼容判断

同一 `id` 已安装时禁止重复安装。

------

## 16. 配置安装流程

```text
请求 index.json
→ 用户选择配置
→ 下载 ZIP 到临时目录
→ 计算并校验 SHA-256
→ 解压至临时安装目录
→ 校验 manifest.yaml
→ 校验 manifest.id 与 index.id 一致
→ 校验 config.yaml 存在
→ 校验 termination 文件存在
→ 移动至 configs/installed/<id>/
→ 刷新已安装配置列表
```

任何步骤失败时：

- 不修改已有安装目录
- 删除临时文件
- 向用户显示错误
- 允许重新尝试

首版下载文件较小，可以只显示“下载中”，暂不要求精确下载百分比。

------

## 17. 配置卸载流程

```text
用户点击卸载
→ 显示确认对话框
→ 删除 configs/installed/<id>/
→ 刷新仓库和模拟页面
```

不处理配置正在运行的情况，因为应用同一时间只运行一个模拟；运行期间应禁用配置安装和卸载操作。

------

## 18. Electron MVP 完成标准

满足以下条件即视为当前阶段完成：

- `pnpm dev` 可以启动 Electron
- 单窗口内可以切换三个页面
- 能拉取官方配置索引
- 能安装和卸载单个配置
- 能扫描已安装配置及终止条件
- 能在桌面端填写模拟参数
- 能调用本地 `uv run gachasimulate`
- 能显示模拟阶段和进度
- 能取消 Python 及 worker 进程树
- 能显示成功、失败和取消状态
- 能打开结果目录
- 能选择 `_visualize.json` 并使用现有页面展示
- 整个用户操作流程不需要手动执行命令行

------

# 待确认事项

## A. 实现前需要确定

### A1. Electron 源码目录布局

需要在本地实现阶段确定 main、preload、renderer 的最终目录，例如：

```text
src/
├─ electron/
│  ├─ main/
│  └─ preload/
└─ visualize/
```

或迁移为 electron-vite 的标准目录。

### A2. React 页面组织

需要决定：

- 是否引入 React Router
- 或使用简单页面状态切换
- 导航使用侧边栏还是顶部标签

不影响核心架构。

### A3. 用户数据目录

需要决定开发阶段是否直接使用：

```text
app.getPath("userData")
```

以及配置和结果的具体子目录名称。

### A4. Python JSONL 精确协议

需要明确：

- 各事件字段
- 进度更新频率
- 错误事件是否包含错误码
- stdout 出现非法 JSON 时的处理方式
- Python 非零退出码与 `error` 事件的优先级

### A5. Python 核心进度接口

需要设计统一的进度回调或事件发送接口，使以下模式都能上报进度：

- 固定次数串行
- 固定次数多进程
- 累计抽数串行
- 累计抽数多进程

### A6. 配置仓库正式名称和地址

需要创建仓库并确定：

- 正式仓库名
- 默认分支
- `index.json` 的最终固定 URL
- ZIP 下载 URL 的相对路径解析规则

### A7. ZIP 解压依赖

需要选择 Node.js ZIP 库，并确认：

- 防止 Zip Slip 路径穿越
- 是否支持覆盖控制
- 临时目录清理方式

### A8. 仓库网络实现

需要确定：

- 使用 Electron `net`
- 或主进程中的 Node.js `fetch`
- 请求超时
- GitHub Raw 缓存处理
- 离线错误提示

------

## B. 可在实现过程中采用默认值

- 仓库加载失败时提供“重新加载”
- 卸载前进行一次确认
- SHA-256 不匹配则安装失败
- 下载期间禁止重复点击安装
- 运行模拟期间禁止卸载当前配置
- 非法或损坏的本地配置不显示在运行列表中，并记录诊断信息
- 仓库列表按索引顺序展示
- 暂不持久化模拟表单参数

------

## C. 明确后置

- Electron 安装包
- electron-builder 或 Forge 选型
- 内置 Python
- 干净机器运行验证
- 配置更新与版本管理
- 配置格式版本
- 模拟器兼容范围
- 配置回滚
- 多配置源
- 本地配置导入
- 仓库搜索、分类和截图
- 配置仓库自动发布 CI
- GitHub Pages、Release 或 CDN
- 结果历史
- 结果文件冲突处理
- 多任务并行
- 完整实时日志页面
- 模拟结束自动打开结果
- Electron 应用自动更新
