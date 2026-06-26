from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

from gachasimulate.builder import (
    RuntimeBuilder,
    _analyse_action,
    _analyse_actions,
    _build_condition_tree,
    _str2node,
    build,
    config_builder,
    termination_builder,
)
from gachasimulate.runtime import (
    Action,
    AddItem,
    CheckNode,
    DrawPool,
    ItemResolve,
    LogicNode,
    PoolChange,
    ReduceItem,
    Reporter,
    RuntimeConfigContext,
    RuntimeContext,
    RuntimeKind,
    RuntimeOpCode,
    SetItem,
    Termination,
)

ROOT = Path(__file__).resolve().parents[1]
CONFIG_SCHEMA_PATH = ROOT / "docs" / "schemas" / "config.schema.json"
TERMINATION_SCHEMA_PATH = ROOT / "docs" / "schemas" / "termination.schema.json"


def _pool_action_details(actions: Sequence[Action]):
    details = []
    for action in actions:
        assert isinstance(action, DrawPool)
        details.append((action.kind, action.pool_index))
    return details


def _item_amount_action_details(actions: Sequence[Action]):
    details = []
    for action in actions:
        assert isinstance(action, AddItem | ReduceItem | SetItem)
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
        (RuntimeKind.AddItem, ctx.draw_count_index, 1),
        (RuntimeKind.AddItem, ctx.item_id_index["general_fragment"], 1),
    ]

    precious_trigger = ctx.item_draw_list[ctx.item_id_index["random_precious_item"]]
    ordinary_trigger = ctx.item_draw_list[ctx.item_id_index["random_ordinary_item"]]
    assert _pool_action_details(precious_trigger) == [(RuntimeKind.DrawPool, 3)]
    assert _pool_action_details(ordinary_trigger) == [(RuntimeKind.DrawPool, 4)]

    precious_resolve = ctx.item_resolve_list[ctx.item_id_index["precious_item_1"]]
    ordinary_resolve = ctx.item_resolve_list[ctx.item_id_index["ordinary_item_2"]]
    assert precious_resolve.retain == 0
    assert ordinary_resolve.retain == 0
    assert _item_amount_action_details(precious_resolve.actions) == [
        (RuntimeKind.AddItem, 11, 120),
        (RuntimeKind.ReduceItem, 5, 1),
    ]
    assert _item_amount_action_details(ordinary_resolve.actions) == [
        (RuntimeKind.AddItem, 11, 30),
        (RuntimeKind.ReduceItem, 9, 1),
    ]

    first_stage = ctx.draw_stage_list[0]
    second_stage = ctx.draw_stage_list[1]
    assert first_stage.once is True
    assert second_stage.once is True
    assert isinstance(first_stage.condition, CheckNode)
    assert isinstance(second_stage.condition, CheckNode)
    assert second_stage.condition.actions is not None
    second_stage_action = second_stage.condition.actions[0]
    assert isinstance(second_stage_action, PoolChange)
    assert second_stage_action.pool_index == 2

    assert isinstance(ctx.termination_tree, LogicNode)
    first_branch, second_branch = ctx.termination_tree.conditions
    assert isinstance(first_branch, LogicNode)
    assert isinstance(second_branch, LogicNode)
    first_node_1, first_node_2, first_node_3 = first_branch.conditions
    assert isinstance(first_node_1, CheckNode)
    assert isinstance(first_node_2, CheckNode)
    assert isinstance(first_node_3, CheckNode)
    assert [first_node_1.item_index, first_node_2.item_index, first_node_3.item_index] == [
        ctx.item_id_index["target_item_1"],
        ctx.item_id_index["target_item_2"],
        ctx.item_id_index["target_item_3"],
    ]
    assert first_branch.actions is not None
    assert [action.kind for action in first_branch.actions] == [RuntimeKind.Termination]
    first_action = first_branch.actions[0]
    assert isinstance(first_action, Termination)
    assert first_action.reason == "all target items obtained"
    (second_node,) = second_branch.conditions
    assert isinstance(second_node, CheckNode)
    assert second_node.item_index == ctx.item_id_index["general_fragment"]
    assert second_branch.actions is not None
    second_action = second_branch.actions[0]
    assert isinstance(second_action, Termination)
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
    assert ctx.item_draw_list[ctx.item_id_index["random_skin"]][0].kind == RuntimeKind.DrawPool


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
    assert isinstance(condition, CheckNode)
    assert condition.actions is not None
    action = condition.actions[0]
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
        (RuntimeKind.AddItem, ctx.item_id_index["token"], 2)
    ]


