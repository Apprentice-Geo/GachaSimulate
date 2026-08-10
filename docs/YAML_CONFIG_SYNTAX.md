# YAML 配置语法

本文档定义 `config.yaml` 和 `termination*.yaml` 的配置语法。

配置文件使用 YAML mapping/list 结构，运行前由 validator 校验，再由 builder 编译为运行时结构。

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
  "schema_version": 1,
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

根对象仅允许上述字段；展示信息放在同目录 `manifest.yaml`。`config.yaml` 必须声明
`schema_version: 1`；termination 继承该版本且不得重复声明。

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

EveryDrawList = [ "draw_count Padding += Padding PositiveNumber", ... ]

ItemResolveList = [ ItemResolve, ... ]
ItemResolve = {
  "item": ItemId,
  "retain": NonNegativeInteger,
  "actions": ResolveActions
}

RetainedItemList = [ { ItemId: NonNegativeInteger }, ... ]
```

约束：

- 用户 `items` 不得声明 `draw_count`。编译器会在索引 0 注入只读的合成槽位。
- `cost_count` 是可选 item；仅当 `manifest.yaml` 的 `metrics` 包含 `cost` 时必须声明它。成本由配置 actions 按实际规则累计，运行时不会根据抽数或 metadata 推导。
- 同一个 pool 内只能统一使用 `probability` 或统一使用 `weight`。
- 使用 `probability` 时，单个概率必须大于 `0`，同一个 pool 的概率和必须为 `1`。
- 使用 `weight` 时，单个权重必须大于 `0`。
- pool entry 的 `actions` 可省略，省略等价空动作。
- `RuleId` 必须唯一。
- `every_draw` 可省略。每轮会先自动递增 `draw_count`，再执行用户 actions。
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

- 所有 action 引用的 `item` 和 `pool_id` 必须已定义；任何 action 和 `item_resolve` 都不得写入或声明 `draw_count`。
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
3. 每轮先递增合成 `draw_count`，再执行 `every_draw` actions。
4. 从当前主 pool 抽取一次，并执行抽中 entry 的 actions。
5. 按 `rules` 声明顺序执行 rule 阶段。
6. 检查 `termination_rule`；命中后执行收集到的 termination actions。
7. 未终止则进入下一轮。

rule 的 `mode`：

- `once`：命中并执行一次后，从后续 rule 阶段移除。
- `per_draw`：每轮最多执行一次，下一轮仍会重新检查。
- `repeat`：命中执行后，在同一轮立即重新检查同一 rule，直到不满足或模拟终止。配置作者必须确保 actions 会改变条件，否则可能无法结束。

`change pool_id` 会立即改变主 pool。发生在 `every_draw` 中会影响本轮主 pool 抽取；发生在 pool entry 或 rule 中通常影响后续抽取。

## Item Resolve

`item_resolve` 用于描述获得可分解物品后的即时处理：

- `item += n` 或 `item = n` 后，如果该 item 配置了 `item_resolve`，会立即根据库存和 `retain` 执行分解 actions；`item -= n` 不触发。
- `retain` 表示至少保留的库存数量。
- 分解批次数量由当前库存、`retain` 和 `ResolveActions` 中唯一的 `item -= n` 决定。
- `termination*.yaml` 的 `retained_items` 会并入 `item_resolve` 的保留数量；同一 item 实际保留值取两者较大值。
- `ResolveActions` 可以包含 `draw pool_id`，用于把随机礼包、随机皮肤等展开为另一个 pool 的抽取。
- 不建议让分解 actions 重新产生同一个可分解 item；这类循环依赖难以理解，也可能导致模拟无法结束。

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
