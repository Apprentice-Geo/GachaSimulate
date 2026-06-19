from __future__ import annotations

from pathlib import Path

import pytest

from simulate.builder import RuntimeBuilder
from simulate.runtime import (
    Action,
    ItemResolve,
    RUNTIME_KIND,
    RuntimeContext,
)

ROOT = Path(__file__).resolve().parents[1]
CONFIG_SCHEMA_PATH = ROOT / "docs" / "schemas" / "config.schema.json"
TERMINATION_SCHEMA_PATH = ROOT / "docs" / "schemas" / "termination.schema.json"


def _pool_action_details(actions: list[Action]):
    details = []
    for action in actions:
        assert action.kind == RUNTIME_KIND.DrawPool
        details.append((action.kind, action.pool_index))
    return details


def _item_amount_action_details(actions: list[Action]):
    details = []
    for action in actions:
        assert action.kind in (
            RUNTIME_KIND.AddItem,
            RUNTIME_KIND.ReduceItem,
            RUNTIME_KIND.SetItem,
        )
        details.append((action.kind, action.item_index, action.amount))
    return details


def _config_termination_pairs() -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    for config_path in sorted((ROOT / "configs").glob("*/config.json")):
        for termination_path in sorted(config_path.parent.glob("termination*.json")):
            pairs.append((config_path, termination_path))
    return pairs


def test_builds_expected_runtime_structure() -> None:
    config_path = ROOT / "configs" / "test" / "config.json"
    termination_path = ROOT / "configs" / "test" / "termination.json"

    ctx = RuntimeBuilder(
        str(config_path),
        str(termination_path),
        str(CONFIG_SCHEMA_PATH),
        str(TERMINATION_SCHEMA_PATH),
    ).build()

    assert ctx.begin_pool_index == 0
    assert ctx.draw_stage_id_index == {
        "have_target_item_1": 0,
        "have_target_item_2": 1,
    }
    assert ctx.retained_items_index == [0, 1, 2, 11]
    assert _item_amount_action_details(ctx.every_draw_actions) == [
        (RUNTIME_KIND.AddItem, ctx.draw_count_index, 1),
        (RUNTIME_KIND.AddItem, ctx.item_id_index["general_fragment"], 1),
    ]

    precious_trigger = ctx.item_draw_list[ctx.item_id_index["random_precious_item"]]
    ordinary_trigger = ctx.item_draw_list[ctx.item_id_index["random_ordinary_item"]]
    assert _pool_action_details(precious_trigger) == [(RUNTIME_KIND.DrawPool, 3)]
    assert _pool_action_details(ordinary_trigger) == [(RUNTIME_KIND.DrawPool, 4)]

    precious_resolve = ctx.item_resolve_list[ctx.item_id_index["precious_item_1"]]
    ordinary_resolve = ctx.item_resolve_list[ctx.item_id_index["ordinary_item_2"]]
    assert precious_resolve.retain == 0
    assert ordinary_resolve.retain == 0
    assert _item_amount_action_details(precious_resolve.actions) == [
        (RUNTIME_KIND.AddItem, 11, 120),
        (RUNTIME_KIND.ReduceItem, 5, 1),
    ]
    assert _item_amount_action_details(ordinary_resolve.actions) == [
        (RUNTIME_KIND.AddItem, 11, 30),
        (RUNTIME_KIND.ReduceItem, 9, 1),
    ]

    first_stage = ctx.draw_stage_list[0]
    second_stage = ctx.draw_stage_list[1]
    assert first_stage.once is True
    assert second_stage.once is True
    assert first_stage.condition.kind == RUNTIME_KIND.CheckNode
    assert second_stage.condition.kind == RUNTIME_KIND.CheckNode
    assert second_stage.condition.actions is not None
    second_stage_action = second_stage.condition.actions[0]
    assert second_stage_action.kind == RUNTIME_KIND.PoolChange
    assert second_stage_action.pool_index == 2

    assert ctx.termination_tree.kind == RUNTIME_KIND.LogicNode
    assert ctx.termination_tree.op == "OR"
    first_branch, second_branch = ctx.termination_tree.conditions
    assert first_branch.kind == RUNTIME_KIND.LogicNode
    assert second_branch.kind == RUNTIME_KIND.LogicNode
    assert [first_branch.op, second_branch.op] == ["AND", "AND"]
    first_node_1, first_node_2, first_node_3 = first_branch.conditions
    assert first_node_1.kind == RUNTIME_KIND.CheckNode
    assert first_node_2.kind == RUNTIME_KIND.CheckNode
    assert first_node_3.kind == RUNTIME_KIND.CheckNode
    assert [first_node_1.item_index, first_node_2.item_index, first_node_3.item_index] == [
        ctx.item_id_index["target_item_1"],
        ctx.item_id_index["target_item_2"],
        ctx.item_id_index["target_item_3"],
    ]
    assert first_branch.actions is not None
    assert [action.kind for action in first_branch.actions] == [RUNTIME_KIND.Termination]
    first_action = first_branch.actions[0]
    assert first_action.reason == "all target items obtained"
    (second_node,) = second_branch.conditions
    assert second_node.kind == RUNTIME_KIND.CheckNode
    assert second_node.item_index == ctx.item_id_index["general_fragment"]
    assert second_branch.actions is not None
    second_action = second_branch.actions[0]
    assert second_action.kind == RUNTIME_KIND.Termination
    assert second_action.reason == "fragment exchange"