# ---------------------------------------------------------------------------
# Tests for the new builder helpers (config_builder, _analyse_action, ...).
# These exercise the new code path introduced for parsing the YAML-style
# action/condition shorthands; they intentionally only cover cases that a
# correct implementation must satisfy.
# ---------------------------------------------------------------------------


def _make_probe_context() -> RuntimeConfigContext:
    """Build a RuntimeConfigContext populated with a tiny item index."""
    context = RuntimeConfigContext()
    context.item_id_index["token"] = 0
    context.item_id_index["counter"] = 1
    context.item_id_index["draw_count"] = 2
    context.pool_id_index["token_pool"] = 0
    context.pool_id_index["counter_pool"] = 1
    return context


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("token+=5", AddItem(item_index=0, amount=5)),
        ("counter++", AddItem(item_index=1, amount=1)),
        ("counter+= 10", AddItem(item_index=1, amount=10)),
        ("token-=4", ReduceItem(item_index=0, amount=4)),
        ("counter--", ReduceItem(item_index=1, amount=1)),
        ("token=0", SetItem(item_index=0, amount=0)),
        ("draw_count=42", SetItem(item_index=2, amount=42)),
        ("termination", Termination(reason="")),
    ],
)
def test_analyse_action_parses_item_amount_shorthand(source: str, expected: Action) -> None:
    context = _make_probe_context()

    result = _analyse_action(context, source)

    assert result == expected


def test_analyse_action_parses_draw_pool_shorthand() -> None:
    context = _make_probe_context()

    assert _analyse_action(context, "draw token_pool") == DrawPool(pool_index=0)
    assert _analyse_action(context, "draw  counter_pool") == DrawPool(pool_index=1)


def test_analyse_action_parses_pool_change_shorthand() -> None:
    context = _make_probe_context()

    assert _analyse_action(context, "change token_pool") == PoolChange(pool_index=0)
    assert _analyse_action(context, "change  counter_pool") == PoolChange(pool_index=1)


def test_analyse_action_dict_form_matches_string_shorthand() -> None:
    context = _make_probe_context()

    string_form = _analyse_action(context, "token+=7")
    dict_form = _analyse_action(context, {"type": "add_item", "id": "token", "amount": 7})
    assert string_form == dict_form == AddItem(item_index=0, amount=7)


@pytest.mark.parametrize(
    ("dict_action", "expected"),
    [
        (
            {"type": "add_item", "id": "token"},
            AddItem(item_index=0, amount=1),
        ),
        (
            {"type": "reduce_item", "id": "counter", "amount": 9},
            ReduceItem(item_index=1, amount=9),
        ),
        (
            {"type": "set_item", "id": "draw_count", "amount": 0},
            SetItem(item_index=2, amount=0),
        ),
        (
            {"type": "draw_pool", "id": "token_pool"},
            DrawPool(pool_index=0),
        ),
        (
            {"type": "pool_change", "id": "counter_pool"},
            PoolChange(pool_index=1),
        ),
        (
            {"type": "termination", "reason": "fragments exchanged"},
            Termination(reason="fragments exchanged"),
        ),
        (
            {"type": "termination"},
            Termination(reason=""),
        ),
    ],
)
def test_analyse_action_parses_dict_form(dict_action: dict, expected: Action) -> None:
    context = _make_probe_context()

    assert _analyse_action(context, dict_action) == expected


def test_analyse_actions_drops_invalid_entries() -> None:
    context = _make_probe_context()

    result = _analyse_actions(context, ["token+=2", "token=9", "counter--"])

    assert result == [
        AddItem(item_index=0, amount=2),
        SetItem(item_index=0, amount=9),
        ReduceItem(item_index=1, amount=1),
    ]


