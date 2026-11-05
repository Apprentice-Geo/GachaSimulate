#include "gachasimulate/runtime.hpp"

#include <gtest/gtest.h>

#include <initializer_list>
#include <vector>

namespace {
using namespace gachasimulate;

Range append_actions(RuntimeProgram &p, std::initializer_list<Action> actions) {
  const Range range{static_cast<uint32_t>(p.actions.size()), static_cast<uint32_t>(actions.size())};
  p.actions.insert(p.actions.end(), actions.begin(), actions.end());
  return range;
}

uint32_t append_check(RuntimeProgram &p, uint32_t item, Compare op, int64_t value,
                      Range actions = {}) {
  Condition node;
  node.item = item;
  node.compare = op;
  node.value = value;
  node.actions = actions;
  p.conditions.push_back(node);
  return static_cast<uint32_t>(p.conditions.size() - 1);
}

uint32_t append_logic(RuntimeProgram &p, Logic op, std::initializer_list<uint32_t> children,
                      Range actions = {}) {
  Condition node;
  node.logic = true;
  node.op = op;
  node.children = {static_cast<uint32_t>(p.children.size()),
                   static_cast<uint32_t>(children.size())};
  node.actions = actions;
  p.children.insert(p.children.end(), children.begin(), children.end());
  p.conditions.push_back(node);
  return static_cast<uint32_t>(p.conditions.size() - 1);
}

RuntimeProgram make_program(size_t item_count) {
  RuntimeProgram p;
  p.strings = {"done", "rule_0", "rule_1", "rule_2", "main"};
  p.result_id = "draw_count";
  p.result_name = "Draw count";
  p.resolves.resize(item_count);
  p.entries = {{1.0, {}}};
  p.pools = {{4, {0, 1}}};
  p.every_draw = append_actions(p, {{ActionKind::Add, 0, 1}});
  const auto terminate = append_actions(p, {{ActionKind::Terminate, 0}});
  p.termination_condition = append_check(p, 0, Compare::Ge, 1, terminate);
  return p;
}

TEST(RuntimeSemantics, OnceAndPerDrawStartAtTheirFirstMatchingRound) {
  auto p = make_program(3);
  p.conditions[p.termination_condition].value = 4;
  const auto once_actions = append_actions(p, {{ActionKind::Add, 1, 10}});
  const auto per_draw_actions = append_actions(p, {{ActionKind::Add, 2, 1}});
  const auto once = append_check(p, 0, Compare::Ge, 2, once_actions);
  const auto per_draw = append_check(p, 0, Compare::Ge, 2, per_draw_actions);
  p.rules = {{1, RuleMode::Once, once}, {2, RuleMode::PerDraw, per_draw}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{4, 10, 3}));
  EXPECT_EQ(result.reason, "done");
}

TEST(RuntimeSemantics, RepeatConvergesBeforeTheNextRuleInTheSameRound) {
  auto p = make_program(4);
  p.initial = append_actions(p, {{ActionKind::Set, 1, 3}});
  const auto before_actions = append_actions(p, {{ActionKind::Add, 3, 1}});
  const auto repeat_actions =
      append_actions(p, {{ActionKind::Reduce, 1, 1}, {ActionKind::Add, 2, 1}});
  const auto after_actions = append_actions(p, {{ActionKind::Add, 3, 10}});
  const auto before = append_check(p, 1, Compare::Eq, 3, before_actions);
  const auto repeat = append_check(p, 1, Compare::Gt, 0, repeat_actions);
  const auto after = append_check(p, 2, Compare::Eq, 3, after_actions);
  p.rules = {
      {1, RuleMode::PerDraw, before}, {2, RuleMode::Repeat, repeat}, {3, RuleMode::PerDraw, after}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{1, 0, 3, 11}));
  EXPECT_EQ(result.reason, "done");
}

TEST(RuntimeSemantics, FalseAndDiscardsCollectedActionsAndLeavesInventoryUnchanged) {
  auto p = make_program(3);
  const auto first_actions = append_actions(p, {{ActionKind::Set, 1, 9}});
  const auto second_actions = append_actions(p, {{ActionKind::Add, 2, 1}});
  const auto parent_actions = append_actions(p, {{ActionKind::Add, 2, 100}});
  const auto first = append_check(p, 1, Compare::Eq, 0, first_actions);
  const auto second = append_check(p, 1, Compare::Eq, 9, second_actions);
  const auto failed_and = append_logic(p, Logic::And, {first, second}, parent_actions);
  const auto following_actions = append_actions(p, {{ActionKind::Set, 2, 7}});
  const auto following = append_check(p, 1, Compare::Eq, 0, following_actions);
  p.rules = {{1, RuleMode::PerDraw, failed_and}, {2, RuleMode::PerDraw, following}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{1, 0, 7}));
  EXPECT_EQ(result.reason, "done");
}

