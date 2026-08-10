#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace gachasimulate {
struct Range {
  uint32_t begin{}, count{};
};
enum class ActionKind : uint8_t { Add, Reduce, Set, Draw, Change, Terminate };
struct Action {
  ActionKind kind;
  uint32_t target{};
  int64_t amount{};
};
struct Entry {
  double threshold{};
  Range actions;
};
struct Pool {
  uint32_t id{};
  Range entries;
};
enum class Compare : uint8_t { Eq, Ne, Lt, Le, Gt, Ge };
enum class Logic : uint8_t { And, Or };
struct Condition {
  bool logic{};
  Logic op{};
  uint32_t item{};
  Compare compare{};
  int64_t value{};
  Range children;
  Range actions;
};
enum class RuleMode : uint8_t { Once, PerDraw, Repeat };
struct Rule {
  uint32_t id{};
  RuleMode mode{};
  uint32_t condition{};
};
struct Resolve {
  uint32_t retain{};
  uint32_t reduce_per_batch{};
  Range actions;
};
struct RuntimeProgram {
  uint32_t draw_count_item{};
  std::optional<uint32_t> cost_item;
  std::vector<std::string> strings;
  std::vector<Action> actions;
  std::vector<Pool> pools;
  std::vector<Entry> entries;
  std::vector<Rule> rules;
  std::vector<Condition> conditions;
  std::vector<uint32_t> children;
  std::vector<Resolve> resolves;
  Range initial;
  Range every_draw;
  uint32_t termination_condition{};
};
struct RunResult {
  std::vector<int64_t> inventory;
  int64_t draw_count{};
  uint32_t reason_id{};
  std::string reason;
};
struct BatchResult {
  std::vector<uint64_t> draws;
  std::vector<int64_t> costs;
  std::vector<uint32_t> reasons;
  uint64_t total_draw{};
  int64_t total_cost{};
};
RuntimeProgram load_ir_file(const std::string &utf8_path);
RunResult single_run(const RuntimeProgram &program, int64_t seed);
BatchResult simulate_fixed_runs(const RuntimeProgram &program, uint64_t total_runs, int64_t seed,
                                uint32_t threads,
                                const std::function<void(uint64_t)> &progress = {});
BatchResult simulate_until_total_draw(const RuntimeProgram &program, uint64_t target_total_draw,
                                      int64_t seed, uint32_t threads,
                                      const std::function<void(uint64_t)> &progress = {});
void write_gsr_v1(const std::string &utf8_path, const RuntimeProgram &program,
                  const BatchResult &result, int64_t seed);
} // namespace gachasimulate