def test_analyse_actions_returns_empty_for_empty_list() -> None:
    assert _analyse_actions(_make_probe_context(), []) == []


def test_analyse_actions_returns_empty_when_all_invalid() -> None:
    context = _make_probe_context()

    assert _analyse_actions(context, [{"type": "unknown"}]) == []


@pytest.mark.parametrize(
    ("source", "expected_item_id", "expected_op", "expected_value"),
    [
        ("token >= 5", "token", RuntimeOpCode.GE, "5"),
        ("token > 5", "token", RuntimeOpCode.GT, "5"),
        ("counter <= 1", "counter", RuntimeOpCode.LE, "1"),
        ("counter < 1", "counter", RuntimeOpCode.LT, "1"),
        ("draw_count == 10", "draw_count", RuntimeOpCode.EQ, "10"),
        ("draw_count != 10", "draw_count", RuntimeOpCode.NE, "10"),
        ("token = 5", "token", RuntimeOpCode.EQ, "5"),
    ],
)
def test_str2node_recognises_all_supported_operators(
    source: str,
    expected_item_id: str,
    expected_op: RuntimeOpCode,
    expected_value: str,
) -> None:
    assert _str2node(source) == (expected_item_id, expected_op, expected_value)


def test_str2node_returns_none_for_unknown_expression() -> None:
    assert _str2node("??garbage??") is None


@pytest.mark.parametrize(
    ("source", "expected_item_index", "expected_op", "expected_value"),
    [
        ("token >= 5", 0, RuntimeOpCode.GE, 5),
        ("counter < 1", 1, RuntimeOpCode.LT, 1),
        ("draw_count == 10", 2, RuntimeOpCode.EQ, 10),
    ],
)
def test_build_condition_tree_string_predicate(
    source: str, expected_item_index: int, expected_op: RuntimeOpCode, expected_value: int
) -> None:
    context = _make_probe_context()

    node = _build_condition_tree(context, source)

    assert isinstance(node, CheckNode)
    assert node.item_index == expected_item_index
    assert node.op == expected_op
    assert node.value == expected_value


@pytest.mark.parametrize(
    "operator_prefix",
    ["OR", "or", "|", "AND", "and", "&"],
)
def test_build_condition_tree_string_logic_node(operator_prefix: str) -> None:
    context = _make_probe_context()

    source = f"{operator_prefix} token >= 1, counter < 5"

    node = _build_condition_tree(context, source)

    assert isinstance(node, LogicNode)
    assert node.op in {RuntimeOpCode.OR, RuntimeOpCode.AND}
    assert len(node.conditions) == 2
    for child in node.conditions:
        assert isinstance(child, CheckNode)


def test_build_condition_tree_or_and_distinguish_operator() -> None:
    context = _make_probe_context()

    or_node = _build_condition_tree(context, "OR token >= 1, counter < 5")
    and_node = _build_condition_tree(context, "AND token >= 1, counter < 5")

    assert isinstance(or_node, LogicNode)
    assert isinstance(and_node, LogicNode)
    assert or_node.op == RuntimeOpCode.OR
    assert and_node.op == RuntimeOpCode.AND


def test_build_condition_tree_dict_predicate_with_actions() -> None:
    context = _make_probe_context()

    node = _build_condition_tree(
        context,
        {
            "op": ">=",
            "id": "token",
            "value": 1,
            "actions": ["token+=5"],
        },
    )

    assert isinstance(node, CheckNode)
    assert node.item_index == context.item_id_index["token"]
    assert node.op == RuntimeOpCode.GE
    assert node.value == 1
    assert node.actions == [AddItem(item_index=0, amount=5)]


@pytest.mark.parametrize("op_value", ["OR", "AND"])
def test_build_condition_tree_dict_logic_node(op_value: str) -> None:
    context = _make_probe_context()

    node = _build_condition_tree(
        context,
        {
            "op": op_value,
            "conditions": [
                {"op": ">=", "id": "token", "value": 1},
                {"op": "<", "id": "counter", "value": 9},
            ],
            "actions": ["draw_count=0"],
        },
    )

    assert isinstance(node, LogicNode)
    expected_op = RuntimeOpCode.OR if op_value == "OR" else RuntimeOpCode.AND
    assert node.op == expected_op
    assert len(node.conditions) == 2
    assert all(isinstance(child, CheckNode) for child in node.conditions)
    assert node.actions == [SetItem(item_index=2, amount=0)]


