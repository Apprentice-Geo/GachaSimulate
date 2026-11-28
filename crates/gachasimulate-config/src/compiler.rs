use std::collections::{HashMap, HashSet};

use crate::program_builder::{range, Arena, Ids};
use crate::source::{
    config_items, config_manifest, diagnostic, is_identifier, list, only_fields,
    read_config_manifest, safe_integer, single_field,
};
use crate::yaml::{self, mapping, Value};
use crate::{
    Action, ActionRange, BatchValidationError, Comparison, CompileDiagnostic, CompileError,
    CompiledProgram, ConditionNode, ConfigItem, ConfigSnapshot, ItemResolve, Pool, PoolEntry, Rule,
    RuleMode, TerminationSource, CONFIG_FILE,
};

pub fn compile_yaml(
    config_yaml: &str,
    termination_yaml: &str,
    manifest_yaml: &str,
    result_item: &str,
) -> Result<CompiledProgram, CompileError> {
    let config = yaml::parse(config_yaml, "config")?;
    let termination = yaml::parse(termination_yaml, "termination")?;
    let manifest = yaml::parse(manifest_yaml, "manifest")?;
    config_manifest(manifest.root())?;
    Ok(prepare(config.root())?.compile(termination.root(), result_item)?)
}

/// Compiles the selected termination file from a single snapshot.
pub fn compile_snapshot(
    snapshot: &ConfigSnapshot,
    termination_file: &str,
    result_item: &str,
) -> Result<CompiledProgram, CompileError> {
    let manifest = read_config_manifest(&snapshot.manifest_yaml)?;
    if !manifest
        .terminations
        .iter()
        .any(|term| term.file == termination_file)
    {
        return Err(diagnostic(
            "termination_file",
            format!("not listed in manifest.terminations: {termination_file}"),
        )
        .into());
    }
    let termination = snapshot.termination(termination_file).ok_or_else(|| {
        diagnostic(
            "termination_file",
            format!("missing from config snapshot: {termination_file}"),
        )
    })?;
    let config = yaml::parse(&snapshot.config_yaml, "config")?;
    let termination = yaml::parse(&termination.content, "termination")?;
    Ok(prepare(config.root())?.compile(termination.root(), result_item)?)
}

/// Validates the config once and each termination against independent compiler
/// state. Reports failing files and their diagnostics in input order.
pub fn validate_config_files(
    config_yaml: &str,
    terminations: &[TerminationSource],
) -> Result<(), BatchValidationError> {
    let config = yaml::parse(config_yaml, "config")
        .and_then(|document| prepare(document.root()))
        .map_err(|error| BatchValidationError {
            failed_files: vec![CONFIG_FILE.into()],
            diagnostics: vec![error],
        })?;
    let mut failures = BatchValidationError {
        failed_files: Vec::new(),
        diagnostics: Vec::new(),
    };
    for term in terminations {
        let result = yaml::parse(&term.content, "termination").and_then(|document| {
            let mut arena = Arena::default();
            apply_termination(&mut arena, &config.ids, document.root())?;
            config.arena.check_reason_limit(Some(&arena))
        });
        if let Err(error) = result {
            failures.failed_files.push(term.file.clone());
            failures.diagnostics.push(error);
        }
    }
    if failures.failed_files.is_empty() {
        Ok(())
    } else {
        Err(failures)
    }
}

struct PreparedConfig {
    ids: Ids,
    arena: Arena,
    items: Vec<ConfigItem>,
    pools: Vec<Pool>,
    pool_entries: Vec<PoolEntry>,
    item_resolves: Vec<Option<ItemResolve>>,
    rules: Vec<Rule>,
    initial: ActionRange,
    every_draw: ActionRange,
}

