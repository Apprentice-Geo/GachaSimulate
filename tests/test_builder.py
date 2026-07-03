from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

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
            "condition": {
                "check": "target >= 1",
                "actions": "terminate target acquired",
            },
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

    assert actions == (
        AddItem(item_index=ctx.item_id_index["token"], amount=2),
        ReduceItem(item_index=ctx.item_id_index["token"], amount=1),
        SetItem(item_index=ctx.item_id_index["token"], amount=3),
        DrawPool(pool_index=ctx.pool_id_index["bonus"]),
        PoolChange(pool_index=ctx.pool_id_index["bonus"]),
        Termination(reason="manual stop"),
    )


def test_build_context_compiles_empty_actions_to_empty_tuples() -> None:
    config = _minimal_config()
    config["pools"] = [
        {"main": [{"probability": 1.0}]},
    ]
    config["initial"] = None
    config["item_resolve"] = [
        {"item": "target", "retain": 1, "actions": "target -= 1"},
    ]
    config["rules"] = [
        {
            "rule": {
                "condition": {
                    "op": "AND",
                    "children": [
                        {"check": "token >= 1"},
                        {"check": "draw_count >= 1"},
                    ],
                    "actions": "shard += 1",
                },
            }
        },
    ]

    ctx = build_context(config, _minimal_termination())

    assert ctx.pool_list[0].actions == ((),)
    assert ctx.initial_actions == ()
    condition = ctx.rule_list[ctx.rule_id_index["rule"]].condition
    assert isinstance(condition, LogicNode)
    assert condition.children[0].actions == ()


def test_build_context_parses_condition_tree() -> None:
    config = _minimal_config()
    config["rules"] = [
        {
            "and_rule": {
                "mode": "per_draw",
                "condition": {
                    "op": "AND",
                    "children": [
                        {"check": "token >= 1"},
                        {"check": "draw_count < 10"},
                    ],
                    "actions": "shard += 1",
                },
            }
        },
        {
            "or_rule": {
                "condition": {
                    "op": "||",
                    "children": [
                        {"check": "token == 0"},
                        {"check": "target >= 1"},
                    ],
                    "actions": "shard += 2",
                },
            }
        },
    ]

    ctx = build_context(config, _minimal_termination())

    and_rule = ctx.rule_list[ctx.rule_id_index["and_rule"]]
    assert and_rule.mode == "per_draw"
    assert isinstance(and_rule.condition, LogicNode)
    assert and_rule.condition.op == RuntimeOpCode.AND
    assert and_rule.condition.actions == (AddItem(item_index=ctx.item_id_index["shard"], amount=1),)

    first_child = and_rule.condition.children[0]
    assert isinstance(first_child, CheckNode)
    assert first_child.item_index == ctx.item_id_index["token"]
    assert first_child.op == RuntimeOpCode.GE
    assert first_child.value == 1

    or_rule = ctx.rule_list[ctx.rule_id_index["or_rule"]]
    assert isinstance(or_rule.condition, LogicNode)
    assert or_rule.condition.op == RuntimeOpCode.OR


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


def test_build_context_maps_rule_modes_to_rules() -> None:
    config = _minimal_config()
    config["rules"] = [
        {
            "default": {
                "condition": {"check": "token >= 1", "actions": "shard += 1"},
            }
        },
        {
            "per_draw": {
                "mode": "per_draw",
                "condition": {"check": "token >= 2", "actions": "shard += 2"},
            }
        },
        {
            "repeat": {
                "mode": "repeat",
                "condition": {"check": "token >= 3", "actions": "shard += 3"},
            }
        },
    ]

    ctx = build_context(config, _minimal_termination())

    assert [rule.mode for rule in ctx.rule_list] == [
        "once",
        "per_draw",
        "repeat",
    ]


def test_build_context_compiles_or_children_as_ordered_first_match() -> None:
    config = _minimal_config()
    config["rules"] = [
        {
            "or_rule": {
                "mode": "repeat",
                "condition": {
                    "op": "OR",
                    "children": [
                        {"check": "token >= 1", "actions": "shard += 1"},
                        {"check": "draw_count >= 1", "actions": "shard += 2"},
                    ],
                },
            },
        }
    ]

    ctx = build_context(config, _minimal_termination())
    state = RuntimeState(item_count=len(ctx.item_list), rng=np.random.default_rng(0))
    state.inventory[ctx.item_id_index["token"]] = 1
    state.inventory[ctx.item_id_index["draw_count"]] = 1

    ok, actions = MonteCarlo(ctx)._eval_condition(ctx.rule_list[0].condition, state)

    assert ok is True
    assert actions == (AddItem(item_index=ctx.item_id_index["shard"], amount=1),)


def test_build_context_compiles_termination_tree_actions() -> None:
    termination = {
        "retained_items": [{"token": 1}, {"target": 1}],
        "termination_rule": {
            "condition": {
                "op": "OR",
                "children": [
                    {"check": "token >= 1", "actions": "terminate token stop"},
                    {"check": "target >= 1", "actions": "terminate target stop"},
                ],
            },
        },
    }

    ctx = build_context(_minimal_config(), termination)
    state = RuntimeState(item_count=len(ctx.item_list), rng=np.random.default_rng(0))
    state.inventory[ctx.item_id_index["target"]] = 1

    ok, actions = MonteCarlo(ctx)._eval_condition(ctx.termination_tree, state)

    assert ok is True
    assert actions == (Termination(reason="target stop"),)


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


def test_build_context_uses_initial_change_as_begin_pool() -> None:
    config = _minimal_config()
    config["pools"].append({"bonus": [{"probability": 1.0, "actions": "shard += 1"}]})
    config["initial"] = ["token += 1", "change bonus"]
    termination = {
        "retained_items": [],
        "termination_rule": {
            "condition": {
                "check": "draw_count >= 1",
                "actions": "terminate done",
            },
        },
    }

    ctx = build_context(config, termination)
    state = MonteCarlo(ctx, seed=0).run_once()

    assert ctx.initial_actions == (
        AddItem(item_index=ctx.item_id_index["token"], amount=1),
        PoolChange(pool_index=ctx.pool_id_index["bonus"]),
    )
    assert int(state.acquired[ctx.item_id_index["shard"]]) == 1


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
  condition:
    check: target >= 1
    actions: terminate done
""",
        encoding="utf-8",
    )

    ctx = build_from_files(config_path, termination_path)

    assert ctx.pool_id_index == {"main": 0}
    assert ctx.item_id_index["draw_count"] == 0
    assert ctx.every_draw_actions == (AddItem(item_index=0, amount=1),)


def test_build_from_files_rejects_json_extension(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    termination_path = tmp_path / "termination.yaml"
    config_path.write_text("{}", encoding="utf-8")
    termination_path.write_text("{}", encoding="utf-8")

    with pytest.raises(ValueError, match="must use .yaml or .yml"):
        build_from_files(config_path, termination_path)
