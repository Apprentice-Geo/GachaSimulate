from __future__ import annotations

import sys
import unittest
from pathlib import Path

from gacha_sim.core.builder import runtime_builder
from gacha_sim.core.engine import montecarlo
from gacha_sim.core.runtime import (
    AddItem,
    CheckNode,
    DrawPool,
    Item,
    Pool,
    RuntimeContext,
    Stage,
    Termination,
)

ROOT = Path(__file__).resolve().parents[1]

class BuilderWuxiangTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config_path = ROOT / "configs" / "sunwukong_wuxiang" / "config.json"
        self.termination_paths = [
            ROOT / "configs" / "sunwukong_wuxiang" / "termination_all.json",
            ROOT / "configs" / "sunwukong_wuxiang" / "termination_all_exchange.json",
            ROOT / "configs" / "sunwukong_wuxiang" / "termination_skin.json",
            ROOT / "configs" / "sunwukong_wuxiang" / "termination_skin_exchange.json",
        ]

    def test_builder_compiles_all_wuxiang_terminations(self) -> None:
        for termination_path in self.termination_paths:
            with self.subTest(termination_path=termination_path.name):
                builder = runtime_builder(str(self.config_path), str(termination_path))
                ctx = builder.build()

                self.assertIsInstance(ctx, RuntimeContext)
                self.assertGreater(len(ctx.item_list), 0)
                self.assertGreater(len(ctx.pool_list), 0)
                self.assertGreater(len(ctx.draw_stage_list), 0)
                self.assertIsNotNone(ctx.termination_tree)
                self.assertIn("sunwukong_wuxiang", ctx.item_id_index)
                self.assertIn("random_skin", ctx.item_id_index)
                self.assertIn("begin_pool", ctx.pool_id_index)
                self.assertEqual(
                    ctx.item_draw_list[ctx.item_id_index["random_skin"]][
                        0
                    ].__class__.__name__,
                    "DrawPool",
                )

    def test_builder_compiles_wuxiang_termination_all(self) -> None:
        builder = runtime_builder(
            str(self.config_path),
            str(ROOT / "configs" / "sunwukong_wuxiang" / "termination_all.json"),
        )
        ctx = builder.build()

        self.assertIsInstance(ctx, RuntimeContext)
        self.assertGreater(len(ctx.item_list), 0)
        self.assertGreater(len(ctx.pool_list), 0)
        self.assertGreater(len(ctx.draw_stage_list), 0)
        self.assertIsNotNone(ctx.termination_tree)
        self.assertIn("sunwukong_wuxiang", ctx.item_id_index)
        self.assertIn("random_skin", ctx.item_id_index)
        self.assertIn("begin_pool", ctx.pool_id_index)
        self.assertEqual(
            ctx.item_draw_list[ctx.item_id_index["random_skin"]][
                0
            ].__class__.__name__,
            "DrawPool",
        )

if __name__ == "__main__":
    unittest.main()