fn prepare(raw: Value<'_>) -> Result<PreparedConfig, CompileDiagnostic> {
    let config = mapping(raw, "config")?;
    only_fields(
        config,
        "config",
        &[
            "schema_version",
            "items",
            "pools",
            "initial",
            "every_draw",
            "rules",
            "item_resolve",
        ],
    )?;
    if config.get("schema_version").integer() != Some(2) {
        return Err(diagnostic("config.schema_version", "must be 2"));
    }
    let items = config_items(config.get("items"))?;
    let mut ids = Ids {
        items: items
            .iter()
            .enumerate()
            .map(|(i, item)| (item.id.clone(), i as u32))
            .collect(),
        pools: Default::default(),
    };
    let mut arena = Arena::default();
    let (pools, pool_entries) = compile_pools(config.get("pools"), &mut ids, &mut arena)?;
    let item_resolves = compile_resolves(config.get("item_resolve"), &ids, &mut arena)?;
    let mut graph = CallGraph::new(&pools, &pool_entries, &item_resolves, &arena, &items)?;
    let rules = compile_rules(
        config.get("rules"),
        &ids,
        &mut arena,
        &items,
        &item_resolves,
        &mut graph,
    )?;
    let initial = arena.add_actions(&ids, config.get("initial"), "config.initial")?;
    let every_draw = arena.add_actions(&ids, config.get("every_draw"), "config.every_draw")?;
    arena.check_reason_limit(None)?;
    Ok(PreparedConfig {
        ids,
        arena,
        items,
        pools,
        pool_entries,
        item_resolves,
        rules,
        initial,
        every_draw,
    })
}

fn compile_pools(
    raw: Value<'_>,
    ids: &mut Ids,
    arena: &mut Arena,
) -> Result<(Vec<Pool>, Vec<PoolEntry>), CompileDiagnostic> {
    let raw = list(raw, "config.pools")?;
    if raw.len() == 0 {
        return Err(diagnostic("config.pools", "must be non-empty"));
    }
    let mut declarations = Vec::with_capacity(raw.len());
    for (index, node) in raw.enumerate() {
        let path = format!("config.pools[{index}]");
        let (id, entries) = single_field(node, &path)?;
        if !is_identifier(id) || ids.pools.insert(id.into(), index as u32).is_some() {
            return Err(diagnostic(&path, "invalid or duplicate pool id"));
        }
        declarations.push((id, entries));
    }

    let mut pool_entries = Vec::new();
    let mut pools = Vec::with_capacity(declarations.len());
    for (index, (id, raw)) in declarations.into_iter().enumerate() {
        let path = format!("config.pools[{index}].{id}");
        let entries = list(raw, &path)?;
        if entries.len() == 0 {
            return Err(diagnostic(&path, "must be non-empty"));
        }
        let begin = pool_entries.len();
        let mut weighted = None;
        let mut total = 0.0;
        for (entry_index, raw) in entries.enumerate() {
            let entry_path = format!("{path}[{entry_index}]");
            let entry = mapping(raw, &entry_path)?;
            only_fields(entry, &entry_path, &["probability", "weight", "actions"])?;
            let is_weight = entry.get("weight").is_present();
            if entry.get("probability").is_present() == is_weight {
                return Err(diagnostic(
                    &entry_path,
                    "must contain exactly one of probability or weight",
                ));
            }
            if weighted.is_some_and(|previous| previous != is_weight) {
                return Err(diagnostic(&entry_path, "cannot mix probability and weight"));
            }
            weighted = Some(is_weight);
            let key = if is_weight { "weight" } else { "probability" };
            let amount = entry
                .get(key)
                .number()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| {
                    diagnostic(
                        &format!("{entry_path}.{key}"),
                        "must be a finite positive number",
                    )
                })?;
            total += amount;
            if is_weight && !total.is_finite() {
                return Err(diagnostic(&path, "weight sum must be finite"));
            }
            let actions =
                arena.add_actions(ids, entry.get("actions"), &format!("{entry_path}.actions"))?;
            pool_entries.push(PoolEntry {
                threshold: total,
                actions,
            });
        }
        let weighted = weighted.expect("non-empty pool");
        if !weighted && (total - 1.0).abs() > 1e-9 {
            return Err(diagnostic(&path, "probability sum must be 1"));
        }
        let entries = &mut pool_entries[begin..];
        if weighted {
            for entry in entries.iter_mut() {
                entry.threshold /= total;
            }
        }
        entries.last_mut().expect("non-empty pool").threshold = 1.0;
        let mut previous = 0.0;
        for entry in entries {
            if entry.threshold <= previous {
                return Err(diagnostic(&path, "thresholds must strictly increase"));
            }
            previous = entry.threshold;
        }
        pools.push(Pool {
            id: id.into(),
            entries: range(begin, pool_entries.len()),
        });
    }
    Ok((pools, pool_entries))
}

