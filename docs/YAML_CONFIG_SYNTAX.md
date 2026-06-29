# YAML 配置语法

本文档定义 `config.yaml` 和 `termination*.yaml` 的配置语法。配置文件使用 YAML mapping/list 结构，运行前由 validator 校验，再由 builder 编译为运行时结构。

## 文件结构

`config.yaml` 根对象：

```ebnf
Config = {
  "items": ItemList,
  "pools": PoolList,
  "initial"?: Actions,
  "every_draw"?: Actions,
  "rules"?: RuleList,
  "item_resolve"?: ItemResolveList,
  ...metadata
}
```

`termination*.yaml` 根对象：

```ebnf
TerminationConfig = {
  "retained_items": RetainedItemList,
  "termination_rule": {
    "condition": ConditionNode
  }
}
```

未参与模拟的 metadata 字段允许存在，builder 会忽略它们。

## 基础结构

```ebnf
ItemList = [ Item, ... ]
Item = ItemId | { ItemId: ItemName }

PoolList = [ { PoolId: PoolEntryList }, ... ]
PoolEntryList = [ PoolEntry, ... ]
PoolEntry = (
  { "probability": Number, "actions"?: Actions }
  | { "weight": PositiveNumber, "actions"?: Actions }
)

RuleList = [ Rule, ... ]
Rule = {
  "name"?: RuleName,
  "mode"?: ("once" | "per_draw" | "repeat"),
  "condition": ConditionNode
}

ItemResolveList = [ ItemResolve, ... ]
ItemResolve = {
  "item": ItemId,
  "retain": NonNegativeInteger,
  "actions": ResolveActions
}

RetainedItemList = [ { ItemId: NonNegativeInteger }, ... ]
```

约束：

- `items` 必须包含 `draw_count`。
- 同一个 pool 内只能统一使用 `probability` 或统一使用 `weight`。
- 使用 `probability` 时，同一个 pool 的概率和必须为 `1`。
- pool entry 的 `actions` 可省略，省略等价空动作。
- `ItemResolve.actions` 必须出现，且必须是非空 action 或非空 action 列表；不能省略、不能为 `null`、不能为空列表。
- `ItemResolve.actions` 必须包含且仅包含一个 `item -= n` 动作，且该动作必须减少当前 `ItemResolve.item`；不能包含减少其他 item 的 `-=` 动作。
- `mode` 省略时等价 `once`。

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
- 普通 rule 的 condition tree 至少应包含一个非空 action。
- termination_rule 的每条可命中路径都必须包含 `terminate ...` action。
- 不支持旧的 `conditions`、`cases`、`reason` 字段。

执行语义：

- 条件求值阶段只判断条件并收集 actions，不修改状态。
- `OR` 按 `children` 声明顺序短路，只使用第一个满足的 child。
- `AND` 要求所有 children 都满足，按声明顺序聚合 child actions。
- 命中逻辑节点时，当前节点 actions 排在 child actions 之前执行。

## 示例

单条件 rule：

```yaml
rules:
- name: have_target
  mode: once
  condition:
    check: target_item >= 1
    actions: change next_pool
```

分支 rule：

```yaml
rules:
- name: badge_gain
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
