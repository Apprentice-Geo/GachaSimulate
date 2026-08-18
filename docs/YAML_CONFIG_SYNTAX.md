# YAML 配置语法

本文档定义 `config.yaml` 和 `termination*.yaml` 的配置语法。

配置文件使用 YAML mapping/list 结构，由 `@gachasimulate/config-compiler` 校验并编译为 JSON IR；C++ Runtime 只执行 IR，不解析 YAML。

## 词法约定

```ebnf
Identifier = ("A".."Z" | "a".."z" | "_"), { "A".."Z" | "a".."z" | "0".."9" | "_" }
ItemId = Identifier
PoolId = Identifier
RuleId = Identifier
RuleName = RuleId
ItemName = NonEmptyString
Reason = NonEmptyString

NonNegativeInteger = "0" | PositiveInteger
PositiveInteger = "1".."9", { "0".."9" }
Number = YAML integer or float, excluding bool
PositiveNumber = Number where value > 0
```

约束：

- `ItemId`、`PoolId`、`RuleId` 必须使用 ASCII 字母、数字、下划线，且不能以数字开头。
- ID 不允许中文、空白、连字符、点号或其他符号。
- `ItemName` 用于展示，允许中文和空格，但必须是非空字符串。
- `Reason` 是 `terminate` 的原因文本，允许包含空格和中文，但必须非空。
- YAML 的 `true`/`false` 不属于 number/integer。
- action、condition、reason 是 YAML 字符串；包含 `: `、`#`、前后空格等 YAML 特殊内容时应加引号。

## 文件结构

`config.yaml` 根对象：

```ebnf
Config = {
  "schema_version": 2,
  "items": ItemList,
  "pools": PoolList,
  "initial"?: Actions,
  "every_draw"?: EveryDrawList,
  "rules"?: RuleList,
  "item_resolve"?: ItemResolveList,
}
```

`termination*.yaml` 根对象：

```ebnf
TerminationConfig = {
  "retained_items": RetainedItemList,
  "termination_rule": {
    "condition": ConditionNode
  },
}
```

根对象仅允许上述字段；展示信息放在同目录、且编译时必填的 `manifest.yaml`。
`config.yaml` 必须声明 `schema_version: 2`；termination 继承该版本且不得重复声明。

`manifest.yaml` 根对象：

```ebnf
Manifest = {
  "id": ManifestId,
  "name": NonEmptyString,
  "description": String,
  "terminations": [ ManifestTermination, ... ],
  "metadata"?: AnyYamlValue,
}
ManifestId = ASCII letter, digit, "_" or "-", one or more
ManifestTermination = {
  "file": FileName,
  "name": NonEmptyString,
}
FileName = NonEmptyString without "/" or "\\"
```

`id`、`name`、`description` 和非空 `terminations` 列表均为必填；`id` 只允许
ASCII 字母、数字、下划线和连字符。termination 的 `file` 只能是当前配置目录下的
非空文件名，不能包含路径分隔符；`name` 必须是非空字符串。`metadata` 可省略，
Compiler 不约束其内部结构。根对象和 termination 条目不允许其他字段。

manifest 不声明结果 item。
`compile_yaml(config, termination, manifest, result_item)` 的 `manifest` 和 `result_item`
参数必填；`result_item` 由每次模拟请求提供，必须引用已声明 item。若该 item 没有展示名，
Analysis/GSR 使用 item ID 作为名称。

配置仓库可调用 `validate_config_files(config, terminations)` 批量校验源码。该入口不接收
manifest 或 `result_item`：先完整校验一次 `config.yaml`，失败时返回
`["config.yaml"]`；成功后使用独立工作状态按输入顺序校验每个 termination，并返回失败
文件名。空 termination 列表仍会校验 config。

仓库分发所需的 manifest 字节长度、命名和文件集合限制由
`@gachasimulate/config-repository-contract` 在上述 Compiler 语法校验之上施加，不属于模拟
YAML 语义。

## 基础结构

```ebnf
ItemList = [ Item, ... ]
Item = ItemId | { ItemId: ItemName }

PoolList = [ { PoolId: PoolEntryList }, ... ]
PoolEntryList = [ PoolEntry, ... ]
PoolEntry = (
  { "probability": PositiveNumber, "actions"?: Actions }
  | { "weight": PositiveNumber, "actions"?: Actions }
)

RuleList = [ Rule, ... ]
Rule = { RuleId: RuleBody }
RuleBody = {
  "mode"?: ("once" | "per_draw" | "repeat"),
  "condition": ConditionNode
}

EveryDrawList = [ Action, ... ]

ItemResolveList = [ ItemResolve, ... ]
ItemResolve = {
  "item": ItemId,
  "retain": NonNegativeInteger,
  "actions": ResolveActions
}

RetainedItemList = [ { ItemId: NonNegativeInteger }, ... ]
```