def test_build_condition_tree_returns_none_for_none_input() -> None:
    assert _build_condition_tree(_make_probe_context(), None) is None


def _minimal_valid_config() -> dict:
    return {
        "items": {
            "token": "Token",
            "target": {"name": "Target"},
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {"entries": [{"probability": 1.0, "actions": ["token++"]}]},
        },
        "initial": {"begin_pool": "begin_pool"},
        "every_draw": ["draw_count+=1"],
    }


def test_config_builder_populates_item_index_and_lists() -> None:
    context = config_builder(_minimal_valid_config())

    assert isinstance(context, RuntimeConfigContext)
    assert context.item_id_index == {"token": 0, "target": 1, "draw_count": 2}
    assert [item.name for item in context.item_list] == ["Token", "Target", "Draw count"]
    assert context.item_resolve_list == [
        ItemResolve(),
        ItemResolve(),
        ItemResolve(),
    ]
    assert context.item_draw_list == [[], [], []]


def test_config_builder_builds_pool_with_action_shortcuts() -> None:
    context = config_builder(_minimal_valid_config())
    assert context is not None

    assert len(context.pool_list) == 1
    pool = context.pool_list[0]
    assert pool.cdf.tolist() == [1.0]
    assert pool.actions == [[AddItem(item_index=0, amount=1)]]


def test_config_builder_compiles_initial_and_every_draw_shortcuts() -> None:
    config = _minimal_valid_config()
    config["initial"] = {"begin_pool": "begin_pool", "actions": ["token+=3"]}
    config["every_draw"] = ["draw_count+=1"]

    context = config_builder(config)
    assert context is not None

    assert context.initial_actions == [AddItem(item_index=0, amount=3)]
    assert context.every_draw_actions == [AddItem(item_index=2, amount=1)]


def test_config_builder_accepts_pool_entries_as_bare_list() -> None:
    config = _minimal_valid_config()
    config["pools"] = {"begin_pool": [{"probability": 1.0, "actions": ["token++"]}]}

    context = config_builder(config)
    assert context is not None

    assert len(context.pool_list) == 1
    assert context.pool_list[0].actions == [[AddItem(item_index=0, amount=1)]]


def test_config_builder_normalises_probabilities_summing_to_one() -> None:
    config = _minimal_valid_config()
    config["pools"] = {
        "begin_pool": [
            {"probability": 1, "actions": ["token++"]},
            {"probability": 1, "actions": ["target++"]},
        ]
    }

    context = config_builder(config)
    assert context is not None

    cdf = context.pool_list[0].cdf
    assert cdf.tolist() == [0.5, 1.0]
    assert len(context.pool_list[0].actions) == 2


def test_config_builder_compiles_stage_with_dict_condition_and_actions() -> None:
    config = _minimal_valid_config()
    config["stages"] = {
        "reset": {
            "once": True,
            "condition": {
                "op": ">=",
                "id": "token",
                "value": 5,
                "actions": ["token=0"],
            },
        },
    }

    context = config_builder(config)
    assert context is not None

    assert context.draw_stage_id_index == {"reset": 0}
    assert len(context.draw_stage_list) == 1
    stage = context.draw_stage_list[0]
    assert stage.once is True
    assert isinstance(stage.condition, CheckNode)
    assert stage.condition.actions == [SetItem(item_index=0, amount=0)]


def test_config_builder_compiles_stage_with_string_condition() -> None:
    config = _minimal_valid_config()
    config["stages"] = {
        "switch": {"once": False, "condition": "token >= 5"},
    }

    context = config_builder(config)
    assert context is not None

    stage = context.draw_stage_list[0]
    assert stage.once is False
    assert isinstance(stage.condition, CheckNode)
    assert stage.condition.item_index == context.item_id_index["token"]
    assert stage.condition.op == RuntimeOpCode.GE
    assert stage.condition.value == 5


