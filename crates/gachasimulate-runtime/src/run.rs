use std::sync::atomic::{AtomicU64, Ordering};

use gachasimulate_types::{Action, ActionRange, Comparison, ConditionNode, LogicOp, RuleMode};

use crate::{
    rng::RunRng, CancelToken, CompiledProgram, ResultRecord, SimulationError, MAX_FRAME_DEPTH,
    MAX_RUN_STEPS,
};

const CANCEL_CHECK_INTERVAL: u64 = 4096;

#[derive(Clone, Copy)]
pub(crate) struct RunControl<'a> {
    pub cancel: &'a CancelToken,
    pub stop_at: Option<&'a AtomicU64>,
}

impl RunControl<'_> {
    fn check(self, run_index: u64) -> Result<(), SimulationError> {
        if self.cancel.is_cancelled()
            || self
                .stop_at
                .is_some_and(|stop_at| run_index >= stop_at.load(Ordering::Relaxed))
        {
            return Err(SimulationError::Cancelled);
        }
        Ok(())
    }
}

struct Frame {
    range: ActionRange,
    offset: u32,
    repeats: u64,
}

pub(crate) struct Scratch {
    inventory: Vec<i64>,
    once_fired: Vec<bool>,
    frames: Vec<Frame>,
    collected_actions: Vec<ActionRange>,
}

impl Scratch {
    pub(crate) fn new(program: &CompiledProgram) -> Self {
        Self {
            inventory: vec![0; program.items.len()],
            once_fired: vec![false; program.rules.len()],
            frames: Vec::new(),
            collected_actions: Vec::new(),
        }
    }

    pub(crate) fn run(
        &mut self,
        program: &CompiledProgram,
        seed: i64,
        run_index: u64,
        control: Option<RunControl<'_>>,
    ) -> Result<ResultRecord, SimulationError> {
        if let Some(control) = control {
            control.check(run_index)?;
        }
        self.inventory.fill(0);
        self.once_fired.fill(false);
        self.frames.clear();
        self.collected_actions.clear();
        Run {
            program,
            scratch: self,
            rng: RunRng::new(seed, run_index),
            run_index,
            control,
            pool: 0,
            stop: false,
            reason: 0,
            steps: 0,
        }
        .execute()
    }
}

struct Run<'a> {
    program: &'a CompiledProgram,
    scratch: &'a mut Scratch,
    rng: RunRng,
    run_index: u64,
    control: Option<RunControl<'a>>,
    pool: u32,
    stop: bool,
    reason: u32,
    steps: u64,
}

