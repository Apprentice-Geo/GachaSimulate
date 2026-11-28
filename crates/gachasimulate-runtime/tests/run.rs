use gachasimulate_runtime::{run_single_deterministic, MAX_FRAME_DEPTH, MAX_RUN_STEPS};
use gachasimulate_types::{
    fixtures::{deterministic_program, DETERMINISTIC_RECORD},
    Action::{self, AddItem, Change, Draw, ReduceItem, SetItem, Terminate},
    ActionRange, Comparison, CompiledProgram, ConditionNode, ConfigItem, ItemResolve, LogicOp,
    Pool, PoolEntry, ResultRecord, Rule, RuleMode, SimulationError,
};

fn empty_program() -> CompiledProgram {
    let mut program = deterministic_program();
    program.actions.clear();
    program.initial = ActionRange::EMPTY;
    program.every_draw = ActionRange::EMPTY;
    program.pool_entries[0].actions = ActionRange::EMPTY;
    program.condition_nodes.clear();
    program.termination_condition = check(&mut program, 0, Comparison::Lt, 0, &[]);
    program
}

fn actions(program: &mut CompiledProgram, actions: &[Action]) -> ActionRange {
    let begin = program.actions.len() as u32;
    program.actions.extend_from_slice(actions);
    ActionRange::new(begin, actions.len() as u32)
}

fn check(
    program: &mut CompiledProgram,
    item: u32,
    op: Comparison,
    value: i64,
    on_match: &[Action],
) -> u32 {
    let id = program.condition_nodes.len() as u32;
    let actions = actions(program, on_match);
    program.condition_nodes.push(ConditionNode::Check {
        item,
        op,
        value,
        actions,
    });
    id
}

fn logic(program: &mut CompiledProgram, op: LogicOp, children: &[u32], on_match: &[Action]) -> u32 {
    let id = program.condition_nodes.len() as u32;
    let begin = program.condition_children.len() as u32;
    program.condition_children.extend_from_slice(children);
    let actions = actions(program, on_match);
    program.condition_nodes.push(ConditionNode::Logic {
        op,
        children: ActionRange::new(begin, children.len() as u32),
        actions,
    });
    id
}

fn item(program: &mut CompiledProgram, id: &str) -> u32 {
    let index = program.items.len() as u32;
    program.items.push(ConfigItem {
        id: id.into(),
        name: id.into(),
    });
    program.item_resolves.push(None);
    index
}

fn pool(program: &mut CompiledProgram, id: &str, on_draw: &[Action]) -> u32 {
    let index = program.pools.len() as u32;
    program.pools.push(Pool {
        id: id.into(),
        entries: ActionRange::new(program.pool_entries.len() as u32, 1),
    });
    let actions = actions(program, on_draw);
    program.pool_entries.push(PoolEntry {
        threshold: 1.0,
        actions,
    });
    index
}

fn assert_result(program: &CompiledProgram, value: u64, reason_index: u32) {
    assert_eq!(
        run_single_deterministic(program, -5, 17).unwrap(),
        ResultRecord {
            value,
            reason_index
        }
    );
}

#[test]
fn shared_deterministic_fixture() {
    let program = deterministic_program();
    for (seed, run_index) in [(0, 0), (-5, 17), (i64::MIN, u64::MAX)] {
        assert_eq!(
            run_single_deterministic(&program, seed, run_index).unwrap(),
            DETERMINISTIC_RECORD
        );
    }
}