def test_config_builder_compiles_string_shortcuts_inside_resolve_and_on_acquire() -> None:
    """Items referenced inside resolve/on_acquire must resolve to indices."""
    config = _minimal_valid_config()
    config["items"]["reward"] = {
        "name": "Reward",
        "resolve": {
            "retain": 0,
            "actions": ["target+=10"],
        },
        "on_acquire": ["draw begin_pool"],
    }
    config["pools"]["begin_pool"] = {"entries": [{"probability": 1.0, "actions": ["reward++"]}]}

    context = config_builder(config)
    assert context is not None

    reward_index = context.item_id_index["reward"]
    target_index = context.item_id_index["target"]
    pool_index = context.pool_id_index["begin_pool"]

    resolve = context.item_resolve_list[reward_index]
    assert resolve.retain == 0
    assert resolve.actions == [AddItem(item_index=target_index, amount=10)]

    assert context.item_draw_list[reward_index] == [DrawPool(pool_index=pool_index)]


def test_config_builder_resolves_termination_actions_when_present() -> None:
    """config_builder should leave termination handling for the caller; this
    test asserts that adding a `termination` block does not break config
    analysis and the rest of the context is still produced correctly."""
    config = _minimal_valid_config()
    config["termination"] = {
        "retained_items": ["target"],
        "termination_condition": {
            "op": ">=",
            "id": "target",
            "value": 1,
            "actions": ["termination"],
        },
    }

    context = config_builder(config)
    assert context is not None

    # Items / pools / every_draw unaffected.
    assert context.item_id_index["target"] == 1
    assert len(context.pool_list) == 1
    assert context.every_draw_actions == [AddItem(item_index=2, amount=1)]


# ---------------------------------------------------------------------------
# Tests for the reporter integration in the new builder helpers.
#
# These tests are intentionally written so that all error messages emitted
# by ``Reporter`` go to the real stdout/stderr (``capsys.disabled`` for the
# ``config_builder`` path, default ``sys.stdout`` for explicit ``with``
# blocks). A human reviewer running ``pytest -s`` can read the messages;
# the assertions below only check that:
#   * the failing helper returns ``None`` / an empty list,
#   * the ``Reporter`` collected at least one message at the configured
#     ``fail_report_level`` (Error by default) and ``report()`` returns
#     ``True``.
# No message text is asserted.
# ---------------------------------------------------------------------------


def _streaming_reporter() -> Reporter:
    """Build a Reporter whose stream is the real ``sys.stdout`` so messages
    are visible during ``pytest -s`` runs."""
    return Reporter(
        stream=sys.stdout,
        show_report_level=Reporter.ReportLevel.Error,
        fail_report_level=Reporter.ReportLevel.Error,
    )


def test_config_builder_returns_none_when_probabilities_do_not_sum_to_one(
    capsys: pytest.CaptureFixture,
) -> None:
    bad_config = {
        "items": {
            "token": "Token",
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": [
                {"probability": 0.5, "actions": ["token++"]},
                {"probability": 0.6, "actions": ["token++"]},
            ]
        },
        "initial": {"begin_pool": "begin_pool"},
        "every_draw": ["draw_count+=1"],
    }

    with capsys.disabled():
        result = config_builder(bad_config)

    assert result is None


def test_config_builder_returns_none_when_initial_missing(
    capsys: pytest.CaptureFixture,
) -> None:
    bad_config = {
        "items": {
            "token": "Token",
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {"entries": [{"probability": 1.0, "actions": ["token++"]}]},
        },
        "every_draw": ["draw_count+=1"],
    }

    with capsys.disabled():
        result = config_builder(bad_config)

    assert result is None


def test_config_builder_returns_none_when_begin_pool_unknown(
    capsys: pytest.CaptureFixture,
) -> None:
    bad_config = {
        "items": {
            "token": "Token",
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {"entries": [{"probability": 1.0, "actions": ["token++"]}]},
        },
        "initial": {"begin_pool": "missing_pool"},
        "every_draw": ["draw_count+=1"],
    }

    with capsys.disabled():
        result = config_builder(bad_config)

    assert result is None