impl Run<'_> {
    fn execute(mut self) -> Result<ResultRecord, SimulationError> {
        self.execute_actions(self.program.initial)?;
        while !self.stop {
            self.execute_actions(self.program.every_draw)?;
            if self.stop {
                break;
            }
            let actions = self.draw(self.pool);
            self.execute_actions(actions)?;
            for (index, rule) in self.program.rules.iter().enumerate() {
                if self.stop {
                    break;
                }
                if rule.mode == RuleMode::Once && self.scratch.once_fired[index] {
                    continue;
                }
                while self.matches(rule.condition)? {
                    if rule.mode == RuleMode::Once {
                        self.scratch.once_fired[index] = true;
                    }
                    self.execute_collected()?;
                    if self.stop || rule.mode != RuleMode::Repeat {
                        break;
                    }
                }
            }
            if !self.stop && self.matches(self.program.termination_condition)? {
                self.execute_collected()?;
            }
        }

        let value = self.scratch.inventory[self.program.result_item as usize];
        Ok(ResultRecord {
            value: u64::try_from(value).map_err(|_| SimulationError::NegativeResultItem {
                run_index: self.run_index,
                value,
            })?,
            reason_index: self.reason,
        })
    }

    fn step(&mut self) -> Result<(), SimulationError> {
        self.steps += 1;
        if self.steps > MAX_RUN_STEPS {
            return Err(SimulationError::StepLimitExceeded {
                run_index: self.run_index,
            });
        }
        if self.steps.is_multiple_of(CANCEL_CHECK_INTERVAL) {
            if let Some(control) = self.control {
                control.check(self.run_index)?;
            }
        }
        Ok(())
    }

    fn draw(&mut self, pool: u32) -> ActionRange {
        let entries = self.program.pools[pool as usize]
            .entries
            .get(&self.program.pool_entries)
            .expect("validated pool entry range");
        entries[self.rng.entry_index(entries)].actions
    }

    fn matches(&mut self, condition: u32) -> Result<bool, SimulationError> {
        self.scratch.collected_actions.clear();
        self.collect_condition_actions(condition)
    }

    // Program validation bounds condition recursion depth. Each failed child
    // rolls back its own ranges before returning to its parent.
    fn collect_condition_actions(&mut self, condition: u32) -> Result<bool, SimulationError> {
        self.step()?;
        let start = self.scratch.collected_actions.len();
        let matched = match self.program.condition_nodes[condition as usize] {
            ConditionNode::Check {
                item,
                op,
                value,
                actions,
            } => {
                let inventory = self.scratch.inventory[item as usize];
                let matched = match op {
                    Comparison::Eq => inventory == value,
                    Comparison::Ne => inventory != value,
                    Comparison::Lt => inventory < value,
                    Comparison::Le => inventory <= value,
                    Comparison::Gt => inventory > value,
                    Comparison::Ge => inventory >= value,
                };
                if matched && actions.count != 0 {
                    self.scratch.collected_actions.push(actions);
                }
                matched
            }
            ConditionNode::Logic {
                op,
                children,
                actions,
            } => {
                if actions.count != 0 {
                    self.scratch.collected_actions.push(actions);
                }
                let children = children
                    .get(&self.program.condition_children)
                    .expect("validated condition child range");
                // AND stops on false, OR on true.
                let short_circuit = op == LogicOp::Or;
                let mut matched = !short_circuit;
                for &child in children {
                    if self.collect_condition_actions(child)? == short_circuit {
                        matched = short_circuit;
                        break;
                    }
                }
                matched
            }
        };
        if !matched {
            self.scratch.collected_actions.truncate(start);
        }
        Ok(matched)
    }

    fn execute_collected(&mut self) -> Result<(), SimulationError> {
        for index in 0..self.scratch.collected_actions.len() {
            self.execute_actions(self.scratch.collected_actions[index])?;
            if self.stop {
                break;
            }
        }
        Ok(())
    }

    fn push_frame(&mut self, range: ActionRange, repeats: u64) -> Result<(), SimulationError> {
        if self.scratch.frames.len() >= MAX_FRAME_DEPTH {
            return Err(SimulationError::FrameDepthLimitExceeded {
                run_index: self.run_index,
            });
        }
        self.scratch.frames.push(Frame {
            range,
            offset: 0,
            repeats,
        });
        Ok(())
    }

    fn enqueue_resolve(&mut self, item: usize) -> Result<(), SimulationError> {
        if let Some(resolve) = self.program.item_resolves[item] {
            let surplus = i128::from(self.scratch.inventory[item]) - i128::from(resolve.retain);
            if surplus > 0 {
                let batches = surplus as u64 / resolve.reduce_per_batch;
                if batches > 0 {
                    self.push_frame(resolve.actions, batches)?;
                }
            }
        }
        Ok(())
    }

    fn execute_actions(&mut self, actions: ActionRange) -> Result<(), SimulationError> {
        if actions.count == 0 {
            return Ok(());
        }
        self.push_frame(actions, 1)?;
        while let Some(frame) = self.scratch.frames.last_mut() {
            if frame.offset == frame.range.count {
                frame.repeats -= 1;
                if frame.repeats == 0 {
                    self.scratch.frames.pop();
                } else {
                    frame.offset = 0;
                }
                continue;
            }

            let index = (frame.range.begin + frame.offset) as usize;
            frame.offset += 1;
            self.step()?;
            let overflow = |item| SimulationError::InventoryOverflow {
                run_index: self.run_index,
                item,
            };
            match self.program.actions[index] {
                Action::AddItem { item, amount } => {
                    let inventory = &mut self.scratch.inventory[item as usize];
                    *inventory = inventory
                        .checked_add(amount)
                        .ok_or_else(|| overflow(item))?;
                    self.enqueue_resolve(item as usize)?;
                }
                Action::ReduceItem { item, amount } => {
                    let inventory = &mut self.scratch.inventory[item as usize];
                    *inventory = inventory
                        .checked_sub(amount)
                        .ok_or_else(|| overflow(item))?;
                }
                Action::SetItem { item, amount } => {
                    self.scratch.inventory[item as usize] = amount;
                    self.enqueue_resolve(item as usize)?;
                }
                Action::Draw { pool } => {
                    let actions = self.draw(pool);
                    self.push_frame(actions, 1)?;
                }
                Action::Change { pool } => self.pool = pool,
                Action::Terminate { reason } => {
                    self.stop = true;
                    self.reason = reason;
                    self.scratch.frames.clear();
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use gachasimulate_types::fixtures::deterministic_program;

    use super::*;

    #[test]
    fn an_active_run_observes_cancellation_at_its_next_step_checkpoint() {
        let program = deterministic_program();
        let mut scratch = Scratch::new(&program);
        let cancel = CancelToken::new();
        let mut run = Run {
            program: &program,
            scratch: &mut scratch,
            rng: RunRng::new(0, 0),
            run_index: 0,
            control: Some(RunControl {
                cancel: &cancel,
                stop_at: None,
            }),
            pool: 0,
            stop: false,
            reason: 0,
            steps: CANCEL_CHECK_INTERVAL - 2,
        };
        run.step().unwrap();
        cancel.cancel();
        assert!(matches!(run.step(), Err(SimulationError::Cancelled)));
    }
}
