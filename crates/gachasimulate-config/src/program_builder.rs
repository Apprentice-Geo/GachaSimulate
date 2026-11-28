use std::collections::HashMap;
use std::fmt::Write;

use gachasimulate_types::MAX_REASONS;

use crate::source::{
    diagnostic, is_identifier, is_js_whitespace, list, only_fields, safe_integer, trim,
};
use crate::yaml::{mapping, Value};
use crate::{
    Action, ActionRange, Comparison, CompileDiagnostic, ConditionNode, LogicOp, MAX_CONDITION_DEPTH,
};

#[derive(Default)]
pub(crate) struct Ids {
    pub(crate) items: HashMap<String, u32>,
    pub(crate) pools: HashMap<String, u32>,
}

#[derive(Default)]
pub(crate) struct Arena {
    pub(crate) actions: Vec<Action>,
    pub(crate) condition_nodes: Vec<ConditionNode>,
    pub(crate) condition_children: Vec<u32>,
    reasons: Vec<String>,
    reason_ids: HashMap<String, u32>,
}

#[derive(Clone, Copy)]
pub(crate) struct ConditionSummary {
    pub(crate) id: u32,
    pub(crate) has_actions: bool,
    pub(crate) every_path_terminates: bool,
}

struct ParentCondition<'a> {
    op: LogicOp,
    children: ActionRange,
    pending: std::iter::Enumerate<std::vec::IntoIter<Value<'a>>>,
    actions: ActionRange,
    path_len: usize,
    next_child: usize,
    has_actions: bool,
    every_path_terminates: bool,
    own_terminates: bool,
}

pub(crate) fn range(begin: usize, end: usize) -> ActionRange {
    // Every arena entry consumes source bytes and both inputs are limited to 1 MiB.
    ActionRange::new(begin as u32, (end - begin) as u32)
}

fn expression<'a, T: Copy>(
    text: &'a str,
    operators: &[(&str, T)],
) -> Option<(&'a str, T, &'a str)> {
    let end = text
        .bytes()
        .position(|b| !(b.is_ascii_alphanumeric() || b == b'_'))?;
    let (id, operator) = text.split_at(end);
    if !is_identifier(id) {
        return None;
    }
    let operator = operator.trim_start_matches([' ', '\t']);
    let (op, number) = operators
        .iter()
        .find_map(|&(token, op)| operator.strip_prefix(token).map(|number| (op, number)))?;
    let number = number.trim_start_matches([' ', '\t']);
    (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())).then_some((id, op, number))
}

#[derive(Clone, Copy)]
enum ItemOperation {
    Add,
    Reduce,
    Set,
}

const ITEM_OPERATORS: [(&str, ItemOperation); 3] = [
    ("+=", ItemOperation::Add),
    ("-=", ItemOperation::Reduce),
    ("=", ItemOperation::Set),
];

const COMPARISONS: [(&str, Comparison); 6] = [
    (">=", Comparison::Ge),
    ("<=", Comparison::Le),
    ("==", Comparison::Eq),
    ("!=", Comparison::Ne),
    (">", Comparison::Gt),
    ("<", Comparison::Lt),
];