约束：

- 所有 item 都是普通可写 item；`draw_count`、`cost_count` 没有特殊语义。
- 需要统计抽数时，配置必须声明普通 item `draw_count`，并在 `every_draw` 首项使用
  `draw_count += 1`；其他统计 item 也必须由配置 actions 明确维护。
- 每次模拟请求的 `result_item` 唯一决定 GSR 和 Analysis 保存、汇总的期末 item；Compiler 将其解析为 IR item 索引。
- 所选 result item 的每轮期末库存必须可编码为非负 `u64`；负值或所有 run 汇总溢出时模拟失败。
- 同一个 pool 内只能统一使用 `probability` 或统一使用 `weight`。
- 使用 `probability` 时，单个概率必须大于 `0`，同一个 pool 的概率和必须为 `1`。
- 使用 `weight` 时，单个权重必须大于 `0`。
- 使用 `weight` 时，同一个 pool 的权重总和也必须是有限数。
- pool entry 的 `actions` 可省略，省略等价空动作。
- `RuleId` 必须唯一。
- `every_draw` 可省略。若配置需要抽数，应将 `draw_count += 1` 放在 actions 首项；随后按声明顺序执行其余 actions。
- `ItemResolve.actions` 必须出现，且必须是非空 action 或非空 action 列表；不能省略、不能为 `null`、不能为空列表。
- `ItemResolve.actions` 必须包含且仅包含一个 `item -= n` 动作，且该动作必须减少当前 `ItemResolve.item`；不能包含减少其他 item 的 `-=` 动作。
- `mode` 省略时等价 `once`。
- 已定义结构内部不能包含本节未列出的字段。

## Actions

```ebnf
Space = " "
Padding = { " " | "\t" }

Actions = null | Action | [ Action, ... ]
ResolveActions = Action | [ Action, ... ]

Action =
  ItemId Padding ("+=" | "-=" | "=") Padding NonNegativeInteger
  | "draw" Space+ PoolId
  | "change" Space+ PoolId
  | "terminate" Space+ Reason
```

语义：

- `item += n`：增加 item 库存和累计获得，`n` 必须大于 0。
- `item -= n`：减少 item 库存并累计消耗，`n` 必须大于 0。
- `item = n`：设置 item 库存，`n` 可为 0。
- `draw pool_id`：从指定 pool 抽取一次并执行抽中条目的 actions。
- `change pool_id`：切换主 pool。
- `terminate reason`：结束本次模拟，并记录终止原因。
- `ResolveActions` 是 `item_resolve.actions` 使用的更严格动作列表：非空，且必须有且仅有一个减少被分解 item 的 `-=` 动作。

约束：

- 所有 action 引用的 `item` 和 `pool_id` 必须已定义；任何 action 都可写入已声明的普通 item。
- `Actions` 可为 `null`、单个 action 字符串、或 action 字符串列表；普通 actions 的空列表等价空动作。
- `ResolveActions` 不能为 `null` 或空列表。
- `terminate` 后续 action 不再执行。

## Condition Tree

条件树是 rule 和 termination_rule 的唯一条件语法。节点分为叶子节点和逻辑节点：

```ebnf
ConditionNode = CheckNode | LogicNode

CheckNode = {
  "check": CheckExpression,
  "actions"?: Actions
}

LogicNode = {
  "op": ("AND" | "OR" | "&&" | "||"),
  "children": [ ConditionNode, ... ],
  "actions"?: Actions
}

CheckExpression =
  ItemId Padding ("==" | "!=" | "<" | "<=" | ">" | ">=") Padding NonNegativeInteger
```

约束：

- 一个节点必须且只能是 `check` 节点或 `op + children` 节点。
- `LogicNode.children` 必须非空。
- `actions` 可省略，省略等价空动作。
- `CheckExpression` 左侧 item 必须已定义，右侧只支持非负整数，不支持负数、小数或 item-to-item 比较。
- 普通 rule 的 condition tree 至少应包含一个非空 action。
- termination_rule 的每条可命中路径都必须包含 `terminate ...` action。

执行语义：

- 条件求值阶段只判断条件并收集 actions，不修改状态。
- `OR` 按 `children` 声明顺序短路，只使用第一个满足的 child。
- `AND` 要求所有 children 都满足，按声明顺序聚合 child actions。
- 命中逻辑节点时，当前节点 actions 排在 child actions 之前执行。

