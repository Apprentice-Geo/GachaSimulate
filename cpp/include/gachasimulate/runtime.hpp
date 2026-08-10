#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace gachasimulate {
struct Range { uint32_t begin{}, count{}; };
enum class ActionKind { Add, Reduce, Set, Draw, Change, Terminate };
struct Action { ActionKind kind; uint32_t target{}; int64_t amount{}; };
struct Entry { double threshold{}; Range actions; };
struct Pool { uint32_t id{}; Range entries; };
enum class Compare { Eq, Ne, Lt, Le, Gt, Ge };
enum class Logic { And, Or };
struct Condition { bool logic{}; Logic op{}; uint32_t item{}; Compare compare{}; int64_t value{}; Range children; Range actions; };
enum class RuleMode { Once, PerDraw, Repeat };
struct Rule { uint32_t id{}; RuleMode mode{}; uint32_t condition{}; };
struct Resolve { uint32_t retain{}; uint32_t reduce_per_batch{}; Range actions; };
struct RuntimeProgram {
  uint32_t draw_count_item{};
  std::vector<std::string> strings;
  std::vector<Action> actions; std::vector<Pool> pools; std::vector<Entry> entries;
  std::vector<Rule> rules; std::vector<Condition> conditions; std::vector<uint32_t> children;
  std::vector<Resolve> resolves; Range initial; Range every_draw; uint32_t termination_condition{};
};
struct RunResult { std::vector<int64_t> inventory; int64_t draw_count{}; std::string reason; };
RuntimeProgram load_ir_file(const std::string& utf8_path);
RunResult single_run(const RuntimeProgram& program, int64_t seed);
}  // namespace gachasimulate
