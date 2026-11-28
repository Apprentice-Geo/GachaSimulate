use std::collections::HashSet;

use thiserror::Error;

use crate::{
    is_identifier, ConfigItem, GSR_HEADER_BYTES, MAX_GSR_METADATA_BYTES, MAX_REASONS,
    MAX_STRING_BYTES,
};

pub const MAX_CONDITION_DEPTH: usize = 256;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActionRange {
    pub begin: u32,
    pub count: u32,
}

impl ActionRange {
    pub const EMPTY: Self = Self::new(0, 0);

    pub const fn new(begin: u32, count: u32) -> Self {
        Self { begin, count }
    }

    /// Resolves a contiguous slice in the arena appropriate to the field.
    pub fn get<T>(self, arena: &[T]) -> Option<&[T]> {
        let end = self.begin.checked_add(self.count)?;
        arena.get(self.begin as usize..end as usize)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    AddItem { item: u32, amount: i64 },
    ReduceItem { item: u32, amount: i64 },
    SetItem { item: u32, amount: i64 },
    Draw { pool: u32 },
    Change { pool: u32 },
    Terminate { reason: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool {
    pub id: String,
    pub entries: ActionRange,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoolEntry {
    pub threshold: f64,
    pub actions: ActionRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub mode: RuleMode,
    pub condition: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleMode {
    Once,
    PerDraw,
    Repeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionNode {
    Check {
        item: u32,
        op: Comparison,
        value: i64,
        actions: ActionRange,
    },
    Logic {
        op: LogicOp,
        children: ActionRange,
        actions: ActionRange,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicOp {
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ItemResolve {
    pub retain: i64,
    pub reduce_per_batch: u64,
    pub actions: ActionRange,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledProgram {
    pub result_item: u32,
    pub items: Vec<ConfigItem>,
    /// Unique, non-empty reasons in ascending UTF-8 byte order.
    pub reasons: Vec<String>,
    pub actions: Vec<Action>,
    pub pools: Vec<Pool>,
    pub pool_entries: Vec<PoolEntry>,
    pub rules: Vec<Rule>,
    pub condition_nodes: Vec<ConditionNode>,
    pub condition_children: Vec<u32>,
    pub item_resolves: Vec<Option<ItemResolve>>,
    pub initial: ActionRange,
    pub every_draw: ActionRange,
    pub termination_condition: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProgramInvariantError {
    #[error("{field}: {message}")]
    InvalidField {
        field: &'static str,
        message: &'static str,
    },
    #[error("{table}[{index}]: {message}")]
    InvalidEntry {
        table: &'static str,
        index: usize,
        message: &'static str,
    },
}

fn field(field: &'static str, message: &'static str) -> ProgramInvariantError {
    ProgramInvariantError::InvalidField { field, message }
}

fn entry(table: &'static str, index: usize, message: &'static str) -> ProgramInvariantError {
    ProgramInvariantError::InvalidEntry {
        table,
        index,
        message,
    }
}

fn validate_ids<'a>(
    table: &'static str,
    ids: impl Iterator<Item = &'a str>,
) -> Result<(), ProgramInvariantError> {
    let mut seen = HashSet::new();
    for (index, id) in ids.enumerate() {
        if !is_identifier(id) {
            return Err(entry(table, index, "invalid identifier"));
        }
        if !seen.insert(id) {
            return Err(entry(table, index, "duplicate identifier"));
        }
    }
    Ok(())
}

impl CompiledProgram {
    /// Checks arena structure and references before execution. The compiler
    /// proves the source-level rules for repeat exits, termination paths, and
    /// synchronous pool/resolver calls.
    pub fn validate_invariants(&self) -> Result<(), ProgramInvariantError> {
        if self.items.is_empty() {
            return Err(field("items", "must be non-empty"));
        }
        if self.pools.is_empty() {
            return Err(field("pools", "must be non-empty"));
        }
        if self.result_item as usize >= self.items.len() {
            return Err(field("result_item", "item index is out of bounds"));
        }
        validate_ids("items", self.items.iter().map(|item| item.id.as_str()))?;
        for (index, item) in self.items.iter().enumerate() {
            if item.id.len() > MAX_STRING_BYTES
                || item.name.is_empty()
                || item.name.len() > MAX_STRING_BYTES
            {
                return Err(entry("items", index, "invalid item ID or name length"));
            }
        }
        if self.reasons.is_empty() || self.reasons.len() > MAX_REASONS {
            return Err(field("reasons", "invalid reason count"));
        }
        let selected_item = &self.items[self.result_item as usize];
        let mut header_bytes = u64::from(GSR_HEADER_BYTES)
            + selected_item.id.len() as u64
            + selected_item.name.len() as u64;
        for (index, reason) in self.reasons.iter().enumerate() {
            if reason.is_empty() || reason.len() > MAX_STRING_BYTES {
                return Err(entry("reasons", index, "invalid reason length"));
            }
            if index > 0 && self.reasons[index - 1] >= *reason {
                return Err(entry("reasons", index, "must be sorted and unique"));
            }
            header_bytes = header_bytes
                .checked_add(4 + reason.len() as u64)
                .ok_or_else(|| field("reasons", "encoded GSR header metadata exceeds limit"))?;
            if header_bytes > MAX_GSR_METADATA_BYTES {
                return Err(field(
                    "reasons",
                    "encoded GSR header metadata exceeds 64 MiB limit",
                ));
            }
        }

        self.validate_actions()?;
        self.validate_pools()?;
        self.validate_conditions()?;
        self.validate_resolves()?;

        validate_ids("rules", self.rules.iter().map(|rule| rule.id.as_str()))?;
        for (index, rule) in self.rules.iter().enumerate() {
            let node = self
                .condition_nodes
                .get(rule.condition as usize)
                .ok_or_else(|| entry("rules", index, "condition index is out of bounds"))?;
            if rule.mode == RuleMode::Repeat && !matches!(node, ConditionNode::Check { .. }) {
                return Err(entry("rules", index, "repeat requires a check condition"));
            }
        }
        if self.termination_condition as usize >= self.condition_nodes.len() {
            return Err(field(
                "termination_condition",
                "condition index is out of bounds",
            ));
        }
        Ok(())
    }

    fn validate_actions(&self) -> Result<(), ProgramInvariantError> {
        for (index, action) in self.actions.iter().enumerate() {
            let problem = match *action {
                Action::AddItem { item, .. }
                | Action::ReduceItem { item, .. }
                | Action::SetItem { item, .. }
                    if item as usize >= self.items.len() =>
                {
                    "item index is out of bounds"
                }
                Action::AddItem { amount, .. } | Action::ReduceItem { amount, .. }
                    if amount <= 0 =>
                {
                    "add and reduce amounts must be positive"
                }
                Action::SetItem { amount, .. } if amount < 0 => "set amount must be non-negative",
                Action::Draw { pool } | Action::Change { pool }
                    if pool as usize >= self.pools.len() =>
                {
                    "pool index is out of bounds"
                }
                Action::Terminate { reason } if reason as usize >= self.reasons.len() => {
                    "reason index is out of bounds"
                }
                _ => continue,
            };
            return Err(entry("actions", index, problem));
        }
        for (name, range) in [("initial", self.initial), ("every_draw", self.every_draw)] {
            if range.get(&self.actions).is_none() {
                return Err(field(name, "action range is out of bounds"));
            }
        }
        Ok(())
    }

    fn validate_pools(&self) -> Result<(), ProgramInvariantError> {
        validate_ids("pools", self.pools.iter().map(|pool| pool.id.as_str()))?;
        for (index, pool_entry) in self.pool_entries.iter().enumerate() {
            if !(pool_entry.threshold > 0.0 && pool_entry.threshold <= 1.0) {
                return Err(entry("pool_entries", index, "threshold must be in (0, 1]"));
            }
            if pool_entry.actions.get(&self.actions).is_none() {
                return Err(entry(
                    "pool_entries",
                    index,
                    "action range is out of bounds",
                ));
            }
        }
        for (index, pool) in self.pools.iter().enumerate() {
            let entries = pool
                .entries
                .get(&self.pool_entries)
                .ok_or_else(|| entry("pools", index, "entry range is out of bounds"))?;
            if entries.last().map(|pool_entry| pool_entry.threshold) != Some(1.0) {
                return Err(entry("pools", index, "last threshold must equal 1"));
            }
            if entries
                .windows(2)
                .any(|pair| pair[0].threshold >= pair[1].threshold)
            {
                return Err(entry("pools", index, "thresholds must strictly increase"));
            }
        }
        Ok(())
    }

    fn validate_conditions(&self) -> Result<(), ProgramInvariantError> {
        for (index, &child) in self.condition_children.iter().enumerate() {
            if child as usize >= self.condition_nodes.len() {
                return Err(entry(
                    "condition_children",
                    index,
                    "condition index is out of bounds",
                ));
            }
        }
        let mut children_by_node = Vec::with_capacity(self.condition_nodes.len());
        for (index, &node) in self.condition_nodes.iter().enumerate() {
            let (actions, children) = match node {
                ConditionNode::Check {
                    item,
                    value,
                    actions,
                    ..
                } => {
                    if item as usize >= self.items.len() {
                        return Err(entry(
                            "condition_nodes",
                            index,
                            "item index is out of bounds",
                        ));
                    }
                    if value < 0 {
                        return Err(entry(
                            "condition_nodes",
                            index,
                            "check value must be non-negative",
                        ));
                    }
                    (actions, &[][..])
                }
                ConditionNode::Logic {
                    children, actions, ..
                } => {
                    let children = children
                        .get(&self.condition_children)
                        .filter(|children| !children.is_empty())
                        .ok_or_else(|| entry("condition_nodes", index, "invalid child range"))?;
                    (actions, children)
                }
            };
            if actions.get(&self.actions).is_none() {
                return Err(entry(
                    "condition_nodes",
                    index,
                    "action range is out of bounds",
                ));
            }
            children_by_node.push(children);
        }

        let mut visits = vec![ConditionVisit::Unseen; self.condition_nodes.len()];
        for index in 0..self.condition_nodes.len() {
            condition_height(index, &children_by_node, &mut visits, MAX_CONDITION_DEPTH)?;
        }
        Ok(())
    }

    fn validate_resolves(&self) -> Result<(), ProgramInvariantError> {
        if self.item_resolves.len() != self.items.len() {
            return Err(field("item_resolves", "must have one slot per item"));
        }
        for (index, resolve) in self.item_resolves.iter().enumerate() {
            let Some(resolve) = resolve else { continue };
            if resolve.retain < 0 || resolve.reduce_per_batch == 0 {
                return Err(entry(
                    "item_resolves",
                    index,
                    "invalid retain or reduction amount",
                ));
            }
            let actions = resolve
                .actions
                .get(&self.actions)
                .ok_or_else(|| entry("item_resolves", index, "action range is out of bounds"))?;
            let mut reductions = actions.iter().filter_map(|action| match *action {
                Action::ReduceItem { item, amount } => Some((item as usize, amount as u64)),
                _ => None,
            });
            if reductions.next() != Some((index, resolve.reduce_per_batch))
                || reductions.next().is_some()
            {
                return Err(entry(
                    "item_resolves",
                    index,
                    "requires exactly one matching reduction",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum ConditionVisit {
    Unseen,
    Active,
    Complete(usize),
}

fn condition_height(
    index: usize,
    children_by_node: &[&[u32]],
    visits: &mut [ConditionVisit],
    remaining_depth: usize,
) -> Result<usize, ProgramInvariantError> {
    let depth_error = || entry("condition_nodes", index, "condition depth exceeds 256");
    if remaining_depth == 0 {
        return Err(depth_error());
    }
    match visits[index] {
        ConditionVisit::Active => return Err(entry("condition_nodes", index, "cyclic condition")),
        ConditionVisit::Complete(height) if height <= remaining_depth => return Ok(height),
        ConditionVisit::Complete(_) => return Err(depth_error()),
        ConditionVisit::Unseen => visits[index] = ConditionVisit::Active,
    }
    let mut height = 1;
    for &child in children_by_node[index] {
        height = height.max(
            1 + condition_height(
                child as usize,
                children_by_node,
                visits,
                remaining_depth - 1,
            )?,
        );
    }
    visits[index] = ConditionVisit::Complete(height);
    Ok(height)
}