fn compile_resolves(
    raw: Value<'_>,
    ids: &Ids,
    arena: &mut Arena,
) -> Result<Vec<Option<ItemResolve>>, CompileDiagnostic> {
    let mut resolves = vec![None; ids.items.len()];
    if raw.is_null() {
        return Ok(resolves);
    }
    for (index, raw) in list(raw, "config.item_resolve")?.enumerate() {
        let path = format!("config.item_resolve[{index}]");
        let value = mapping(raw, &path)?;
        only_fields(value, &path, &["item", "retain", "actions"])?;
        let &item = value
            .get("item")
            .string()
            .and_then(|id| ids.items.get(id))
            .filter(|&&item| resolves[item as usize].is_none())
            .ok_or_else(|| {
                diagnostic(
                    &format!("{path}.item"),
                    "unknown or duplicate resolved item",
                )
            })?;
        let actions_path = format!("{path}.actions");
        let actions = arena.add_actions(ids, value.get("actions"), &actions_path)?;
        let mut reductions = actions
            .get(&arena.actions)
            .expect("action range")
            .iter()
            .filter_map(|&action| match action {
                Action::ReduceItem { item, amount } => Some((item, amount)),
                _ => None,
            });
        let reduction = reductions
            .next()
            .filter(|&(target, _)| target == item && reductions.next().is_none());
        let Some((_, reduce_per_batch)) = reduction else {
            return Err(diagnostic(&actions_path,
                "must contain exactly one reduce action for the resolved item and no other item reductions"));
        };
        let retain = safe_integer(
            value.get("retain").integer(),
            &format!("{path}.retain"),
            false,
        )?;
        resolves[item as usize] = Some(ItemResolve {
            retain,
            reduce_per_batch: reduce_per_batch as u64,
            actions,
        });
    }
    Ok(resolves)
}

fn compile_rules(
    raw: Value<'_>,
    ids: &Ids,
    arena: &mut Arena,
    items: &[ConfigItem],
    resolves: &[Option<ItemResolve>],
    graph: &mut CallGraph,
) -> Result<Vec<Rule>, CompileDiagnostic> {
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let mut rule_ids = HashSet::new();
    let mut rules = Vec::new();
    for (index, raw) in list(raw, "config.rules")?.enumerate() {
        let path = format!("config.rules[{index}]");
        let (id, raw) = single_field(raw, &path)?;
        if !is_identifier(id) {
            return Err(diagnostic(&path, "invalid rule id"));
        }
        if !rule_ids.insert(id) {
            return Err(diagnostic(&path, format!("duplicate rule id: {id}")));
        }
        let path = format!("{path}.{id}");
        let rule = mapping(raw, &path)?;
        only_fields(rule, &path, &["mode", "condition"])?;
        let mode = match rule.get("mode") {
            mode if mode.is_null() => RuleMode::Once,
            mode => match mode.string() {
                Some("once") => RuleMode::Once,
                Some("per_draw") => RuleMode::PerDraw,
                Some("repeat") => RuleMode::Repeat,
                _ => return Err(diagnostic(&format!("{path}.mode"), "unsupported mode")),
            },
        };
        let path = format!("{path}.condition");
        let summary = arena.add_condition(ids, rule.get("condition"), &path)?;
        if !summary.has_actions {
            return Err(diagnostic(&path, "must contain at least one action"));
        }
        if mode == RuleMode::Repeat {
            let node = arena.condition_nodes[summary.id as usize];
            graph.repeat_exits(node, arena, items, resolves, &path)?;
        }
        rules.push(Rule {
            id: id.into(),
            mode,
            condition: summary.id,
        });
    }
    Ok(rules)
}