## 执行顺序

单次模拟按以下顺序执行：

1. 创建空状态，主 pool 初始为 `pools` 列表中的第一个 pool。
2. 执行 `initial` actions。
3. 每轮按声明顺序执行 `every_draw` actions；需要抽数时由首项 `draw_count += 1` 维护普通 item。
4. 从当前主 pool 抽取一次，并执行抽中 entry 的 actions。
5. 按 `rules` 声明顺序执行 rule 阶段。
6. 检查 `termination_rule`；命中后执行收集到的 termination actions。
7. 未终止则进入下一轮。

rule 的 `mode`：

- `once`：命中并执行一次后，从后续 rule 阶段移除。
- `per_draw`：每轮最多执行一次，下一轮仍会重新检查。
- `repeat`：命中执行后，在同一轮立即重新检查同一 rule，直到不满足或模拟终止。其
  `condition` 必须是单个 `check`，且 Compiler 必须能按下列规则证明退出：
  - actions 直接包含 `terminate`；或
  - actions 对被检查 item 恰好有一次直接写入，且嵌套 pool 或 item resolver 不会写入该
    item；`>=`/`>` 使用正数 `-=`，`<=`/`<` 使用正数 `+=`，`==` 使用正数
    `+=`/`-=`，`!=` 使用 `=` 赋为比较值；或
  - 使用一次 `=` 将被检查 item 赋为明确不满足当前比较的非负常量。

逻辑条件树、错误方向、多个直接写入以及经 pool 或 item resolver 间接写回被检查 item 的
`repeat` 均为编译错误。

`change pool_id` 会立即改变主 pool。发生在 `every_draw` 中会影响本轮主 pool 抽取；发生在 pool entry 或 rule 中通常影响后续抽取。

## Item Resolve

`item_resolve` 用于描述获得可分解物品后的即时处理：

- `item += n` 或 `item = n` 后，如果该 item 配置了 `item_resolve`，会立即根据库存和 `retain` 执行分解 actions；`item -= n` 不触发。
- `retain` 表示至少保留的库存数量。
- `retain`、`retained_items` 数量和分解动作中的减少量必须是不超过 TypeScript safe integer 上限的非负整数；IR Runtime 使用 `i64` 保存这些值。
- 分解批次数量由当前库存、`retain` 和 `ResolveActions` 中唯一的 `item -= n` 决定。
- `termination*.yaml` 的 `retained_items` 会并入 `item_resolve` 的保留数量；同一 item 实际保留值取两者较大值。
- `ResolveActions` 可以包含 `draw pool_id`，用于把随机礼包、随机皮肤等展开为另一个 pool 的抽取。
- pool 和 item resolver 构成的同步调用图必须无环。pool entry 中的 `draw`、对带 resolver
  item 的 `+=`/`=`，以及 resolver actions 中的同类调用都会形成调用边；Compiler 合并同一
  pool 所有 entry 的边，并忽略直接 `terminate` 后的不可达 actions。自环、pool 间环、
  resolver 间环及混合环均为编译错误，不分析随机出口或状态变化是否可能令其退出。

## 终止安全边界

Compiler 会验证同步调用图无环、`repeat` 可证明退出，并继续要求 termination condition 的
每条可命中路径包含 `terminate`。这只保证命中某条 termination 路径后的局部执行能够结束；
Compiler 不证明 termination condition 在任意随机过程下最终必然命中。

Runtime 为每个 run 独立限制最多 `1,000,000` 个 steps 和 `1,024` 层同步 action frames。
每次 action dispatch 和每个 condition node 求值各消耗一个 step，预算不会在单次抽取之间
重置。超过限制分别报错 `runtime step limit exceeded` 或
`runtime frame depth limit exceeded`。任一 run 超限会令整次模拟失败；不会截断 run、保存
部分统计结果或写出部分 GSR。

## 示例

单条件 rule：

```yaml
rules:
- have_target:
    mode: once
    condition:
      check: target_item >= 1
      actions: change next_pool
```

分支 rule：

```yaml
rules:
- badge_gain:
    mode: per_draw
    condition:
      op: OR
      children:
      - check: badge_count == 0
        actions: draw badge_1_pool
      - check: badge_count == 1
        actions: draw badge_2_pool
```

多条件 termination：

```yaml
termination_rule:
  condition:
    op: OR
    children:
    - op: AND
      children:
      - check: target_item_1 >= 1
      - check: target_item_2 >= 1
      actions: terminate all targets obtained
    - check: point >= 1000
      actions: terminate point exchange
```
