from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Iterable

import numpy as np
import pytest

from gachasimulate.builder import build_from_files
from gachasimulate.engine import MonteCarlo
from gachasimulate.runtime import (
    AddItem,
    CheckNode as _CheckNode,
    DrawPool,
    Item,
    ItemResolve as _ItemResolve,
    LogicNode as _LogicNode,
    Pool as _Pool,
    PoolChange,
    ReduceItem,
    RuntimeAction,
    RuntimeCondition,
    RuntimeOpCode,
    RuntimeContext,
    SetItem,
    Rule,
    Termination,
)
from gachasimulate.core import (
    load_simulation_result,
    save_simulation_result,
    save_visualize_input,
    simulate_until_total_draw,
)

ROOT = Path(__file__).resolve().parents[1]


def CheckNode(
    *,
    item_index: int,
    op: RuntimeOpCode,
    value: int,
    actions: Iterable[RuntimeAction] = (),
) -> _CheckNode:
    return _CheckNode(
        item_index=item_index,
        op=op,
        value=value,
        actions=tuple(actions),
    )


def LogicNode(
    *,
    op: RuntimeOpCode,
    children: Iterable[RuntimeCondition],
    actions: Iterable[RuntimeAction] = (),
) -> _LogicNode:
    return _LogicNode(
        op=op,
        children=tuple(children),
        actions=tuple(actions),
    )


def Pool(
    *,
    cdf: Iterable[float],
    actions: Iterable[Iterable[RuntimeAction]],
) -> _Pool:
    return _Pool(
        cdf=tuple(float(value) for value in cdf),
        actions=tuple(tuple(entry_actions) for entry_actions in actions),
    )


def ItemResolve(
    *,
    retain: int = 0,
    actions: Iterable[RuntimeAction] = (),
) -> _ItemResolve:
    return _ItemResolve(retain=retain, actions=tuple(actions))


class CountingMonteCarlo(MonteCarlo):
    def __init__(self, ctx: RuntimeContext, seed=None):
        super().__init__(ctx, seed=seed)
        self.termination_eval_count = 0

    def _eval_condition(self, node, state):
        if node is self.ctx.termination_tree:
            self.termination_eval_count += 1
        return super()._eval_condition(node, state)


@pytest.fixture
def sanliou_ctx() -> RuntimeContext:
    config_path = ROOT / "configs" / "sanliou_zhenpinchuanshuo" / "config.yaml"
    termination_path = ROOT / "configs" / "sanliou_zhenpinchuanshuo" / "termination_skin.yaml"
    return build_from_files(config_path, termination_path)


def _draw_count(state, ctx: RuntimeContext) -> int:
    return int(state.inventory[ctx.draw_count_index])


def _freeze_condition(node):
    if isinstance(node, _CheckNode):
        return CheckNode(
            item_index=node.item_index,
            op=node.op,
            value=node.value,
            actions=tuple(node.actions),
        )

    if isinstance(node, _LogicNode):
        return LogicNode(
            op=node.op,
            children=tuple(_freeze_condition(child) for child in node.children),
            actions=tuple(node.actions),
        )

    raise TypeError(f"unsupported condition node type: {type(node).__name__}")


def _runtime_context(
    *,
    initial_actions,
    every_draw_actions,
    item_id_index,
    draw_count_index,
    item_list,
    item_resolve_list,
    pool_id_index,
    pool_list,
    pool_draw_list,
    rule_id_index,
    rule_list,
    termination_tree,
) -> RuntimeContext:
    item_list = tuple(item_list)
    item_resolve_list = tuple(
        ItemResolve(retain=resolve.retain, actions=tuple(resolve.actions))
        for resolve in item_resolve_list
    )
    item_resolve_list += tuple(
        ItemResolve() for _ in range(len(item_list) - len(item_resolve_list))
    )

    return RuntimeContext(
        initial_actions=tuple(initial_actions),
        every_draw_actions=tuple(every_draw_actions),
        item_id_index=item_id_index,
        draw_count_index=draw_count_index,
        item_list=item_list,
        item_resolve_list=item_resolve_list,
        pool_id_index=pool_id_index,
        pool_list=tuple(
            Pool(cdf=pool.cdf, actions=tuple(tuple(actions) for actions in pool.actions))
            for pool in pool_list
        ),
        pool_draw_list=tuple(pool_draw_list),
        rule_id_index=rule_id_index,
        rule_list=tuple(
            Rule(condition=_freeze_condition(rule.condition), mode=rule.mode) for rule in rule_list
        ),
        termination_tree=_freeze_condition(termination_tree),
    )