fn apply_termination(
    arena: &mut Arena,
    ids: &Ids,
    raw: Value<'_>,
) -> Result<(u32, Vec<(u32, i64)>), CompileDiagnostic> {
    let term = mapping(raw, "termination")?;
    only_fields(term, "termination", &["retained_items", "termination_rule"])?;
    let mut retained_ids = HashSet::new();
    let mut retained_items = Vec::new();
    for (index, raw) in list(term.get("retained_items"), "termination.retained_items")?.enumerate()
    {
        let path = format!("termination.retained_items[{index}]");
        let (id, count) = single_field(raw, &path)?;
        let &item = ids
            .items
            .get(id)
            .filter(|&&item| retained_ids.insert(item))
            .ok_or_else(|| diagnostic(&path, "unknown or duplicate retained item"))?;
        let count = safe_integer(count.integer(), &format!("{path}.{id}"), false)?;
        retained_items.push((item, count));
    }
    let path = "termination.termination_rule";
    let rule = mapping(term.get("termination_rule"), path)?;
    only_fields(rule, path, &["condition"])?;
    let path = "termination.termination_rule.condition";
    let summary = arena.add_condition(ids, rule.get("condition"), path)?;
    if !summary.every_path_terminates {
        return Err(diagnostic(
            path,
            "every termination path must contain a terminate action",
        ));
    }
    Ok((summary.id, retained_items))
}

impl PreparedConfig {
    fn compile(
        mut self,
        termination: Value<'_>,
        result_item: &str,
    ) -> Result<CompiledProgram, CompileDiagnostic> {
        let (termination_condition, retained_items) =
            apply_termination(&mut self.arena, &self.ids, termination)?;
        if !is_identifier(result_item) {
            return Err(diagnostic("result_item", "must be an item id"));
        }
        let &result_item =
            self.ids.items.get(result_item).ok_or_else(|| {
                diagnostic("result_item", format!("unknown item id: {result_item}"))
            })?;
        for (item, count) in retained_items {
            if let Some(resolve) = &mut self.item_resolves[item as usize] {
                resolve.retain = resolve.retain.max(count);
            }
        }
        let reasons = self.arena.sort_reasons();
        let program = CompiledProgram {
            result_item,
            items: self.items,
            reasons,
            actions: self.arena.actions,
            pools: self.pools,
            pool_entries: self.pool_entries,
            rules: self.rules,
            condition_nodes: self.arena.condition_nodes,
            condition_children: self.arena.condition_children,
            item_resolves: self.item_resolves,
            initial: self.initial,
            every_draw: self.every_draw,
            termination_condition,
        };
        program.validate_invariants().map_err(|error| match error {
            crate::ProgramInvariantError::InvalidField { field, message } => {
                diagnostic(field, message)
            }
            crate::ProgramInvariantError::InvalidEntry {
                table,
                index,
                message,
            } => diagnostic(&format!("{table}[{index}]"), message),
        })?;
        Ok(program)
    }
}

struct CallGraph {
    pool_count: usize,
    edges: Vec<Vec<usize>>,
    direct_writes: Vec<HashSet<u32>>,
    memo: HashMap<(u32, usize), bool>,
}

fn called_node(
    action: Action,
    pool_count: usize,
    resolves: &[Option<ItemResolve>],
) -> Option<usize> {
    match action {
        Action::Draw { pool } => Some(pool as usize),
        Action::AddItem { item, .. } | Action::SetItem { item, .. }
            if resolves[item as usize].is_some() =>
        {
            Some(pool_count + item as usize)
        }
        _ => None,
    }
}