#[test]
fn draw_order_and_pool_changes() {
    let mut program = empty_program();
    let draws = item(&mut program, "draws");
    let next = pool(
        &mut program,
        "next",
        &[AddItem {
            item: 0,
            amount: 100,
        }],
    );
    let bonus = pool(
        &mut program,
        "bonus",
        &[AddItem {
            item: 0,
            amount: 10,
        }],
    );
    program.initial = actions(&mut program, &[SetItem { item: 0, amount: 1 }]);
    program.every_draw = actions(
        &mut program,
        &[
            AddItem {
                item: draws,
                amount: 1,
            },
            Draw { pool: bonus },
        ],
    );
    program.pool_entries[0].actions = actions(
        &mut program,
        &[AddItem { item: 0, amount: 2 }, Change { pool: next }],
    );
    program.termination_condition = check(
        &mut program,
        draws,
        Comparison::Ge,
        2,
        &[Terminate { reason: 0 }],
    );
    assert_result(&program, 123, 0);

    program.every_draw = actions(
        &mut program,
        &[
            AddItem {
                item: draws,
                amount: 1,
            },
            Draw { pool: bonus },
            Change { pool: next },
        ],
    );
    assert_result(&program, 221, 0);
}

#[test]
fn rules_use_declaration_order_and_mode() {
    let mut program = empty_program();
    let draws = item(&mut program, "draws");
    let tickets = item(&mut program, "tickets");
    program.every_draw = actions(
        &mut program,
        &[AddItem {
            item: draws,
            amount: 1,
        }],
    );
    program.pool_entries[0].actions = actions(
        &mut program,
        &[SetItem {
            item: tickets,
            amount: 3,
        }],
    );
    let once = check(
        &mut program,
        draws,
        Comparison::Ge,
        2,
        &[AddItem {
            item: 0,
            amount: 100,
        }],
    );
    let per_draw = check(
        &mut program,
        draws,
        Comparison::Ge,
        1,
        &[
            AddItem {
                item: 0,
                amount: 10,
            },
            AddItem {
                item: tickets,
                amount: 1,
            },
        ],
    );
    let repeat = check(
        &mut program,
        tickets,
        Comparison::Gt,
        0,
        &[
            ReduceItem {
                item: tickets,
                amount: 1,
            },
            AddItem { item: 0, amount: 1 },
        ],
    );
    let after_repeat = check(
        &mut program,
        tickets,
        Comparison::Eq,
        0,
        &[AddItem {
            item: 0,
            amount: 1000,
        }],
    );
    program.rules = [
        ("once", RuleMode::Once, once),
        ("per_draw", RuleMode::PerDraw, per_draw),
        ("repeat", RuleMode::Repeat, repeat),
        ("after_repeat", RuleMode::PerDraw, after_repeat),
    ]
    .map(|(id, mode, condition)| Rule {
        id: id.into(),
        mode,
        condition,
    })
    .into();
    program.termination_condition = check(
        &mut program,
        draws,
        Comparison::Eq,
        3,
        &[Terminate { reason: 0 }],
    );
    assert_result(&program, 3142, 0);
}

#[test]
fn conditions_collect_parent_first_and_roll_back_failed_branches() {
    let mut program = empty_program();
    program.reasons = vec!["done".into(), "unexpected".into()];
    let wrong = [Terminate { reason: 1 }];
    let true_but_rejected = check(&mut program, 0, Comparison::Le, 0, &wrong);
    let false_node = check(&mut program, 0, Comparison::Ne, 0, &wrong);
    let rejected = logic(
        &mut program,
        LogicOp::And,
        &[true_but_rejected, false_node],
        &wrong,
    );
    let first_match = check(
        &mut program,
        0,
        Comparison::Eq,
        0,
        &[AddItem { item: 0, amount: 3 }],
    );
    let any = logic(
        &mut program,
        LogicOp::Or,
        &[rejected, first_match, true_but_rejected],
        &[SetItem {
            item: 0,
            amount: 20,
        }],
    );
    let all = check(
        &mut program,
        0,
        Comparison::Ge,
        0,
        &[AddItem { item: 0, amount: 4 }, Terminate { reason: 0 }],
    );
    // Evaluating the second child must still see the original score.
    let sees_original = check(&mut program, 0, Comparison::Eq, 0, &[]);
    program.termination_condition = logic(
        &mut program,
        LogicOp::And,
        &[any, sees_original, all],
        &[SetItem {
            item: 0,
            amount: 10,
        }],
    );
    assert_result(&program, 27, 0);
}