TEST(RuntimeSemantics, ParentActionsPrecedeChildrenAndChildrenKeepDeclarationOrder) {
  auto p = make_program(3);
  const auto parent_actions =
      append_actions(p, {{ActionKind::Set, 1, 10}, {ActionKind::Set, 2, 100}});
  const auto first_actions = append_actions(p, {{ActionKind::Add, 1, 2}, {ActionKind::Set, 2, 20}});
  const auto second_actions = append_actions(p, {{ActionKind::Add, 1, 3}, {ActionKind::Add, 2, 3}});
  const auto first = append_check(p, 1, Compare::Eq, 0, first_actions);
  const auto second = append_check(p, 1, Compare::Eq, 0, second_actions);
  const auto root = append_logic(p, Logic::And, {first, second}, parent_actions);
  p.rules = {{1, RuleMode::PerDraw, root}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{1, 15, 23}));
  EXPECT_EQ(result.reason, "done");
}

TEST(RuntimeSemantics, OrUsesOnlyTheFirstMatchAndDoesNotLeakActionsFromAFailedAnd) {
  auto p = make_program(3);
  const auto discarded_actions = append_actions(p, {{ActionKind::Set, 1, 10}});
  const auto failed_actions = append_actions(p, {{ActionKind::Set, 2, 1}});
  const auto discarded_parent_actions = append_actions(p, {{ActionKind::Set, 2, 100}});
  const auto first = append_check(p, 1, Compare::Eq, 0, discarded_actions);
  const auto second = append_check(p, 1, Compare::Eq, 1, failed_actions);
  const auto failed_and = append_logic(p, Logic::And, {first, second}, discarded_parent_actions);
  const auto winning_actions = append_actions(p, {{ActionKind::Add, 1, 2}});
  const auto unused_actions = append_actions(p, {{ActionKind::Add, 1, 1'000}});
  const auto winning = append_check(p, 0, Compare::Eq, 1, winning_actions);
  const auto unused = append_check(p, 0, Compare::Eq, 1, unused_actions);
  const auto parent_actions = append_actions(p, {{ActionKind::Set, 2, 7}});
  const auto root = append_logic(p, Logic::Or, {failed_and, winning, unused}, parent_actions);
  p.rules = {{1, RuleMode::PerDraw, root}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{1, 2, 7}));
  EXPECT_EQ(result.reason, "done");
}

TEST(RuntimeSemantics, NestedDrawAndResolverFinishBeforeContinuingAndChangeTheNextMainPool) {
  auto p = make_program(4);
  p.conditions[p.termination_condition].value = 2;
  // Item 1 resolves in two batches; item 2 makes synchronous action order observable.
  const auto main_actions = append_actions(
      p, {{ActionKind::Add, 1, 2}, {ActionKind::Set, 2, 9}, {ActionKind::Add, 3, 1}});
  const auto nested_actions = append_actions(
      p, {{ActionKind::Set, 2, 4}, {ActionKind::Add, 3, 100}, {ActionKind::Change, 2}});
  const auto next_main_actions =
      append_actions(p, {{ActionKind::Add, 2, 1'000}, {ActionKind::Add, 3, 10'000}});
  const auto resolve_actions = append_actions(p, {{ActionKind::Reduce, 1, 1},
                                                  {ActionKind::Draw, 1},
                                                  {ActionKind::Add, 2, 1},
                                                  {ActionKind::Add, 3, 10}});
  p.resolves[1] = {0, 1, resolve_actions};
  p.entries = {{1.0, main_actions}, {1.0, nested_actions}, {1.0, next_main_actions}};
  p.pools = {{4, {0, 1}}, {4, {1, 1}}, {4, {2, 1}}};

  const auto result = single_run(p, 7);
  EXPECT_EQ(result.inventory, (std::vector<int64_t>{2, 0, 1'009, 10'221}));
  EXPECT_EQ(result.reason, "done");
}
} // namespace
