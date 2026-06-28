from __future__ import annotations

from pathlib import Path

import numpy as np

from gachasimulate.builder import build_context, build_from_files
from gachasimulate.engine import MonteCarlo
from gachasimulate.runtime import (
    AddItem,
    CheckNode,
    DrawPool,
    LogicNode,
    PoolChange,
    ReduceItem,
    RuntimeOpCode,
    RuntimeState,
    SetItem,
    Termination,
)


def _minimal_config() -> dict:
    return {
        "items": [
            {"draw_count": "抽数"},
            "token",
            {"target": "目标"},
            "shard",
        ],
        "pools": [
            {
                "main": [
                    {"probability": 0.25, "actions": "token += 1"},
                    {"probability": 0.75, "actions": "target += 1"},
                ]
            }
        ],
        "every_draw": "draw_count += 1",
    }


def _minimal_termination() -> dict:
    return {
        "retained_items": [{"target": 1}],
        "termination_rule": {
            "conditions": "target >= 1",
            "reason": "target acquired",
        },
    }


def test_build_context_parses_action_strings() -> None:
    config = _minimal_config()
    config["pools"] = [
        {
            "main": [
                {
                    "probability": 1.0,
                    "actions": [
                        "token += 2",
                        "token -= 1",
                        "token = 3",
                        "draw bonus",
                        "change bonus",
                        "terminate manual stop",
                    ],
                }
            ]
        },
        {"bonus": [{"probability": 1.0, "actions": "shard += 1"}]},
    ]

    ctx = build_context(config, _minimal_termination())
    actions = ctx.pool_list[ctx.pool_id_index["main"]].actions[0]

    assert actions == [
        AddItem(item_index=ctx.item_id_index["token"], amount=2),
        ReduceItem(item_index=ctx.item_id_index["token"], amount=1),
        SetItem(item_index=ctx.item_id_index["token"], amount=3),
        DrawPool(pool_index=ctx.pool_id_index["bonus"]),
        PoolChange(pool_index=ctx.pool_id_index["bonus"]),
        Termination(reason="manual stop"),
    ]


def test_build_context_parses_condition_logic_and_implicit_and() -> None:
    config = _minimal_config()
    config["rules"] = [
        {
            "name": "implicit",
            "mode": "per_draw",
            "conditions": ["token >= 1", "draw_count < 10"],
            "actions": "shard += 1",
        },
        {
            "name": "explicit",
            "conditions": {
                "op": "||",
                "conditions": ["token == 0", "target >= 1"],
            },
            "actions": "shard += 2",
        },
    ]

    ctx = build_context(config, _minimal_termination())

    implicit = ctx.draw_stage_list[ctx.draw_stage_id_index["implicit"]]
    assert implicit.mode == "per_draw"
    assert isinstance(implicit.condition, LogicNode)
    assert implicit.condition.op == RuntimeOpCode.AND
    assert implicit.condition.actions == [
        AddItem(item_index=ctx.item_id_index["shard"], amount=1)
    ]

    first_child = implicit.condition.conditions[0]
    assert isinstance(first_child, CheckNode)
    assert first_child.item_index == ctx.item_id_index["token"]
    assert first_child.op == RuntimeOpCode.GE
    assert first_child.value == 1

    explicit = ctx.draw_stage_list[ctx.draw_stage_id_index["explicit"]]
    assert isinstance(explicit.condition, LogicNode)
    assert explicit.condition.op == RuntimeOpCode.OR


def test_build_context_normalizes_weight_pools_to_cdf() -> None:
    config = _minimal_config()
    config["pools"] = [
        {
            "main": [
                {"weight": 1, "actions": "token += 1"},
                {"weight": 3, "actions": "target += 1"},
            ]
        }
    ]

    ctx = build_context(config, _minimal_termination())

    np.testing.assert_allclose(ctx.pool_list[0].cdf, np.asarray([0.25, 1.0]))


def test_build_context_uses_probability_pools_directly() -> None:
    ctx = build_context(_minimal_config(), _minimal_termination())

    np.testing.assert_allclose(ctx.pool_list[0].cdf, np.asarray([0.25, 1.0]))


def test_build_context_maps_rule_modes_to_stages() -> None:
    config = _minimal_config()
    config["rules"] = [
        {"name": "default", "conditions": "token >= 1", "actions": "shard += 1"},
        {
            "name": "per_draw",
            "mode": "per_draw",
            "conditions": "token >= 2",
            "actions": "shard += 2",
        },
        {
            "name": "repeat",
            "mode": "repeat",
            "conditions": "token >= 3",
            "actions": "shard += 3",
        },
    ]

    ctx = build_context(config, _minimal_termination())

    assert [stage.mode for stage in ctx.draw_stage_list] == [
        "once",
        "per_draw",
        "repeat",
    ]


def test_build_context_compiles_cases_as_ordered_first_match() -> None:
    config = _minimal_config()
    config["rules"] = [
        {
            "name": "case_rule",
            "mode": "repeat",
            "cases": [
                {"conditions": "token >= 1", "actions": "shard += 1"},
                {"conditions": "draw_count >= 1", "actions": "shard += 2"},
            ],
        }
    ]

    ctx = build_context(config, _minimal_termination())
    state = RuntimeState(item_count=len(ctx.item_list), rng=np.random.default_rng(0))
    state.inventory[ctx.item_id_index["token"]] = 1
    state.inventory[ctx.item_id_index["draw_count"]] = 1

    ok, actions = MonteCarlo(ctx)._eval_condition(ctx.draw_stage_list[0].condition, state)

    assert ok is True
    assert actions == [AddItem(item_index=ctx.item_id_index["shard"], amount=1)]


def test_build_context_merges_termination_retains_into_item_resolve() -> None:
    config = _minimal_config()
    config["item_resolve"] = [
        {"item": "target", "retain": 1, "actions": "target -= 1"},
        {"item": "shard", "retain": 5, "actions": "shard -= 1"},
    ]
    termination = _minimal_termination()
    termination["retained_items"] = [{"target": 3}, {"shard": 2}]

    ctx = build_context(config, termination)

    assert ctx.item_resolve_list[ctx.item_id_index["target"]].retain == 3
    assert ctx.item_resolve_list[ctx.item_id_index["shard"]].retain == 5
    assert ctx.retained_items_index == []


def test_build_context_uses_initial_change_as_begin_pool() -> None:
    config = _minimal_config()
    config["pools"].append({"bonus": [{"probability": 1.0, "actions": "shard += 1"}]})
    config["initial"] = ["token += 1", "change bonus"]

    ctx = build_context(config, _minimal_termination())

    assert ctx.begin_pool_index == ctx.pool_id_index["bonus"]
    assert ctx.initial_actions == [
        AddItem(item_index=ctx.item_id_index["token"], amount=1),
        PoolChange(pool_index=ctx.pool_id_index["bonus"]),
    ]


def test_build_from_files_loads_yaml(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    termination_path = tmp_path / "termination.yaml"
    config_path.write_text(
        """
items:
  - draw_count: 抽数
  - token
  - target
pools:
  - main:
      - probability: 1.0
        actions: target += 1
every_draw:
  - draw_count += 1
""",
        encoding="utf-8",
    )
    termination_path.write_text(
        """
retained_items:
  - target: 1
termination_rule:
  conditions: target >= 1
  reason: done
""",
        encoding="utf-8",
    )

    ctx = build_from_files(config_path, termination_path)

    assert ctx.pool_id_index == {"main": 0}
    assert ctx.item_id_index["draw_count"] == 0
    assert ctx.every_draw_actions == [AddItem(item_index=0, amount=1)]