fn written_item(action: Action) -> Option<u32> {
    match action {
        Action::AddItem { item, .. }
        | Action::ReduceItem { item, .. }
        | Action::SetItem { item, .. } => Some(item),
        _ => None,
    }
}

impl CallGraph {
    fn new(
        pools: &[Pool],
        pool_entries: &[PoolEntry],
        resolves: &[Option<ItemResolve>],
        arena: &Arena,
        items: &[ConfigItem],
    ) -> Result<Self, CompileDiagnostic> {
        let pool_count = pools.len();
        let node_count = pool_count + items.len();
        let mut edges = vec![Vec::new(); node_count];
        let mut edge_seen = vec![HashSet::new(); node_count];
        let mut direct_writes = vec![HashSet::new(); node_count];
        let mut visit_range = |node: usize, actions: ActionRange| {
            for &action in actions.get(&arena.actions).expect("action range") {
                if matches!(action, Action::Terminate { .. }) {
                    break;
                }
                if let Some(item) = written_item(action) {
                    direct_writes[node].insert(item);
                }
                if let Some(target) = called_node(action, pool_count, resolves) {
                    if edge_seen[node].insert(target) {
                        edges[node].push(target);
                    }
                }
            }
        };
        for (node, pool) in pools.iter().enumerate() {
            for entry in pool.entries.get(pool_entries).expect("pool entry range") {
                visit_range(node, entry.actions);
            }
        }
        for (item, resolve) in resolves.iter().enumerate() {
            if let Some(resolve) = resolve {
                visit_range(pool_count + item, resolve.actions);
            }
        }
        check_cycles(&edges, pools, items)?;
        Ok(Self {
            pool_count,
            edges,
            direct_writes,
            memo: HashMap::new(),
        })
    }

    fn repeat_exits(
        &mut self,
        condition: ConditionNode,
        arena: &Arena,
        items: &[ConfigItem],
        resolves: &[Option<ItemResolve>],
        path: &str,
    ) -> Result<(), CompileDiagnostic> {
        let ConditionNode::Check {
            item,
            op,
            value,
            actions,
        } = condition
        else {
            return Err(diagnostic(path, "repeat condition must be a single check"));
        };
        let actions = actions.get(&arena.actions).expect("action range");
        if actions
            .iter()
            .any(|action| matches!(action, Action::Terminate { .. }))
        {
            return Ok(());
        }
        let path = format!("{path}.actions");
        let pool_count = self.pool_count;
        for target in actions
            .iter()
            .filter_map(|&action| called_node(action, pool_count, resolves))
        {
            if self.nested_writes(item, target) {
                return Err(diagnostic(
                    &path,
                    format!(
                        "nested pool or item resolver may write checked item: {}",
                        items[item as usize].id
                    ),
                ));
            }
        }
        let mut writes = actions
            .iter()
            .copied()
            .filter(|&action| written_item(action) == Some(item));
        let Some(write) = writes.next().filter(|_| writes.next().is_none()) else {
            return Err(diagnostic(&path, "must write checked item exactly once"));
        };
        let exits = match write {
            Action::SetItem { amount, .. } => !match op {
                Comparison::Eq => amount == value,
                Comparison::Ne => amount != value,
                Comparison::Lt => amount < value,
                Comparison::Le => amount <= value,
                Comparison::Gt => amount > value,
                Comparison::Ge => amount >= value,
            },
            Action::AddItem { .. } => {
                matches!(op, Comparison::Le | Comparison::Lt | Comparison::Eq)
            }
            Action::ReduceItem { .. } => {
                matches!(op, Comparison::Ge | Comparison::Gt | Comparison::Eq)
            }
            _ => unreachable!("only item writes are selected"),
        };
        if exits {
            Ok(())
        } else {
            Err(diagnostic(
                &path,
                "the checked item write does not make the condition false",
            ))
        }
    }