impl Arena {
    pub(crate) fn add_actions(
        &mut self,
        ids: &Ids,
        raw: Value<'_>,
        path: &str,
    ) -> Result<ActionRange, CompileDiagnostic> {
        let begin = self.actions.len();
        let strings = if raw.is_null() {
            return Ok(range(begin, begin));
        } else if let Some(text) = raw.string() {
            vec![text]
        } else {
            list(raw, path)?
                .enumerate()
                .map(|(index, value)| {
                    value.string().ok_or_else(|| {
                        diagnostic(&format!("{path}[{index}]"), "must be an action string")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        for (index, text) in strings.into_iter().enumerate() {
            let action = self.action(ids, text, &format!("{path}[{index}]"))?;
            self.actions.push(action);
        }
        Ok(range(begin, self.actions.len()))
    }

    fn action(&mut self, ids: &Ids, value: &str, path: &str) -> Result<Action, CompileDiagnostic> {
        let text = trim(value);
        if let Some((id, op, number)) = expression(text, &ITEM_OPERATORS) {
            let &item = ids
                .items
                .get(id)
                .ok_or_else(|| diagnostic(path, format!("unknown item id: {id}")))?;
            let amount =
                safe_integer(number.parse().ok(), path, !matches!(op, ItemOperation::Set))?;
            return Ok(match op {
                ItemOperation::Add => Action::AddItem { item, amount },
                ItemOperation::Reduce => Action::ReduceItem { item, amount },
                ItemOperation::Set => Action::SetItem { item, amount },
            });
        }
        if let Some((command @ ("draw" | "change" | "terminate"), target)) = text.split_once(' ') {
            let target = target
                .split(is_js_whitespace)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if command == "terminate" {
                if !target.is_empty() {
                    let next = self.reasons.len() as u32;
                    let reason = *self.reason_ids.entry(target.clone()).or_insert_with(|| {
                        self.reasons.push(target);
                        next
                    });
                    return Ok(Action::Terminate { reason });
                }
            } else {
                let &pool = ids
                    .pools
                    .get(&target)
                    .ok_or_else(|| diagnostic(path, format!("unknown pool id: {target}")))?;
                return Ok(if command == "draw" {
                    Action::Draw { pool }
                } else {
                    Action::Change { pool }
                });
            }
        }
        Err(diagnostic(path, format!("unsupported action: {value}")))
    }

    pub(crate) fn add_condition(
        &mut self,
        ids: &Ids,
        raw: Value<'_>,
        path: &str,
    ) -> Result<ConditionSummary, CompileDiagnostic> {
        let mut parents: Vec<ParentCondition<'_>> = Vec::new();
        let mut path = path.to_owned();
        let mut raw = raw;
        loop {
            if parents.len() >= MAX_CONDITION_DEPTH {
                return Err(diagnostic(
                    &path,
                    format!("condition depth exceeds {MAX_CONDITION_DEPTH}"),
                ));
            }
            let node = mapping(raw, &path)?;
            let actions = self.add_actions(ids, node.get("actions"), &format!("{path}.actions"))?;
            let own_terminates = actions
                .get(&self.actions)
                .expect("arena range")
                .iter()
                .any(|action| matches!(action, Action::Terminate { .. }));
            let check = node.get("check");
            let mut summary = if check.is_present() {
                only_fields(node, &path, &["check", "actions"])?;
                let check_path = format!("{path}.check");
                let text = check
                    .string()
                    .ok_or_else(|| diagnostic(&check_path, "must be a condition string"))?;
                let (id, op, number) = expression(trim(text), &COMPARISONS)
                    .ok_or_else(|| diagnostic(&check_path, "unsupported condition"))?;
                let &item = ids
                    .items
                    .get(id)
                    .ok_or_else(|| diagnostic(&check_path, format!("unknown item id: {id}")))?;
                let value = safe_integer(number.parse().ok(), &check_path, false)?;
                let id = self.condition_nodes.len() as u32;
                self.condition_nodes.push(ConditionNode::Check {
                    item,
                    op,
                    value,
                    actions,
                });
                ConditionSummary {
                    id,
                    has_actions: actions.count > 0,
                    every_path_terminates: own_terminates,
                }
            } else {
                only_fields(node, &path, &["op", "children", "actions"])?;
                let op = match node.get("op").string() {
                    Some("AND" | "&&") => LogicOp::And,
                    Some("OR" | "||") => LogicOp::Or,
                    _ => return Err(diagnostic(&format!("{path}.op"), "unsupported logic op")),
                };
                let children_path = format!("{path}.children");
                let children = list(node.get("children"), &children_path)?.collect::<Vec<_>>();
                let begin = self.condition_children.len();
                let end = begin + children.len();
                let mut pending = children.into_iter().enumerate();
                let Some((_, first)) = pending.next() else {
                    return Err(diagnostic(&children_path, "must be non-empty"));
                };
                self.condition_children.resize(end, 0);
                parents.push(ParentCondition {
                    op,
                    children: range(begin, end),
                    pending,
                    actions,
                    path_len: path.len(),
                    next_child: begin,
                    has_actions: actions.count > 0,
                    every_path_terminates: op == LogicOp::Or,
                    own_terminates,
                });
                path.push_str(".children[0]");
                raw = first;
                continue;
            };

            loop {
                let Some(parent) = parents.last_mut() else {
                    return Ok(summary);
                };
                self.condition_children[parent.next_child] = summary.id;
                parent.next_child += 1;
                parent.has_actions |= summary.has_actions;
                match parent.op {
                    LogicOp::And => parent.every_path_terminates |= summary.every_path_terminates,
                    LogicOp::Or => parent.every_path_terminates &= summary.every_path_terminates,
                }
                path.truncate(parent.path_len);
                if let Some((index, next)) = parent.pending.next() {
                    write!(path, ".children[{index}]").expect("writing to String");
                    raw = next;
                    break;
                }
                let parent = parents.pop().expect("active parent");
                let id = self.condition_nodes.len() as u32;
                self.condition_nodes.push(ConditionNode::Logic {
                    op: parent.op,
                    children: parent.children,
                    actions: parent.actions,
                });
                summary = ConditionSummary {
                    id,
                    has_actions: parent.has_actions,
                    every_path_terminates: parent.own_terminates || parent.every_path_terminates,
                };
            }
        }
    }

    pub(crate) fn sort_reasons(&mut self) -> Vec<String> {
        let mut reasons: Vec<_> = std::mem::take(&mut self.reasons)
            .into_iter()
            .enumerate()
            .collect();
        reasons.sort_unstable_by(|(_, a), (_, b)| a.cmp(b));
        let mut remap = vec![0; reasons.len()];
        for (new, &(old, _)) in reasons.iter().enumerate() {
            remap[old] = new as u32;
        }
        for action in &mut self.actions {
            if let Action::Terminate { reason } = action {
                *reason = remap[*reason as usize];
            }
        }
        reasons.into_iter().map(|(_, reason)| reason).collect()
    }

    pub(crate) fn check_reason_limit(
        &self,
        termination: Option<&Self>,
    ) -> Result<(), CompileDiagnostic> {
        let error = || diagnostic("reasons", "invalid reason count");
        let available = MAX_REASONS
            .checked_sub(self.reasons.len())
            .ok_or_else(error)?;
        if let Some(termination) = termination.filter(|term| term.reasons.len() > available) {
            let additional = termination
                .reasons
                .iter()
                .filter(|reason| !self.reason_ids.contains_key(*reason))
                .take(available + 1)
                .count();
            if additional <= available {
                return Ok(());
            }
            return Err(error());
        }
        Ok(())
    }
}