#[test]
fn logic_short_circuits_without_visiting_later_nodes() {
    let mut program = empty_program();
    let false_node = program.termination_condition;
    let true_node = check(&mut program, 0, Comparison::Eq, 0, &[]);
    let mut expensive = true_node;
    // Expanding this valid shared subtree consumes more than the run budget.
    for _ in 0..20 {
        expensive = logic(&mut program, LogicOp::And, &[expensive, expensive], &[]);
    }
    let failed_and = logic(&mut program, LogicOp::And, &[false_node, expensive], &[]);
    program.termination_condition = logic(
        &mut program,
        LogicOp::Or,
        &[failed_and, true_node, expensive],
        &[Terminate { reason: 0 }],
    );
    assert_result(&program, 0, 0);

    program.termination_condition = expensive;
    assert!(matches!(
        run_single_deterministic(&program, -5, 17),
        Err(SimulationError::StepLimitExceeded { run_index: 17 })
    ));
}

#[test]
fn set_and_add_resolve_batches_immediately_with_nested_draws() {
    let mut program = empty_program();
    let boxes = item(&mut program, "boxes");
    let reward = pool(&mut program, "reward", &[AddItem { item: 0, amount: 5 }]);
    let unbox = pool(&mut program, "unbox", &[Draw { pool: reward }]);
    let resolve = actions(
        &mut program,
        &[
            ReduceItem {
                item: boxes,
                amount: 3,
            },
            Draw { pool: unbox },
        ],
    );
    program.item_resolves[boxes as usize] = Some(ItemResolve {
        retain: 2,
        reduce_per_batch: 3,
        actions: resolve,
    });
    program.initial = actions(
        &mut program,
        &[
            SetItem {
                item: boxes,
                amount: 9,
            }, // 2 batches
            ReduceItem { item: 0, amount: 1 },
            AddItem {
                item: boxes,
                amount: 2,
            }, // 1 batch
        ],
    );
    program.termination_condition = check(
        &mut program,
        boxes,
        Comparison::Eq,
        2,
        &[Terminate { reason: 0 }],
    );
    assert_result(&program, 14, 0);

    // Both resolver calls must occur before this assignment.
    program.actions[program.initial.begin as usize + 1] = SetItem { item: 0, amount: 1 };
    assert_result(&program, 6, 0);
}

#[test]
fn terminate_truncates_nested_draws_resolver_batches_and_collected_actions() {
    let mut program = empty_program();
    program.reasons = vec!["later".into(), "nested".into()];
    let boxes = item(&mut program, "boxes");
    let reward = pool(
        &mut program,
        "reward",
        &[
            AddItem { item: 0, amount: 5 },
            Terminate { reason: 1 },
            AddItem {
                item: 0,
                amount: 10,
            },
        ],
    );
    let resolve = actions(
        &mut program,
        &[
            ReduceItem {
                item: boxes,
                amount: 1,
            },
            Draw { pool: reward },
            AddItem {
                item: 0,
                amount: 20,
            },
        ],
    );
    program.item_resolves[boxes as usize] = Some(ItemResolve {
        retain: 0,
        reduce_per_batch: 1,
        actions: resolve,
    });
    let child = check(
        &mut program,
        0,
        Comparison::Eq,
        0,
        &[
            SetItem {
                item: 0,
                amount: 99,
            },
            Terminate { reason: 0 },
        ],
    );
    program.termination_condition = logic(
        &mut program,
        LogicOp::And,
        &[child],
        &[
            SetItem {
                item: boxes,
                amount: 3,
            },
            AddItem {
                item: 0,
                amount: 40,
            },
        ],
    );
    assert_result(&program, 5, 1);
}