    fn nested_writes(&mut self, item: u32, start: usize) -> bool {
        if let Some(&cached) = self.memo.get(&(item, start)) {
            return cached;
        }
        let mut stack = vec![(start, 0usize)];
        while let Some((node, next_edge)) = stack.last_mut() {
            let node = *node;
            if self.memo.contains_key(&(item, node)) {
                stack.pop();
                continue;
            }
            if self.direct_writes[node].contains(&item) {
                self.memo.insert((item, node), true);
                stack.pop();
                continue;
            }
            if *next_edge < self.edges[node].len() {
                let target = self.edges[node][*next_edge];
                match self.memo.get(&(item, target)) {
                    Some(&true) => {
                        self.memo.insert((item, node), true);
                        stack.pop();
                    }
                    Some(&false) => {
                        *next_edge += 1;
                    }
                    None => stack.push((target, 0)),
                }
            } else {
                self.memo.insert((item, node), false);
                stack.pop();
            }
        }
        self.memo[&(item, start)]
    }
}

fn check_cycles(
    edges: &[Vec<usize>],
    pools: &[Pool],
    items: &[ConfigItem],
) -> Result<(), CompileDiagnostic> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Visit {
        Unseen,
        Active,
        Complete,
    }

    let mut visits = vec![Visit::Unseen; edges.len()];
    let mut stack = Vec::new();
    for start in 0..edges.len() {
        if visits[start] != Visit::Unseen {
            continue;
        }
        visits[start] = Visit::Active;
        stack.push((start, edges[start].iter()));
        while let Some((node, targets)) = stack.last_mut() {
            let Some(&target) = targets.next() else {
                visits[*node] = Visit::Complete;
                stack.pop();
                continue;
            };
            match visits[target] {
                Visit::Complete => {}
                Visit::Unseen => {
                    visits[target] = Visit::Active;
                    stack.push((target, edges[target].iter()));
                }
                Visit::Active => {
                    let first = stack
                        .iter()
                        .position(|(node, _)| *node == target)
                        .expect("active node");
                    let cycle = stack[first..]
                        .iter()
                        .map(|&(node, _)| node)
                        .chain([target])
                        .map(|node| match pools.get(node) {
                            Some(pool) => format!("pool {}", pool.id),
                            None => format!("resolve {}", items[node - pools.len()].id),
                        })
                        .collect::<Vec<_>>()
                        .join(" -> ");
                    return Err(diagnostic(
                        "config",
                        format!("synchronous action cycle: {cycle}"),
                    ));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_graph_stores_each_caller_and_writer_once() {
        let mut arena = Arena::default();
        let actions = [
            Action::Draw { pool: 2 },
            Action::AddItem { item: 0, amount: 1 },
        ];
        arena.actions = actions.repeat(1024);
        let repeated_end = arena.actions.len();
        arena.actions.extend(actions);
        let main_end = arena.actions.len();
        arena.actions.extend(actions);
        let entries = [
            range(0, repeated_end),
            range(repeated_end, main_end),
            range(main_end, arena.actions.len()),
        ]
        .map(|actions| PoolEntry {
            threshold: 1.0,
            actions,
        });
        let pools = [
            Pool {
                id: "main".into(),
                entries: range(0, 2),
            },
            Pool {
                id: "side".into(),
                entries: range(2, 3),
            },
            Pool {
                id: "nested".into(),
                entries: ActionRange::EMPTY,
            },
        ];
        let items = [ConfigItem {
            id: "target".into(),
            name: "Target".into(),
        }];
        let graph = CallGraph::new(&pools, &entries, &[None], &arena, &items).unwrap();
        assert_eq!(graph.edges[0], [2]);
        assert_eq!(graph.edges[1], [2]);
        assert!(graph.direct_writes[0].contains(&0));
        assert!(graph.direct_writes[1].contains(&0));
        assert_eq!(graph.direct_writes[0].len(), 1);
    }
}
