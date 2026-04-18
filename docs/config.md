# Config Schema

运行时当前支持两份 JSON：

- `config.json`：物品、池子、抽取触发和阶段规则
- `termination.json`：protected 物品和终止条件树

## config.json

```json
{
  "economy": {
    "cost_per_draw": {
      "amount": 10,
      "per_cost_to_rmb": 1
    }
  },
  "items": {
    "item_a": {"name": "Item A"}
  },
  "item_draw": {
    "item_a": [
      {"type": "draw_pool", "id": "bonus_pool"}
    ]
  },
  "item_resolve": {
    "item_a": [
      {"type": "add_item", "id": "fragment", "amount": 10},
      {"type": "reduce_item", "id": "item_a", "amount": 1}
    ]
  },
  "pools": {
    "begin_pool": {
      "entries": [
        {
          "probability": 1.0,
          "actions": [{"type": "add_item", "id": "item_a"}]
        }
      ]
    }
  },
  "stages": {
    "switch_after_first_hit": {
      "once": true,
      "condition": {
        "type": "predicate",
        "subject": "item",
        "id": "item_a",
        "op": ">=",
        "value": 1,
        "actions": [{"type": "pool_change", "id": "bonus_pool"}]
      }
    }
  }
}
```

约束：

- `pools` 必须非空，且第一个池子必须命名为 `begin_pool`
- `item_draw` 可选
- `item_resolve` 可选
- `stages` 可选

### Action Types

- `add_item`: `id`, `amount`
- `reduce_item`: `id`, `amount`
- `draw_pool`: `id`
- `pool_change`: `id`
- `termination`: `reason`

## termination.json

```json
{
  "protected_items": ["target_item"],
  "termination_condition": {
    "type": "logic",
    "op": "OR",
    "conditions": [
      {
        "type": "predicate",
        "subject": "item",
        "id": "target_item",
        "op": ">=",
        "value": 1,
        "actions": [{"type": "termination", "reason": "target reached"}]
      }
    ]
  }
}
```

### Predicate Subjects

- `item`: 读取当前库存，必须提供 `id`
- `draw_count`
- `rmb_cost`

### Logic Nodes

- `type`: `logic`
- `op`: `AND` 或 `OR`
- `conditions`: 子条件列表
- `actions`: 当前节点命中后追加执行的动作