def test_runs_with_manual_context() -> None:
    item_list = [Item(id="token", name="Token"), Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["target"], amount=1)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={},
        rule_list=[],
        termination_tree=CheckNode(
            item_index=item_id_index["target"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="target reached")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert state.terminate is True
    assert state.terminate_reason == "target reached"
    assert _draw_count(state, ctx) == 1
    assert int(state.inventory[item_id_index["target"]]) == 1


def test_checks_termination_after_each_draw() -> None:
    item_list = [Item(id="token", name="Token"), Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["token"], amount=1)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"grant_target": 0},
        rule_list=[
            Rule(
                once=True,
                condition=CheckNode(
                    item_index=item_id_index["draw_count"],
                    op=RuntimeOpCode.GE,
                    value=3,
                    actions=[AddItem(item_index=item_id_index["target"], amount=1)],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["target"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="target reached")],
        ),
    )

    sim = CountingMonteCarlo(ctx, seed=0)
    state = sim.run_once()

    assert state.terminate is True
    assert _draw_count(state, ctx) == 3
    assert sim.termination_eval_count == 3


def test_every_draw_runs_before_main_pool_draw() -> None:
    item_list = [Item(id="first", name="First"), Item(id="second", name="Second")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[
            AddItem(item_index=item_id_index["draw_count"], amount=1),
            PoolChange(pool_index=1),
        ],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0, "second_pool": 1},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["first"], amount=1)]],
            ),
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["second"], amount=1)]],
            ),
        ],
        pool_draw_list=[DrawPool(pool_index=0), DrawPool(pool_index=1)],
        rule_id_index={},
        rule_list=[],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert int(state.acquired[item_id_index["first"]]) == 0
    assert int(state.acquired[item_id_index["second"]]) == 1