#[test]
fn early_termination_skips_later_stages() {
    let mut program = deterministic_program();
    let term = ActionRange::new(3, 1);
    program.every_draw = term;
    assert_result(&program, 1, 0);
    program.initial = term;
    assert_result(&program, 0, 0);

    program.initial = ActionRange::new(0, 1);
    program.every_draw = ActionRange::new(1, 1);
    program.pool_entries[0].actions = term;
    let would_fail = check(
        &mut program,
        0,
        Comparison::Ge,
        0,
        &[AddItem {
            item: 0,
            amount: i64::MAX,
        }],
    );
    program.rules.push(Rule {
        id: "late".into(),
        mode: RuleMode::PerDraw,
        condition: would_fail,
    });
    program.termination_condition = would_fail;
    assert_result(&program, 2, 0);

    program.pool_entries[0].actions = ActionRange::new(2, 1);
    let stop_first = check(
        &mut program,
        0,
        Comparison::Ge,
        0,
        &[Terminate { reason: 0 }],
    );
    program.rules.insert(
        0,
        Rule {
            id: "first".into(),
            mode: RuleMode::Repeat,
            condition: stop_first,
        },
    );
    assert_result(&program, 3, 0);
}

#[test]
fn action_budget_accepts_exactly_the_limit() {
    let mut program = empty_program();
    let boxes = item(&mut program, "boxes");
    let resolve = actions(
        &mut program,
        &[
            ReduceItem {
                item: boxes,
                amount: 1,
            },
            Draw { pool: 0 },
        ],
    );
    program.item_resolves[boxes as usize] = Some(ItemResolve {
        retain: 0,
        reduce_per_batch: 1,
        actions: resolve,
    });
    let batches = (MAX_RUN_STEPS as i64 - 2) / 2;
    program.initial = actions(
        &mut program,
        &[
            SetItem {
                item: boxes,
                amount: batches,
            },
            Terminate { reason: 0 },
        ],
    );
    assert_result(&program, 0, 0);

    program.actions[program.initial.begin as usize] = SetItem {
        item: boxes,
        amount: batches + 1,
    };
    assert!(matches!(
        run_single_deterministic(&program, 0, 18),
        Err(SimulationError::StepLimitExceeded { run_index: 18 })
    ));
}

#[test]
fn frame_depth_accepts_exactly_the_limit() {
    let mut program = empty_program();
    program.pool_entries[0].actions = actions(&mut program, &[Draw { pool: 1 }]);
    for index in 1..MAX_FRAME_DEPTH - 1 {
        pool(
            &mut program,
            &format!("pool_{index}"),
            &[Draw {
                pool: index as u32 + 1,
            }],
        );
    }
    let last = pool(&mut program, "last", &[Terminate { reason: 0 }]);
    assert_result(&program, 0, 0);

    let extra = pool(&mut program, "extra", &[Terminate { reason: 0 }]);
    let range = program.pool_entries[last as usize].actions;
    program.actions[range.begin as usize] = Draw { pool: extra };
    assert!(matches!(
        run_single_deterministic(&program, 0, 23),
        Err(SimulationError::FrameDepthLimitExceeded { run_index: 23 })
    ));
}

#[test]
fn checked_inventory_and_result_conversion() {
    let mut program = empty_program();
    for overflow_actions in [
        [
            SetItem {
                item: 0,
                amount: i64::MAX,
            },
            AddItem { item: 0, amount: 1 },
            Terminate { reason: 0 },
        ],
        [
            ReduceItem {
                item: 0,
                amount: i64::MAX,
            },
            ReduceItem { item: 0, amount: 2 },
            Terminate { reason: 0 },
        ],
    ] {
        program.initial = actions(&mut program, &overflow_actions);
        assert!(matches!(
            run_single_deterministic(&program, 0, 29),
            Err(SimulationError::InventoryOverflow {
                run_index: 29,
                item: 0
            })
        ));
    }
    program.initial = actions(
        &mut program,
        &[ReduceItem { item: 0, amount: 2 }, Terminate { reason: 0 }],
    );
    assert!(matches!(
        run_single_deterministic(&program, 0, 31),
        Err(SimulationError::NegativeResultItem {
            run_index: 31,
            value: -2
        })
    ));
}

#[test]
fn validates_program_before_running() {
    let mut program = deterministic_program();
    program.pool_entries[0].threshold = 0.75;
    assert!(matches!(
        run_single_deterministic(&program, 0, 0),
        Err(SimulationError::InvalidProgram(_))
    ));
}