@pytest.mark.parametrize(
    "termination_name",
    [
        "termination_all.json",
        "termination_all_exchange.json",
        "termination_skin.json",
        "termination_skin_exchange.json",
    ],
)
def test_builder_compiles_all_wuxiang_terminations(termination_name: str) -> None:
    config_path = ROOT / "configs" / "sunwukong_wuxiang" / "config.json"
    termination_path = ROOT / "configs" / "sunwukong_wuxiang" / termination_name

    ctx = RuntimeBuilder(
        str(config_path),
        str(termination_path),
        str(CONFIG_SCHEMA_PATH),
        str(TERMINATION_SCHEMA_PATH),
    ).build()

    assert isinstance(ctx, RuntimeContext)
    assert ctx.begin_pool_index == ctx.pool_id_index["begin_pool"]
    assert len(ctx.item_list) > 0
    assert len(ctx.pool_list) > 0
    assert len(ctx.draw_stage_list) > 0
    assert ctx.termination_tree is not None
    assert "sunwukong_wuxiang" in ctx.item_id_index
    assert "random_skin" in ctx.item_id_index
    assert ctx.item_draw_list[ctx.item_id_index["random_skin"]][0].kind == RUNTIME_KIND.DrawPool


@pytest.mark.parametrize(
    ("config_path", "termination_path"),
    _config_termination_pairs(),
    ids=lambda value: value.parent.name if value.name == "config.json" else value.name,
)
def test_builder_compiles_all_real_config_files(config_path: Path, termination_path: Path) -> None:
    ctx = RuntimeBuilder(
        str(config_path),
        str(termination_path),
        str(CONFIG_SCHEMA_PATH),
        str(TERMINATION_SCHEMA_PATH),
    ).build()

    assert isinstance(ctx, RuntimeContext)
    assert ctx.begin_pool_index >= 0
    assert len(ctx.item_list) > 0
    assert len(ctx.pool_list) > 0
    assert ctx.termination_tree is not None


def test_builds_without_optional_sections() -> None:
    config = {
        "initial": {"begin_pool": "begin_pool"},
        "items": {
            "token": {"name": "Token"},
            "target": {"name": "Target"},
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {
                "entries": [
                    {
                        "probability": 1.0,
                        "actions": [{"type": "add_item", "id": "token"}],
                    }
                ]
            }
        },
        "every_draw": [{"type": "add_item", "id": "draw_count"}],
    }
    termination = {
        "retained_items": ["target"],
        "termination_condition": {
            "type": "predicate",
            "subject": "item",
            "id": "target",
            "op": ">=",
            "value": 1,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = RuntimeBuilder.from_config(config, termination).build()

    assert ctx.begin_pool_index == 0
    assert ctx.item_draw_list == [[], [], []]
    assert ctx.item_resolve_list == [
        ItemResolve(retain=0, actions=[]),
        ItemResolve(retain=0, actions=[]),
        ItemResolve(retain=0, actions=[]),
    ]
    assert ctx.draw_stage_list == []


def test_builds_set_item_action() -> None:
    config = {
        "initial": {"begin_pool": "begin_pool"},
        "items": {
            "counter": {"name": "Counter"},
            "target": {"name": "Target"},
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {
                "entries": [
                    {
                        "probability": 1.0,
                        "actions": [{"type": "add_item", "id": "counter"}],
                    }
                ]
            }
        },
        "every_draw": [{"type": "add_item", "id": "draw_count"}],
        "stages": {
            "reset_counter": {
                "once": True,
                "condition": {
                    "type": "predicate",
                    "subject": "item",
                    "id": "counter",
                    "op": ">=",
                    "value": 1,
                    "actions": [{"type": "set_item", "id": "counter", "amount": 0}],
                },
            }
        },
    }
    termination = {
        "retained_items": [],
        "termination_condition": {
            "type": "predicate",
            "subject": "item",
            "id": "draw_count",
            "op": ">=",
            "value": 1,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = RuntimeBuilder.from_config(config, termination).build()

    condition = ctx.draw_stage_list[0].condition
    assert condition.kind == RUNTIME_KIND.CheckNode
    assert condition.actions is not None
    action = condition.actions[0]
    assert action.kind == RUNTIME_KIND.SetItem
    assert action.item_index == ctx.item_id_index["counter"]
    assert action.amount == 0


def test_builds_initial_pool_and_actions() -> None:
    config = {
        "initial": {
            "begin_pool": "bonus_pool",
            "actions": [{"type": "add_item", "id": "token", "amount": 2}],
        },
        "items": {
            "token": {"name": "Token"},
            "target": {"name": "Target"},
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {
                "entries": [
                    {
                        "probability": 1.0,
                        "actions": [{"type": "add_item", "id": "token"}],
                    }
                ]
            },
            "bonus_pool": {
                "entries": [
                    {
                        "probability": 1.0,
                        "actions": [{"type": "add_item", "id": "target"}],
                    }
                ]
            },
        },
        "every_draw": [{"type": "add_item", "id": "draw_count"}],
    }
    termination = {
        "termination_condition": {
            "type": "predicate",
            "subject": "item",
            "id": "draw_count",
            "op": ">=",
            "value": 1,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = RuntimeBuilder.from_config(config, termination).build()

    assert ctx.begin_pool_index == ctx.pool_id_index["bonus_pool"]
    assert _item_amount_action_details(ctx.initial_actions) == [
        (RUNTIME_KIND.AddItem, ctx.item_id_index["token"], 2)
    ]
