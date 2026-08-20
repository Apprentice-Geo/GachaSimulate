# IR v2

IR 是 `@gachasimulate/config-compiler` 生成、C++ Runtime 消费的 JSON 进程契约。Electron 为单次模拟把 IR 写入临时 `program.json`，core 加载后执行，任务结束时删除临时目录。

IR 不是用户配置、持久化结果或公共交换格式。Compiler 和 Runtime 必须版本配套；C++ loader 只接受 `ir_version: 2`，但项目不承诺保存旧 IR 或由新版 Runtime 重放。用户语法和模拟执行顺序分别见 [YAML 配置语法](YAML_CONFIG_SYNTAX.md)。

## 权威与信任边界

Config Compiler 定义 IR 的结构以及 YAML 到 IR 的表示规则，并负责将合法 YAML 规范化为 IR。C++ loader 将文件内容视为不可信输入，重新检查 JSON 形状、数值范围、引用、arena 区间和运行安全边界；这些检查用于保护 Runtime，不构成另一套 IR 定义。IR 如何表示已编译程序由 Compiler 决定，执行该程序时的模拟行为由 C++ Runtime 决定。

若 Compiler 输出与 C++ loader 冲突，应修正两端及契约测试，不能把某一端的偶然行为当作兼容格式。

## 顶层结构

IR v2 根对象只允许以下字段：

| 字段 | 含义 |
| --- | --- |
| `ir_version` | 固定为 `2` |
| `result_item` | 本次保存结果的 item index |
| `items` | item 表，元素保存 ID 与展示名称的 string index |
| `strings` | 去重字符串表 |
| `actions` | action arena |
| `pools` | pool 表 |
| `pool_entries` | pool entry arena |
| `rules` | rule 表 |
| `condition_nodes` | condition node arena |
| `condition_children` | logic condition 的 child index arena |
| `item_resolve` | 与 `items` 等长的 resolve 表 |
| `initial` | `actions` 中的初始 action range |
| `every_draw` | `actions` 中的每轮 action range |
| `termination_condition` | termination condition node index |

对象不接受未知字段。IR 文件不得超过 64 MiB；各 arena 最多包含 1,000,000 个元素。

## 索引与 range

IR 使用从 `0` 开始的数组 index 引用 item、pool、condition 和 string。所有引用必须落在目标数组范围内。

连续 arena 片段统一表示为：

```json
{ "begin": 0, "count": 2 }
```

该 range 表示从 `begin` 开始的 `count` 个连续元素，且必须完整落在对应 arena 内。空动作使用 `{ "begin": 0, "count": 0 }`；`begin` 对空 range 没有执行语义，但仍必须合法。

## 表与节点

### Items 与 strings

```json
{
  "strings": ["draw_count", "抽数"],
  "items": [{ "id": 0, "name": 1 }],
  "result_item": 0
}
```

`items` 必须非空；`id` 和 `name` 均引用 `strings`。`result_item` 引用本次模拟选择的 item，Runtime 将其期末库存写入 GSR。

### Actions

`actions` 元素按 `kind` 分为：

| `kind` | 其他字段 | 含义 |
| --- | --- | --- |
| `add_item` | `item`, `amount` | 增加 item；`amount` 为正 safe integer |
| `reduce_item` | `item`, `amount` | 减少 item；`amount` 为正 safe integer |
| `set_item` | `item`, `amount` | 设置 item；`amount` 为非负 safe integer |
| `draw` | `pool` | 从 pool 抽取并执行 entry actions |
| `change` | `pool` | 切换当前主 pool |
| `terminate` | `reason` | 终止 run；`reason` 引用 `strings` |

### Pools 与 entries

`pools` 元素为 `{ "id": StringIndex, "entries": Range }`，其中 `entries` 是 `pool_entries` 的非空 range。`pool_entries` 元素为：

```json
{ "threshold": 0.5, "actions": { "begin": 0, "count": 1 } }
```

同一 pool 的 `threshold` 是严格递增、有限且不大于 `1` 的累计概率，最后一个值必须为 `1`。

### Conditions

check node：

```json
{
  "kind": "check",
  "item": 0,
  "op": ">=",
  "value": 1,
  "actions": { "begin": 0, "count": 1 }
}
```

`op` 只能是 `==`、`!=`、`<`、`<=`、`>`、`>=`；Compiler 生成的 `value` 为非负 safe integer。

logic node：

```json
{
  "kind": "logic",
  "op": "AND",
  "children": { "begin": 0, "count": 2 },
  "actions": { "begin": 0, "count": 0 }
}
```

`op` 只能是规范化后的 `AND` 或 `OR`；`children` 是 `condition_children` 的非空 range，其中每个值都是 condition node index。条件引用必须无环，最大深度为 256。

### Rules

rule 元素为 `{ "id": StringIndex, "mode": Mode, "condition": ConditionIndex }`。`mode` 只能是 `once`、`per_draw` 或 `repeat`。

### Item resolve

`item_resolve` 与 `items` 一一对应，每个元素为：

```json
{
  "retain": 0,
  "reduce_per_batch": 0,
  "actions": { "begin": 0, "count": 0 }
}
```

`retain` 和 `reduce_per_batch` 是非负 safe integer。未配置 resolve 时 `actions` 为空且 `reduce_per_batch` 为 `0`；已配置时 actions 必须恰好包含一个减少当前 item 的 action，且减少量等于 `reduce_per_batch`。

## 修改检查

修改 IR 时同步检查：

- Config Compiler 的生成结构与 Compiler tests；
- C++ `load_ir_file` 的防御性校验及 C++ tests；
- `native_pipeline` 和固定 IR fixture；
- 受影响的 YAML 语义与执行顺序；
- 是否需要递增 `ir_version`。IR 不提供跨版本迁移路径。
