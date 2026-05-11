from __future__ import annotations

from pathlib import Path

import pytest

from simulate.builder import RuntimeBuilder
from simulate.runtime import (
    AddItem,
    CheckNode,
    DrawPool,
    ItemResolve,
    LogicNode,
    PoolChange,
    ReduceItem,
    RuntimeContext,
    SetItem,
    Termination,
)

ROOT = Path(__file__).resolve().parents[1]


def _config_termination_pairs() -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    for config_path in sorted((ROOT / "configs").glob("*/config.json")):
        for termination_path in sorted(config_path.parent.glob("termination*.json")):
            pairs.append((config_path, termination_path))
    return pairs


def test_builds_expected_runtime_structure() -> None:
    config_path = ROOT / "configs" / "test" / "config.json"
    termination_path = ROOT / "configs" / "test" / "termination.json"

    ctx = RuntimeBuilder(str(config_path), str(termination_path)).build()

    assert ctx.begin_pool_index == 0
    assert ctx.draw_stage_id_index == {
        "have_target_item_1": 0,
        "have_target_item_2": 1,
        "per_draw": 2,
    }
    assert ctx.retained_items_index == [0, 1, 2, 11]

    precious_trigger = ctx.item_draw_list[ctx.item_id_index["random_precious_item"]]
    ordinary_trigger = ctx.item_draw_list[ctx.item_id_index["random_ordinary_item"]]
    assert [(type(action), action.pool_index) for action in precious_trigger] == [
        (DrawPool, 3)
    ]
    assert [(type(action), action.pool_index) for action in ordinary_trigger] == [
        (DrawPool, 4)
    ]

    precious_resolve = ctx.item_resolve_list[ctx.item_id_index["precious_item_1"]]
    ordinary_resolve = ctx.item_resolve_list[ctx.item_id_index["ordinary_item_2"]]
    assert precious_resolve.retain == 0
    assert ordinary_resolve.retain == 0
    assert [
        (type(action), action.item_index, action.amount)
        for action in precious_resolve.actions
    ] == [
        (AddItem, 11, 120),
        (ReduceItem, 5, 1),
    ]
    assert [
        (type(action), action.item_index, action.amount)
        for action in ordinary_resolve.actions
    ] == [
        (AddItem, 11, 30),
        (ReduceItem, 9, 1),
    ]

    first_stage = ctx.draw_stage_list[0]
    second_stage = ctx.draw_stage_list[1]
    per_draw_stage = ctx.draw_stage_list[2]
    assert first_stage.once is True
    assert second_stage.once is True
    assert per_draw_stage.once is False
    assert isinstance(first_stage.condition, CheckNode)
    assert isinstance(second_stage.condition.actions[0], PoolChange)
    assert second_stage.condition.actions[0].pool_index == 2
    assert per_draw_stage.condition.subject == "draw_count"
    assert isinstance(per_draw_stage.condition.actions[0], AddItem)
    assert per_draw_stage.condition.actions[0].item_index == 11
    assert per_draw_stage.condition.actions[0].amount == 1

    assert isinstance(ctx.termination_tree, LogicNode)
    assert ctx.termination_tree.op == "OR"
    assert [child.op for child in ctx.termination_tree.conditions] == ["AND", "AND"]
    first_branch, second_branch = ctx.termination_tree.conditions
    assert [node.id for node in first_branch.conditions] == [
        "target_item_1",
        "target_item_2",
        "target_item_3",
    ]
    assert [type(action) for action in first_branch.actions] == [Termination]
    assert first_branch.actions[0].reason == "all target items obtained"
    assert [node.id for node in second_branch.conditions] == ["general_fragment"]
    assert second_branch.actions[0].reason == "fragment exchange"


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

    ctx = RuntimeBuilder(str(config_path), str(termination_path)).build()

    assert isinstance(ctx, RuntimeContext)
    assert ctx.begin_pool_index == ctx.pool_id_index["begin_pool"]
    assert len(ctx.item_list) > 0
    assert len(ctx.pool_list) > 0
    assert len(ctx.draw_stage_list) > 0
    assert ctx.termination_tree is not None
    assert "sunwukong_wuxiang" in ctx.item_id_index
    assert "random_skin" in ctx.item_id_index
    assert isinstance(ctx.item_draw_list[ctx.item_id_index["random_skin"]][0], DrawPool)


@pytest.mark.parametrize(
    ("config_path", "termination_path"),
    _config_termination_pairs(),
    ids=lambda value: value.parent.name if value.name == "config.json" else value.name,
)
def test_builder_compiles_all_real_config_files(
    config_path: Path, termination_path: Path
) -> None:
    ctx = RuntimeBuilder(str(config_path), str(termination_path)).build()

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
    assert ctx.item_draw_list == [[], []]
    assert ctx.item_resolve_list == [
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
            "subject": "draw_count",
            "id": None,
            "op": ">=",
            "value": 1,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = RuntimeBuilder.from_config(config, termination).build()

    action = ctx.draw_stage_list[0].condition.actions[0]
    assert isinstance(action, SetItem)
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
    }
    termination = {
        "termination_condition": {
            "type": "predicate",
            "subject": "draw_count",
            "id": None,
            "op": ">=",
            "value": 1,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = RuntimeBuilder.from_config(config, termination).build()

    assert ctx.begin_pool_index == ctx.pool_id_index["bonus_pool"]
    assert [
        (type(action), action.item_index, action.amount)
        for action in ctx.initial_actions
    ] == [(AddItem, ctx.item_id_index["token"], 2)]