def test_initial_actions_are_visible_to_first_stage() -> None:
    item_list = [Item(id="token", name="Token"), Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[AddItem(item_index=item_id_index["token"], amount=1)],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[Pool(cdf=np.array([1.0], dtype=np.float64), actions=[[]])],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"grant_target": 0},
        rule_list=[
            Rule(
                once=True,
                condition=CheckNode(
                    item_index=item_id_index["token"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[AddItem(item_index=item_id_index["target"], amount=1)],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["target"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="target reached")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 1
    assert int(state.inventory[item_id_index["token"]]) == 1
    assert int(state.inventory[item_id_index["target"]]) == 1


def test_once_rule_executes_only_once() -> None:
    item_list = [Item(id="counter", name="Counter"), Item(id="bonus", name="Bonus")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["counter"], amount=1)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"grant_bonus": 0},
        rule_list=[
            Rule(
                once=True,
                condition=CheckNode(
                    item_index=item_id_index["counter"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[AddItem(item_index=item_id_index["bonus"], amount=1)],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=3,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 3
    assert state.rule_execute == [True]
    assert int(state.acquired[item_id_index["counter"]]) == 3
    assert int(state.acquired[item_id_index["bonus"]]) == 1


def test_per_draw_rule_executes_at_most_once_per_draw_cycle() -> None:
    item_list = [Item(id="counter", name="Counter"), Item(id="bonus", name="Bonus")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["counter"], amount=2)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"grant_bonus": 0},
        rule_list=[
            Rule(
                mode="per_draw",
                condition=CheckNode(
                    item_index=item_id_index["counter"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[
                        ReduceItem(item_index=item_id_index["counter"], amount=1),
                        AddItem(item_index=item_id_index["bonus"], amount=1),
                    ],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=3,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 3
    assert int(state.acquired[item_id_index["counter"]]) == 6
    assert int(state.reduced[item_id_index["counter"]]) == 3
    assert int(state.acquired[item_id_index["bonus"]]) == 3


def test_repeat_rule_rechecks_condition_in_same_draw_cycle() -> None:
    item_list = [Item(id="counter", name="Counter"), Item(id="bonus", name="Bonus")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["counter"], amount=3)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"grant_bonus": 0},
        rule_list=[
            Rule(
                mode="repeat",
                condition=CheckNode(
                    item_index=item_id_index["counter"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[
                        ReduceItem(item_index=item_id_index["counter"], amount=1),
                        AddItem(item_index=item_id_index["bonus"], amount=1),
                    ],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["bonus"],
            op=RuntimeOpCode.GE,
            value=3,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 1
    assert int(state.reduced[item_id_index["counter"]]) == 3
    assert int(state.acquired[item_id_index["bonus"]]) == 3


def test_pool_change_affects_next_draw() -> None:
    item_list = [Item(id="first", name="First"), Item(id="second", name="Second")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0, "second_pool": 1},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["first"], amount=1)]],
            ),
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["second"], amount=1)]],
            ),
        ],
        pool_draw_list=[DrawPool(pool_index=0), DrawPool(pool_index=1)],
        rule_id_index={"switch_pool": 0},
        rule_list=[
            Rule(
                once=True,
                condition=CheckNode(
                    item_index=item_id_index["draw_count"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[PoolChange(pool_index=1)],
                ),
            )
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=2,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 2
    assert state.main_pool_index == ctx.pool_id_index["second_pool"]
    assert int(state.acquired[item_id_index["first"]]) == 1
    assert int(state.acquired[item_id_index["second"]]) == 1


def test_or_condition_short_circuits_later_branch_actions() -> None:
    item_list = [
        Item(id="parent", name="Parent"),
        Item(id="first", name="First"),
        Item(id="second", name="Second"),
    ]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[Pool(cdf=np.array([1.0], dtype=np.float64), actions=[[]])],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={},
        rule_list=[],
        termination_tree=LogicNode(
            op=RuntimeOpCode.OR,
            actions=[AddItem(item_index=item_id_index["parent"], amount=1)],
            children=[
                CheckNode(
                    item_index=item_id_index["draw_count"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[
                        AddItem(item_index=item_id_index["first"], amount=1),
                        Termination(reason="first branch"),
                    ],
                ),
                CheckNode(
                    item_index=item_id_index["draw_count"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[AddItem(item_index=item_id_index["second"], amount=1)],
                ),
            ],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert state.terminate_reason == "first branch"
    assert int(state.acquired[item_id_index["parent"]]) == 1
    assert int(state.acquired[item_id_index["first"]]) == 1
    assert int(state.acquired[item_id_index["second"]]) == 0


def test_rule_actions_are_visible_to_later_rules_in_same_draw() -> None:
    item_list = [Item(id="counter", name="Counter"), Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(retain=0, actions=[]),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["counter"], amount=1)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={"set_counter": 0, "grant_target": 1},
        rule_list=[
            Rule(
                once=False,
                condition=CheckNode(
                    item_index=item_id_index["counter"],
                    op=RuntimeOpCode.GE,
                    value=1,
                    actions=[SetItem(item_index=item_id_index["counter"], amount=2)],
                ),
            ),
            Rule(
                once=True,
                condition=CheckNode(
                    item_index=item_id_index["counter"],
                    op=RuntimeOpCode.GE,
                    value=2,
                    actions=[AddItem(item_index=item_id_index["target"], amount=1)],
                ),
            ),
        ],
        termination_tree=CheckNode(
            item_index=item_id_index["target"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="target reached")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert _draw_count(state, ctx) == 1
    assert int(state.inventory[item_id_index["target"]]) == 1


def test_item_resolve_can_draw_bonus_pool() -> None:
    item_list = [Item(id="ticket", name="Ticket"), Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(
                retain=0,
                actions=[
                    ReduceItem(item_index=item_id_index["ticket"], amount=1),
                    DrawPool(pool_index=1),
                ],
            ),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0, "bonus_pool": 1},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["ticket"], amount=1)]],
            ),
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["target"], amount=1)]],
            ),
        ],
        pool_draw_list=[DrawPool(pool_index=0), DrawPool(pool_index=1)],
        rule_id_index={},
        rule_list=[],
        termination_tree=CheckNode(
            item_index=item_id_index["target"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="target reached")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert state.terminate is True
    assert state.terminate_reason == "target reached"
    assert int(state.inventory[item_id_index["target"]]) == 1
    assert _draw_count(state, ctx) == 1


def test_item_resolve_retains_configured_inventory() -> None:
    item_list = [Item(id="skin", name="Skin"), Item(id="coin", name="Coin")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[
            ItemResolve(
                retain=1,
                actions=[
                    ReduceItem(item_index=item_id_index["skin"], amount=1),
                    AddItem(item_index=item_id_index["coin"], amount=10),
                ],
            ),
            ItemResolve(retain=0, actions=[]),
        ],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["skin"], amount=2)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={},
        rule_list=[],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="done")],
        ),
    )

    state = MonteCarlo(ctx, seed=0).run_once()

    assert int(state.inventory[item_id_index["skin"]]) == 1
    assert int(state.acquired[item_id_index["skin"]]) == 2
    assert int(state.reduced[item_id_index["skin"]]) == 1
    assert int(state.inventory[item_id_index["coin"]]) == 10


