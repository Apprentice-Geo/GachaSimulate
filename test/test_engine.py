from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from builder import runtime_builder
from engine import montecarlo
from runtime import (
    AddItem,
    CheckNode,
    DrawPool,
    Item,
    Pool,
    RuntimeContext,
    Stage,
    Termination,
)


class CountingMonteCarlo(montecarlo):
    def __init__(self, ctx: RuntimeContext, seed=None):
        super().__init__(ctx, seed=seed)
        self.termination_eval_count = 0

    def _eval_condition(self, node, state):
        if node is self.ctx.termination_tree:
            self.termination_eval_count += 1
        return super()._eval_condition(node, state)


class EngineUnitTest(unittest.TestCase):
    def test_engine_runs_with_manual_context(self) -> None:
        item_list = [
            Item(id="token", name="Token"),
            Item(id="target", name="Target"),
        ]
        item_id_index = {item.id: i for i, item in enumerate(item_list)}

        pool_list = [
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[AddItem(item_index=item_id_index["target"], amount=1)],
            )
        ]

        ctx = RuntimeContext(
            rmb_per_roll=10,
            begin_pool_index=0,
            item_id_index=item_id_index,
            item_list=item_list,
            item_resolve_list=[[], []],
            item_draw_list=[[], []],
            pool_id_index={"begin_pool": 0},
            pool_list=pool_list,
            pool_draw_list=[DrawPool(pool_index=0)],
            draw_stage_id_index={},
            draw_stage_list=[],
            protected_items_index=[],
            termination_tree=CheckNode(
                subject="item",
                id="target",
                op=">=",
                value=1,
                actions=[Termination(reason="target reached")],
            ),
        )

        sim = montecarlo(ctx, seed=0)
        state = sim.run_once()

        self.assertTrue(state.terminate)
        self.assertEqual(state.terminate_reason, "target reached")
        self.assertEqual(state.draw_count, 1)
        self.assertEqual(state.rmb_cost, 10)
        self.assertEqual(int(state.inventory[item_id_index["target"]]), 1)


class EngineIntegrationTest(unittest.TestCase):
    def test_termination_checked_only_after_protected_changes(self) -> None:
        item_list = [
            Item(id="token", name="Token"),
            Item(id="target", name="Target"),
        ]
        item_id_index = {item.id: i for i, item in enumerate(item_list)}

        pool_list = [
            Pool(
                cdf=np.array([1.0], dtype=np.float64),
                actions=[AddItem(item_index=item_id_index["token"], amount=1)],
            )
        ]

        ctx = RuntimeContext(
            rmb_per_roll=10,
            begin_pool_index=0,
            item_id_index=item_id_index,
            item_list=item_list,
            item_resolve_list=[[], []],
            item_draw_list=[[], []],
            pool_id_index={"begin_pool": 0},
            pool_list=pool_list,
            pool_draw_list=[DrawPool(pool_index=0)],
            draw_stage_id_index={"grant_target": 0},
            draw_stage_list=[
                Stage(
                    once=True,
                    condition=CheckNode(
                        subject="draw_count",
                        id="",
                        op=">=",
                        value=3,
                        actions=[AddItem(item_index=item_id_index["target"], amount=1)],
                    ),
                )
            ],
            protected_items_index=[item_id_index["target"]],
            termination_tree=CheckNode(
                subject="item",
                id="target",
                op=">=",
                value=1,
                actions=[Termination(reason="target reached")],
            ),
        )

        sim = CountingMonteCarlo(ctx, seed=0)
        state = sim.run_once()

        self.assertTrue(state.terminate)
        self.assertEqual(state.draw_count, 3)
        self.assertEqual(sim.termination_eval_count, 1)

    def test_engine_runs_with_wuxiang_builder_output(self) -> None:
        config_path = ROOT / "configs" / "sunwukong_wuxiang" / "config.json"
        termination_path = (
            ROOT / "configs" / "sunwukong_wuxiang" / "termination_skin.json"
        )

        builder = runtime_builder(str(config_path), str(termination_path))
        ctx = builder.build()

        sim = montecarlo(ctx, seed=42)
        state = sim.run_once()

        self.assertTrue(state.terminate)
        self.assertIn(state.terminate_reason, {"skin obtained", "point exchange"})
        self.assertGreater(state.draw_count, 0)
        self.assertGreater(state.rmb_cost, 0)


if __name__ == "__main__":
    unittest.main()
