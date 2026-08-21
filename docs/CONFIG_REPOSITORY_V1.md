# 配置仓库协议 v1

配置仓库协议定义 repository index、配置 manifest 和下载包的文件集合。`@gachasimulate/config-repository-contract` 是纯协议 validator，不执行网络请求、ZIP 解压或文件系统操作。

模拟 YAML 的结构与语义仍由 Config Compiler 定义，见 [YAML 配置语法](YAML_CONFIG_SYNTAX.md)。仓库协议只在其上增加分发所需的命名、大小、完整性和跨平台安全约束。

## 协议组成

```text
repository index
  -> download_url 指向的 ZIP
    -> manifest.yaml
    -> config.yaml
    -> manifest 声明的 termination YAML
```

## Repository index

index 是 JSON 对象：

```json
{
  "format_version": 1,
  "configs": [
    {
      "id": "example",
      "name": "示例配置",
      "description": "说明",
      "download_url": "packages/example.zip",
      "sha256": "...64 个小写十六进制字符..."
    }
  ]
}
```

根对象和 entry 不接受未知字段。index 的 UTF-8 文本不超过 1 MiB，最多包含 1,024 个 entry。

每个 entry 遵循以下约束：

- `id` 是最多 64 UTF-8 bytes 的安全小写配置 ID，匹配 `[a-z0-9][a-z0-9_-]*`，且不能是 Windows 保留设备名；
- `id` 唯一，`configs` 按 ID 的 ASCII 顺序排列，以产生可复现 diff 并便于 CI 执行确定性检查；
- `name` 是非空字符串，不超过 256 UTF-8 bytes；
- `description` 不超过 8 KiB UTF-8 bytes；
- `download_url` 是不带 query 或 fragment 的安全相对 URL，不能包含绝对路径、其他源、反斜杠、空路径段、`.`、`..`、编码后的路径分隔符或控制字符；该限制保证配置包位于 index 所在源；
- `sha256` 是 64 个小写十六进制字符。

## Repository manifest

`manifest.yaml` 先按 Config Compiler 的 manifest 语法解析，再施加仓库约束：

- `id` 使用与 index entry 相同的安全小写配置 ID；
- `name` 非空且不超过 256 UTF-8 bytes；
- `description` 不超过 8 KiB UTF-8 bytes；
- `terminations` 最多包含 62 项；
- termination `file` 是不超过 255 UTF-8 bytes 的安全小写 `.yaml` 文件名，不包含目录且不能是 Windows 保留设备名；
- termination `file` 唯一；
- termination `name` 非空且不超过 128 UTF-8 bytes。

Compiler 允许的可选 `metadata` 保持原样；仓库协议不解释其内部结构。

## 配置包文件集合

安装端将 ZIP 解压后的平面文件清单交给 `validate_config_package`。协议只允许：

```text
manifest.yaml
config.yaml
<manifest.terminations 中声明的每个 file>
```

所有必需文件都必须存在，且不能包含额外、嵌套、重复或大小写折叠后冲突的文件。安装目录 ID 必须等于 `manifest.id`。

配置包最多包含 64 个文件，每个解压后文件的 `size` 不超过 1 MiB。由于文件数和单文件大小已共同保证传给 validator 的解压后文件内容总量不超过 64 MiB，协议不再设置重复的总大小限制；ZIP 压缩包本身及解压过程的资源限制属于安装流程。

## 职责边界

contract package 只校验传入的文本和文件清单：

- 相对地址解析、HTTP redirect、最终响应来源、网络访问和 SHA-256 比对属于安装流程；contract validator 只约束 index 中的 `download_url` 文本；
- ZIP 条目读取、解压和落盘安全属于安装流程；
- `config.yaml` 与 termination 的模拟语义属于 Config Compiler；
- index、manifest 和文件集合的协议限制属于 config-repository-contract。

## 修改检查

修改本协议时同步检查：

- `packages/config-repository-contract` 的 validator 与 contract tests；
- Config Compiler 共享的 manifest 语法；
- Electron 下载、校验和安装流程及其行为测试；
- index 与配置仓库 CI 的生成和确定性检查；
- `format_version`、兼容策略以及正式配置仓库是否需要同步迁移。