def test_analyse_action_reports_invalid_amount() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_action(context, "token+=x", reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_analyse_action_reports_unknown_item() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_action(context, "missing+=1", reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_analyse_action_reports_draw_target_not_in_items() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_action(context, "draw missing", reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_analyse_action_reports_unknown_dict_type() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_action(context, {"type": "no_such_type"}, reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_analyse_action_reports_dict_missing_id() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_action(context, {"type": "set_item"}, reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_analyse_actions_skips_and_reports_invalid_entries() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _analyse_actions(
            context,
            ["token+=5", "token+=x", "missing+=1"],
            reporter,
        )
        assert result == [AddItem(item_index=0, amount=5)]
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_build_condition_tree_reports_unknown_dict_op() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _build_condition_tree(
            context,
            {"op": "??", "id": "token", "value": 1},
            reporter,
        )
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_build_condition_tree_reports_dict_predicate_without_op() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _build_condition_tree(
            context,
            {"id": "token", "value": 1},
            reporter,
        )
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_build_condition_tree_reports_unknown_string_predicate() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _build_condition_tree(context, "garbage 123", reporter)
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_build_condition_tree_reports_unknown_item_in_dict_predicate() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _build_condition_tree(
            context,
            {"op": ">=", "id": "missing", "value": 1},
            reporter,
        )
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


def test_build_condition_tree_reports_bad_child_inside_logic_node() -> None:
    context = _make_probe_context()
    reporter = _streaming_reporter()

    with reporter:
        result = _build_condition_tree(
            context,
            {
                "op": "AND",
                "conditions": [
                    {"op": ">=", "id": "token", "value": 1},
                    "garbage 123",
                ],
            },
            reporter,
        )
        assert result is None
        assert any(level >= reporter.fail_report_level for level, _ in reporter.messages)


# ---------------------------------------------------------------------------
# Tests for ``termination_builder`` and the top-level ``build`` entry point.
# ---------------------------------------------------------------------------


def _minimal_termination_config() -> tuple[RuntimeConfigContext, dict]:
    context = config_builder(_minimal_valid_config())
    assert context is not None
    termination = {
        "retained_items": ["target"],
        "condition": {
            "op": ">=",
            "id": "target",
            "value": 1,
            "actions": [{"type": "termination", "reason": "fragments exchanged"}],
        },
    }
    return context, termination


def test_termination_builder_compiles_predicate_condition() -> None:
    context, termination = _minimal_termination_config()

    result = termination_builder(context, termination)

    assert result is not None
    condition, retained = result
    assert isinstance(condition, CheckNode)
    assert condition.item_index == context.item_id_index["target"]
    assert condition.op == RuntimeOpCode.GE
    assert condition.value == 1
    assert condition.actions == [Termination(reason="fragments exchanged")]
    assert retained == [context.item_id_index["target"]]


def test_termination_builder_compiles_logic_condition() -> None:
    context, termination = _minimal_termination_config()
    termination["condition"] = {
        "op": "OR",
        "conditions": [
            {"op": ">=", "id": "target", "value": 1},
            {"op": "<", "id": "draw_count", "value": 9},
        ],
    }

    result = termination_builder(context, termination)

    assert result is not None
    condition, retained = result
    assert isinstance(condition, LogicNode)
    assert condition.op == RuntimeOpCode.OR
    assert len(condition.conditions) == 2
    assert all(isinstance(child, CheckNode) for child in condition.conditions)
    assert retained == [context.item_id_index["target"]]


def test_termination_builder_returns_empty_retained_when_key_missing() -> None:
    context, termination = _minimal_termination_config()
    del termination["retained_items"]

    result = termination_builder(context, termination)

    assert result is not None
    _, retained = result
    assert retained == []


def test_termination_builder_returns_empty_retained_when_list_empty() -> None:
    context, termination = _minimal_termination_config()
    termination["retained_items"] = []

    result = termination_builder(context, termination)

    assert result is not None
    _, retained = result
    assert retained == []


def test_termination_builder_returns_none_when_condition_missing(
    capsys: pytest.CaptureFixture,
) -> None:
    context, termination = _minimal_termination_config()
    del termination["condition"]

    with capsys.disabled():
        result = termination_builder(context, termination)

    assert result is None


def test_termination_builder_returns_none_when_condition_invalid(
    capsys: pytest.CaptureFixture,
) -> None:
    context, termination = _minimal_termination_config()
    termination["condition"] = {"op": "??", "id": "target", "value": 1}

    with capsys.disabled():
        result = termination_builder(context, termination)

    assert result is None


def test_build_assembles_runtime_context_from_legacy_style_config() -> None:
    config = {
        "items": {
            "token": {"name": "Token"},
            "reward": {
                "name": "Reward",
                "resolve": {
                    "retain": 1,
                    "actions": [{"type": "add_item", "id": "token", "amount": 1}],
                },
            },
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {
                "entries": [
                    {
                        "probability": 0.5,
                        "actions": [{"type": "add_item", "id": "reward"}],
                    },
                    {
                        "probability": 0.5,
                        "actions": [{"type": "add_item", "id": "token"}],
                    },
                ]
            },
        },
        "initial": {"begin_pool": "begin_pool"},
        "every_draw": [{"type": "add_item", "id": "draw_count"}],
    }
    termination = {
        "retained_items": ["token"],
        "condition": {
            "op": ">=",
            "id": "draw_count",
            "value": 5,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }

    ctx = build(config, termination)
    assert ctx is not None
    assert isinstance(ctx, RuntimeContext)
    assert ctx.item_id_index == {"token": 0, "reward": 1, "draw_count": 2}
    assert ctx.draw_count_index == 2
    assert ctx.begin_pool_index == ctx.pool_id_index["begin_pool"]
    assert ctx.every_draw_actions == [AddItem(item_index=2, amount=1)]
    assert ctx.initial_actions == []
    assert ctx.retained_items_index == [0]
    assert isinstance(ctx.termination_tree, CheckNode)
    assert ctx.termination_tree.actions == [Termination(reason="done")]


def test_build_supports_yaml_shorthand_config() -> None:
    config = {
        "items": {
            "token": "Token",
            "target": {"name": "Target"},
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {"entries": [{"probability": 1.0, "actions": ["token++"]}]},
        },
        "initial": {"begin_pool": "begin_pool", "actions": ["target+=3"]},
        "every_draw": ["draw_count+=1"],
    }
    termination = {
        "retained_items": ["target"],
        "condition": {
            "op": ">=",
            "id": "target",
            "value": 1,
            "actions": ["termination"],
        },
    }

    ctx = build(config, termination)
    assert ctx is not None
    assert ctx.initial_actions == [AddItem(item_index=1, amount=3)]
    assert ctx.every_draw_actions == [AddItem(item_index=2, amount=1)]
    assert ctx.retained_items_index == [ctx.item_id_index["target"]]
    assert isinstance(ctx.termination_tree, CheckNode)
    assert ctx.termination_tree.actions == [Termination(reason="")]


def test_build_returns_none_when_config_invalid(
    capsys: pytest.CaptureFixture,
) -> None:
    bad_config = {
        "items": {
            "token": "Token",
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": [
                {"probability": 0.5, "actions": ["token++"]},
                {"probability": 0.6, "actions": ["token++"]},
            ]
        },
        "initial": {"begin_pool": "begin_pool"},
        "every_draw": ["draw_count+=1"],
    }

    with capsys.disabled():
        ctx = build(bad_config, {})

    assert ctx is None


def test_build_returns_none_when_termination_invalid(
    capsys: pytest.CaptureFixture,
) -> None:
    config = _minimal_valid_config()
    bad_termination = {
        "retained_items": ["target"],
        # condition missing on purpose
    }

    with capsys.disabled():
        ctx = build(config, bad_termination)

    assert ctx is None


# ---------------------------------------------------------------------------
# Tests that compare the new ``build`` entry point to the legacy
# ``RuntimeBuilder.from_config(...).build()`` path. They build the same
# configuration in both styles and assert that the runtime fields that both
# builders are expected to produce agree.
# ---------------------------------------------------------------------------


def _legacy_comparable_config() -> tuple[dict, dict]:
    """Configuration compatible with both ``RuntimeBuilder`` and ``build``.

    ``RuntimeBuilder`` expects the legacy ``type``-tagged condition and
    draw_pool/pool_change forms, while the new ``build`` accepts the same
    shape for the configuration block but uses a different termination
    schema (``condition`` instead of ``termination_condition``). This helper
    returns the config in the legacy format and a dict that is translated
    into the new schema by the caller.
    """
    config = {
        "items": {
            "token": {"name": "Token"},
            "reward": {
                "name": "Reward",
                "resolve": {
                    "retain": 1,
                    "actions": [{"type": "add_item", "id": "token", "amount": 1}],
                },
            },
            "draw_count": {"name": "Draw count"},
        },
        "pools": {
            "begin_pool": {
                "entries": [
                    {
                        "probability": 0.5,
                        "actions": [{"type": "add_item", "id": "reward"}],
                    },
                    {
                        "probability": 0.5,
                        "actions": [{"type": "add_item", "id": "token"}],
                    },
                ]
            },
            "bonus_pool": {
                "entries": [
                    {
                        "probability": 1.0,
                        "actions": [{"type": "add_item", "id": "token"}],
                    },
                ]
            },
        },
        "initial": {"begin_pool": "begin_pool"},
        "every_draw": [{"type": "add_item", "id": "draw_count"}],
    }
    legacy_termination = {
        "retained_items": ["token"],
        "termination_condition": {
            "type": "predicate",
            "subject": "item",
            "id": "draw_count",
            "op": ">=",
            "value": 5,
            "actions": [{"type": "termination", "reason": "done"}],
        },
    }
    return config, legacy_termination


def test_build_matches_runtime_builder_on_shared_fields() -> None:
    config, legacy_termination = _legacy_comparable_config()

    new_termination = {
        "retained_items": legacy_termination["retained_items"],
        "condition": legacy_termination["termination_condition"],
    }

    legacy_ctx = RuntimeBuilder.from_config(config, legacy_termination).build()
    new_ctx = build(config, new_termination)
    assert new_ctx is not None

    # Indices and id maps are identical.
    assert new_ctx.item_id_index == legacy_ctx.item_id_index
    assert new_ctx.pool_id_index == legacy_ctx.pool_id_index
    assert new_ctx.draw_count_index == legacy_ctx.draw_count_index
    assert new_ctx.begin_pool_index == legacy_ctx.begin_pool_index

    # Items and resolve/draw lists match.
    assert [item.name for item in new_ctx.item_list] == [item.name for item in legacy_ctx.item_list]
    for new_item, legacy_item in zip(new_ctx.item_resolve_list, legacy_ctx.item_resolve_list):
        assert new_item.retain == legacy_item.retain
        assert new_item.actions == legacy_item.actions
    assert new_ctx.item_draw_list == legacy_ctx.item_draw_list

    # Pool entries, probabilities and pre-baked draw list are equal.
    assert len(new_ctx.pool_list) == len(legacy_ctx.pool_list)
    for new_pool, legacy_pool in zip(new_ctx.pool_list, legacy_ctx.pool_list):
        assert new_pool.cdf.tolist() == legacy_pool.cdf.tolist()
        assert new_pool.actions == legacy_pool.actions
    assert new_ctx.pool_draw_list == legacy_ctx.pool_draw_list

    # Trigger/every-draw actions are equal.
    assert new_ctx.every_draw_actions == legacy_ctx.every_draw_actions
    assert new_ctx.initial_actions == legacy_ctx.initial_actions

    # Termination tree and retained items are equal.
    assert new_ctx.retained_items_index == legacy_ctx.retained_items_index
    assert new_ctx.termination_tree == legacy_ctx.termination_tree


def test_build_populates_pool_draw_list_one_entry_per_pool() -> None:
    """`pool_draw_list` must be pre-baked with one ``DrawPool`` per pool,
    matching the legacy ``RuntimeBuilder`` behaviour."""
    config, _ = _legacy_comparable_config()

    ctx = build(
        config,
        {
            "retained_items": ["token"],
            "condition": {
                "op": ">=",
                "id": "draw_count",
                "value": 5,
                "actions": [{"type": "termination", "reason": "done"}],
            },
        },
    )
    assert ctx is not None

    assert ctx.pool_draw_list == [DrawPool(pool_index=index) for index in range(len(ctx.pool_list))]
