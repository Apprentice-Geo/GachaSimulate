from __future__ import annotations

import json
from pathlib import Path

import pytest

from gacha_sim.core.builder import runtime_builder
from gacha_sim.core.runtime import AddItem, CheckNode, DrawPool, LogicNode, PoolChange, ReduceItem, RuntimeContext, Termination

ROOT = Path(__file__).resolve().parents[1]


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_builds_expected_runtime_structure() -> None:
    config_path = ROOT / "configs" / "test" / "config.json"
    termination_path = ROOT / "configs" / "test" / "termination.json"

    ctx = runtime_builder(str(config_path), str(termination_path)).build()

    assert ctx.begin_pool_index == 0
    assert ctx.draw_stage_id_index == {
        "have_target_item_1": 0,
        "have_target_item_2": 1,
        "per_draw": 2,
    }
    assert ctx.protected_items_index == [0, 1, 2, 11]

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
    assert [(type(action), action.item_index, action.amount) for action in precious_resolve] == [
        (AddItem, 11, 120),
        (ReduceItem, 5, 1),
    ]
    assert [(type(action), action.item_index, action.amount) for action in ordinary_resolve] == [
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

    ctx = runtime_builder(str(config_path), str(termination_path)).build()

    assert isinstance(ctx, RuntimeContext)
    assert ctx.begin_pool_index == ctx.pool_id_index["begin_pool"]
    assert len(ctx.item_list) > 0
    assert len(ctx.pool_list) > 0
    assert len(ctx.draw_stage_list) > 0
    assert ctx.termination_tree is not None
    assert "sunwukong_wuxiang" in ctx.item_id_index
    assert "random_skin" in ctx.item_id_index
    assert isinstance(ctx.item_draw_list[ctx.item_id_index["random_skin"]][0], DrawPool)


def test_builds_without_optional_sections(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    termination_path = tmp_path / "termination.json"
    _write_json(
        config_path,
        {
            "economy": {"cost_per_draw": {"amount": 2, "per_cost_to_rmb": 3}},
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
        },
    )
    _write_json(
        termination_path,
        {
            "protected_items": ["target"],
            "termination_condition": {
                "type": "predicate",
                "subject": "item",
                "id": "target",
                "op": ">=",
                "value": 1,
                "actions": [{"type": "termination", "reason": "done"}],
            },
        },
    )

    ctx = runtime_builder(str(config_path), str(termination_path)).build()

    assert ctx.rmb_per_draw == 6
    assert ctx.begin_pool_index == 0
    assert ctx.item_draw_list == [[], []]
    assert ctx.item_resolve_list == [[], []]
    assert ctx.draw_stage_list == []