def test_runs_real_config(sanliou_ctx: RuntimeContext) -> None:
    ctx = sanliou_ctx
    state = MonteCarlo(ctx, seed=42).run_once()

    assert state.terminate is True
    assert state.terminate_reason in {"抽中皮肤", "兑换币兑换"}
    assert _draw_count(state, ctx) > 0
    assert (
        state.inventory[ctx.item_id_index["yao_daergouzhimeng"]] >= 1
        or state.inventory[ctx.item_id_index["sanliouduihuanbi"]] >= 498
    )


def test_saves_and_loads_simulation_result(sanliou_ctx: RuntimeContext) -> None:
    ctx = sanliou_ctx
    result = simulate_until_total_draw(MonteCarlo(ctx, seed=0), target_total_draw=100)
    output = BytesIO()
    save_simulation_result(output, result)
    output.seek(0)
    restored = load_simulation_result(output)

    assert restored["total_draw"] >= 100
    assert restored["total_runs"] == len(restored["draw_count"])
    assert restored["seed"] == 0
    assert restored["lifetime_acquired"].shape[1] == len(ctx.item_list)
    assert len(restored["terminate_reasons"]) == restored["total_runs"]


def test_saves_visualize_input_json() -> None:
    result = {
        "seed": 0,
        "draw_count": np.array([4, 1, 4, 2], dtype=np.int32),
        "lifetime_acquired": np.zeros((4, 1), dtype=np.int32),
        "terminate_reasons": np.array(["skin", "exchange", "skin", "skin"], dtype="U32"),
        "total_draw": np.int64(11),
        "total_runs": np.int32(4),
    }
    output = BytesIO()

    save_visualize_input(output, result)
    data = json.loads(output.getvalue().decode("utf-8"))

    assert data["title"] is not None
    assert data["target"] is not None
    assert data["note"] is not None
    assert data["draws"] == [1, 2, 4]
    assert data["cumulative"] == [0.25, 0.5, 1.0]
    assert len(data["draws"]) == len(data["cumulative"])
    assert data["statistic"] == {
        "P5": 1,
        "P25": 1,
        "P50": 3,
        "P75": 4,
        "P95": 4,
        "MIN": 1,
        "MEAN_LEVEL": 0.5,
        "MEAN": 2,
        "MAX": 4,
        "COST": 0,
    }
    assert data["termination_reason"] == [
        {"reason": "exchange", "proportion": 25},
        {"reason": "skin", "proportion": 75},
    ]
    assert isinstance(data["timestamp"], int)


def test_parallel_simulation_merges_worker_results() -> None:
    item_list = [Item(id="target", name="Target")]
    item_list.append(Item(id="draw_count", name="Draw count"))
    item_id_index = {item.id: i for i, item in enumerate(item_list)}

    ctx = _runtime_context(
        initial_actions=[],
        every_draw_actions=[AddItem(item_index=item_id_index["draw_count"], amount=1)],
        item_id_index=item_id_index,
        draw_count_index=item_id_index["draw_count"],
        item_list=item_list,
        item_resolve_list=[ItemResolve(retain=0, actions=[])],
        pool_id_index={"begin_pool": 0},
        pool_list=[
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[[AddItem(item_index=item_id_index["target"], amount=1)]],
            )
        ],
        pool_draw_list=[DrawPool(pool_index=0)],
        rule_id_index={},
        rule_list=[],
        termination_tree=CheckNode(
            item_index=item_id_index["draw_count"],
            op=RuntimeOpCode.GE,
            value=1,
            actions=[Termination(reason="done")],
        ),
    )

    result = simulate_until_total_draw(MonteCarlo(ctx, seed=123), target_total_draw=8, workers=2)

    assert result["seed"] == 123
    assert result["total_draw"] == 8
    assert result["total_runs"] == 8
    assert result["draw_count"].tolist() == [1] * 8
    assert result["lifetime_acquired"].shape == (8, 2)
    assert result["terminate_reasons"].tolist() == ["done"] * 8
