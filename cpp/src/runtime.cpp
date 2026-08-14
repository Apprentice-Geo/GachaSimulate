#include "gachasimulate/runtime.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <nlohmann/json.hpp>
#include <random>
#include <stdexcept>
#include <thread>

namespace gachasimulate {
namespace {
using Json = nlohmann::json;
constexpr size_t kMaxFile = 64 * 1024 * 1024, kMaxArena = 1'000'000, kMaxConditionDepth = 256;
[[noreturn]] void fail(const std::string &message) {
  throw std::runtime_error("invalid IR: " + message);
}
const Json &field(const Json &object, const char *name) {
  if (!object.contains(name))
    fail(std::string("missing ") + name);
  return object.at(name);
}
void object(const Json &value, std::initializer_list<const char *> allowed) {
  if (!value.is_object())
    fail("expected object");
  for (const auto &[key, unused] : value.items())
    if (std::find(allowed.begin(), allowed.end(), key) == allowed.end())
      fail("unknown field " + key);
}
const Json &array(const Json &value, const char *name) {
  if (!value.is_array())
    fail(std::string(name) + " must be an array");
  if (value.size() > kMaxArena)
    fail(std::string(name) + " exceeds arena limit");
  return value;
}
uint32_t u32(const Json &value, const char *name) {
  if ((!value.is_number_unsigned() && !value.is_number_integer()))
    fail(std::string(name) + " must be an unsigned integer");
  if (value.is_number_integer() && value.get<int64_t>() < 0)
    fail(std::string(name) + " must be non-negative");
  const auto n = value.get<uint64_t>();
  if (n > std::numeric_limits<uint32_t>::max())
    fail(std::string(name) + " overflows uint32");
  return static_cast<uint32_t>(n);
}
int64_t i64(const Json &value, const char *name) {
  if (!value.is_number_integer() && !value.is_number_unsigned())
    fail(std::string(name) + " must be an integer");
  if (value.is_number_unsigned() &&
      value.get<uint64_t>() > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
    fail(std::string(name) + " overflows int64");
  return value.get<int64_t>();
}
Range range(const Json &value, const char *name, size_t limit) {
  object(value, {"begin", "count"});
  const auto r = Range{u32(field(value, "begin"), "begin"), u32(field(value, "count"), "count")};
  if (r.begin > limit || r.count > limit - r.begin)
    fail(std::string(name) + " out of bounds");
  return r;
}
ActionKind action_kind(const std::string &name) {
  if (name == "add_item")
    return ActionKind::Add;
  if (name == "reduce_item")
    return ActionKind::Reduce;
  if (name == "set_item")
    return ActionKind::Set;
  if (name == "draw")
    return ActionKind::Draw;
  if (name == "change")
    return ActionKind::Change;
  if (name == "terminate")
    return ActionKind::Terminate;
  fail("unknown action kind");
}
Compare compare(const std::string &value) {
  if (value == "==")
    return Compare::Eq;
  if (value == "!=")
    return Compare::Ne;
  if (value == "<")
    return Compare::Lt;
  if (value == "<=")
    return Compare::Le;
  if (value == ">")
    return Compare::Gt;
  if (value == ">=")
    return Compare::Ge;
  fail("unknown compare op");
}
bool add_checked(int64_t &target, int64_t amount) {
  if ((amount > 0 && target > std::numeric_limits<int64_t>::max() - amount) ||
      (amount < 0 && target < std::numeric_limits<int64_t>::min() - amount))
    return false;
  target += amount;
  return true;
}
struct State {
  uint32_t pool{};
  std::vector<int64_t> inventory;
  std::vector<uint8_t> once;
  bool stop{};
  uint32_t reason{};
  std::mt19937_64 rng;
};
struct Frame {
  Range range;
  uint32_t offset{};
  uint64_t repeats{};
};

bool condition(const RuntimeProgram &p, State &s, uint32_t id, std::vector<Range> &output) {
  const auto &node = p.conditions[id];
  if (!node.logic) {
    const auto left = s.inventory[node.item];
    const auto right = node.value;
    const bool ok = node.compare == Compare::Eq   ? left == right
                    : node.compare == Compare::Ne ? left != right
                    : node.compare == Compare::Lt ? left < right
                    : node.compare == Compare::Le ? left <= right
                    : node.compare == Compare::Gt ? left > right
                                                  : left >= right;
    if (ok && node.actions.count)
      output.push_back(node.actions);
    return ok;
  }
  const auto start = output.size();
  if (node.op == Logic::Or) {
    for (uint32_t i = 0; i < node.children.count; ++i)
      if (condition(p, s, p.children[node.children.begin + i], output)) {
        if (node.actions.count)
          output.insert(output.begin() + start, node.actions);
        return true;
      }
    output.resize(start);
    return false;
  }
  for (uint32_t i = 0; i < node.children.count; ++i)
    if (!condition(p, s, p.children[node.children.begin + i], output)) {
      output.resize(start);
      return false;
    }
  if (node.actions.count)
    output.insert(output.begin() + start, node.actions);
  return true;
}
void execute(const RuntimeProgram &p, State &s, Range initial) {
  std::vector<Frame> frames;
  const auto enqueue_resolve = [&](uint32_t item) {
    const auto &r = p.resolves[item];
    if (!r.actions.count || s.inventory[item] <= r.retain)
      return;
    const auto batches = static_cast<uint64_t>(s.inventory[item] - r.retain) / r.reduce_per_batch;
    if (batches)
      frames.push_back({r.actions, 0, batches});
  };
  if (initial.count)
    frames.push_back({initial, 0, 1});
  while (!frames.empty() && !s.stop) {
    auto &frame = frames.back();
    if (frame.offset == frame.range.count) {
      if (--frame.repeats)
        frame.offset = 0;
      else {
        frames.pop_back();
      }
      continue;
    }
    const auto &action = p.actions[frame.range.begin + frame.offset++];
    switch (action.kind) {
    case ActionKind::Add:
      if (!add_checked(s.inventory[action.target], action.amount))
        throw std::runtime_error("runtime inventory overflow");
      enqueue_resolve(action.target);
      break;
    case ActionKind::Reduce:
      if (!add_checked(s.inventory[action.target], -action.amount))
        throw std::runtime_error("runtime inventory overflow");
      break;
    case ActionKind::Set:
      s.inventory[action.target] = action.amount;
      enqueue_resolve(action.target);
      break;
    case ActionKind::Draw: {
      const auto &pool = p.pools[action.target];
      std::uniform_real_distribution<double> random(0.0, 1.0);
      const auto value = random(s.rng);
      const auto first = p.entries.begin() + pool.entries.begin;
      const auto entry = std::lower_bound(first, first + pool.entries.count, value,
                                          [](const Entry &e, double v) { return e.threshold < v; });
      frames.push_back({entry->actions, 0, 1});
      break;
    }
    case ActionKind::Change:
      s.pool = action.target;
      break;
    case ActionKind::Terminate:
      s.stop = true;
      s.reason = action.target;
      frames.clear();
      break;
    }
  }
}
} // namespace

RuntimeProgram load_ir_file(const std::string &path) {
  std::ifstream input(std::filesystem::u8path(path), std::ios::binary | std::ios::ate);
  if (!input)
    throw std::runtime_error("cannot open IR");
  const auto size = input.tellg();
  if (size < 0 || static_cast<uint64_t>(size) > kMaxFile)
    throw std::runtime_error("IR exceeds 64 MiB");
  input.seekg(0);
  const auto root = Json::parse(input);
  object(root, {"ir_version", "result_item", "items", "strings", "actions", "pools", "pool_entries",
                "rules", "condition_nodes", "condition_children", "item_resolve", "initial",
                "every_draw", "termination", "termination_condition"});
  if (u32(field(root, "ir_version"), "ir_version") != 2)
    fail("unsupported ir_version");
  RuntimeProgram p;
  p.result_item = u32(field(root, "result_item"), "result_item");
  const auto &strings = array(field(root, "strings"), "strings");
  for (const auto &value : strings) {
    if (!value.is_string())
      fail("strings contains non-string");
    p.strings.push_back(value.get<std::string>());
  }
  const auto &items = array(field(root, "items"), "items");
  if (items.empty() || p.result_item >= items.size())
    fail("invalid result_item");
  for (const auto &value : items) {
    object(value, {"id", "name"});
    if (u32(field(value, "id"), "item id") >= p.strings.size() ||
        u32(field(value, "name"), "item name") >= p.strings.size())
      fail("invalid string id");
  }
  p.result_id = p.strings[u32(field(items[p.result_item], "id"), "item id")];
  p.result_name = p.strings[u32(field(items[p.result_item], "name"), "item name")];
  const auto &actions = array(field(root, "actions"), "actions");
  for (const auto &value : actions) {
    if (!value.is_object() || !field(value, "kind").is_string())
      fail("action kind must be string");
    Action a{action_kind(field(value, "kind").get<std::string>())};
    if (a.kind == ActionKind::Terminate) {
      object(value, {"kind", "reason"});
      a.target = u32(field(value, "reason"), "reason");
      if (a.target >= p.strings.size())
        fail("invalid reason id");
    } else if (a.kind == ActionKind::Draw || a.kind == ActionKind::Change) {
      object(value, {"kind", "pool"});
      a.target = u32(field(value, "pool"), "pool");
    } else {
      object(value, {"kind", "item", "amount"});
      a.target = u32(field(value, "item"), "item");
      a.amount = i64(field(value, "amount"), "amount");
      if (a.target >= items.size() || a.amount < 0 || (a.kind != ActionKind::Set && a.amount == 0))
        fail("invalid item action");
    }
    p.actions.push_back(a);
  }
  const auto &entries = array(field(root, "pool_entries"), "pool_entries");
  for (const auto &value : entries) {
    object(value, {"threshold", "actions"});
    if (!field(value, "threshold").is_number())
      fail("CDF threshold must be number");
    p.entries.push_back({field(value, "threshold").get<double>(),
                         range(field(value, "actions"), "entry actions", p.actions.size())});
  }
  const auto &pools = array(field(root, "pools"), "pools");
  if (pools.empty())
    fail("empty pools");
  for (const auto &value : pools) {
    object(value, {"id", "entries"});
    const auto r = range(field(value, "entries"), "pool entries", p.entries.size());
    if (!r.count)
      fail("empty pool");
    p.pools.push_back({u32(field(value, "id"), "pool id"), r});
  }
  for (const auto &action : p.actions)
    if ((action.kind == ActionKind::Draw || action.kind == ActionKind::Change) &&
        action.target >= p.pools.size())
      fail("invalid pool reference");
  for (const auto &pool : p.pools) {
    if (pool.id >= p.strings.size())
      fail("invalid pool string id");
    double previous = 0;
    for (uint32_t i = 0; i < pool.entries.count; ++i) {
      const auto threshold = p.entries[pool.entries.begin + i].threshold;
      if (!std::isfinite(threshold) || threshold <= previous || threshold > 1)
        fail("invalid CDF");
      previous = threshold;
    }
    if (previous != 1.0)
      fail("CDF final value must be 1");
  }
  const auto &children = array(field(root, "condition_children"), "condition_children");
  for (const auto &value : children)
    p.children.push_back(u32(value, "condition child"));
  const auto &nodes = array(field(root, "condition_nodes"), "condition_nodes");
  for (const auto &value : nodes) {
    if (!value.is_object())
      fail("condition must be object");
    const auto kind = field(value, "kind");
    if (!kind.is_string())
      fail("condition kind must be string");
    Condition c{};
    if (kind == "check") {
      object(value, {"kind", "item", "op", "value", "actions"});
      c.actions = range(field(value, "actions"), "condition actions", p.actions.size());
      c.item = u32(field(value, "item"), "condition item");
      if (c.item >= items.size() || !field(value, "op").is_string())
        fail("invalid check");
      c.compare = compare(field(value, "op").get<std::string>());
      c.value = i64(field(value, "value"), "condition value");
    } else if (kind == "logic") {
      object(value, {"kind", "op", "children", "actions"});
      c.actions = range(field(value, "actions"), "condition actions", p.actions.size());
      c.logic = true;
      if (!field(value, "op").is_string())
        fail("invalid logic");
      const auto op = field(value, "op").get<std::string>();
      if (op == "AND")
        c.op = Logic::And;
      else if (op == "OR")
        c.op = Logic::Or;
      else
        fail("invalid logic op");
      c.children = range(field(value, "children"), "condition children", p.children.size());
      if (!c.children.count)
        fail("empty logic node");
    } else
      fail("invalid condition kind");
    p.conditions.push_back(c);
  }
  for (const auto id : p.children)
    if (id >= p.conditions.size())
      fail("invalid condition child id");
  const auto &resolves = array(field(root, "item_resolve"), "item_resolve");
  if (resolves.size() != items.size())
    fail("item_resolve size mismatch");
  for (uint32_t item = 0; item < resolves.size(); ++item) {
    const auto &value = resolves[item];
    object(value, {"retain", "reduce_per_batch", "actions"});
    Resolve r{u32(field(value, "retain"), "retain"),
              u32(field(value, "reduce_per_batch"), "reduce_per_batch"),
              range(field(value, "actions"), "resolve actions", p.actions.size())};
    uint32_t reductions = 0;
    for (uint32_t i = 0; i < r.actions.count; ++i) {
      const auto &a = p.actions[r.actions.begin + i];
      if (a.kind == ActionKind::Reduce && a.target == item) {
        ++reductions;
        if (a.amount != r.reduce_per_batch)
          fail("reduce_per_batch mismatch");
      }
    }
    if ((r.actions.count == 0) != (r.reduce_per_batch == 0) || (r.actions.count && reductions != 1))
      fail("invalid resolve");
    p.resolves.push_back(r);
  }
  const auto &rules = array(field(root, "rules"), "rules");
  for (const auto &value : rules) {
    object(value, {"id", "mode", "condition"});
    if (!field(value, "mode").is_string())
      fail("rule mode must be string");
    const auto mode = field(value, "mode").get<std::string>();
    RuleMode result = mode == "once"       ? RuleMode::Once
                      : mode == "per_draw" ? RuleMode::PerDraw
                      : mode == "repeat"
                          ? RuleMode::Repeat
                          : throw std::runtime_error("invalid IR: invalid rule mode");
    const auto condition_id = u32(field(value, "condition"), "rule condition");
    if (condition_id >= p.conditions.size() ||
        u32(field(value, "id"), "rule id") >= p.strings.size())
      fail("invalid rule reference");
    p.rules.push_back({u32(field(value, "id"), "rule id"), result, condition_id});
  }
  p.initial = range(field(root, "initial"), "initial", p.actions.size());
  p.every_draw = range(field(root, "every_draw"), "every_draw", p.actions.size());
  (void)range(field(root, "termination"), "termination", p.actions.size());
  p.termination_condition = u32(field(root, "termination_condition"), "termination condition");
  if (p.termination_condition >= p.conditions.size())
    fail("invalid termination condition");
  std::vector<uint8_t> visiting(p.conditions.size());
  const auto depth = [&](auto &&self, uint32_t id, size_t level) -> void {
    if (level > kMaxConditionDepth)
      fail("condition depth exceeds 256");
    if (visiting[id])
      fail("cyclic condition tree");
    visiting[id] = 1;
    const auto &c = p.conditions[id];
    if (c.logic)
      for (uint32_t i = 0; i < c.children.count; ++i)
        self(self, p.children[c.children.begin + i], level + 1);
    visiting[id] = 0;
  };
  for (uint32_t i = 0; i < p.conditions.size(); ++i)
    depth(depth, i, 1);
  return p;
}

RunResult single_run(const RuntimeProgram &p, int64_t seed) {
  State s{
      0, std::vector<int64_t>(p.resolves.size()),     std::vector<uint8_t>(p.rules.size()), false,
      0, std::mt19937_64(static_cast<uint64_t>(seed))};
  execute(p, s, p.initial);
  while (!s.stop) {
    execute(p, s, p.every_draw);
    if (s.stop)
      break;
    execute(p, s, {0, 0});
    const auto &pool = p.pools[s.pool];
    std::uniform_real_distribution<double> random(0.0, 1.0);
    const auto entry =
        std::lower_bound(p.entries.begin() + pool.entries.begin,
                         p.entries.begin() + pool.entries.begin + pool.entries.count, random(s.rng),
                         [](const Entry &e, double v) { return e.threshold < v; });
    execute(p, s, entry->actions);
    for (uint32_t i = 0; i < p.rules.size() && !s.stop; ++i) {
      const auto &rule = p.rules[i];
      if (rule.mode == RuleMode::Once && s.once[i])
        continue;
      do {
        std::vector<Range> ranges;
        if (!condition(p, s, rule.condition, ranges))
          break;
        s.once[i] = 1;
        for (const auto r : ranges)
          execute(p, s, r);
      } while (rule.mode == RuleMode::Repeat && !s.stop);
    }
    if (!s.stop) {
      std::vector<Range> ranges;
      if (condition(p, s, p.termination_condition, ranges))
        for (const auto r : ranges)
          execute(p, s, r);
    }
  }
  return {std::move(s.inventory), s.reason, p.strings[s.reason]};
}

namespace {
uint64_t mix_seed(int64_t seed, uint32_t chunk) {
  uint64_t x = static_cast<uint64_t>(seed) + 0x9e3779b97f4a7c15ULL * (chunk + 1);
  x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
  x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
  return x ^ (x >> 31);
}
uint32_t effective_threads(uint64_t work, uint32_t threads) {
  if (!threads)
    throw std::runtime_error("threads must be positive");
  return static_cast<uint32_t>(std::min<uint64_t>(threads, work));
}
void append(BatchResult &target, const RuntimeProgram &p, const RunResult &run) {
  const auto value = run.inventory[p.result_item];
  if (value < 0)
    throw std::runtime_error("runtime negative result item");
  target.values.push_back(static_cast<uint64_t>(value));
  target.reasons.push_back(run.reason_id);
}
void finish(BatchResult &r) {
  for (auto value : r.values) {
    if (r.total_result > std::numeric_limits<uint64_t>::max() - value)
      throw std::runtime_error("total result overflow");
    r.total_result += value;
  }
}
template <class Work>
BatchResult batches(const RuntimeProgram &p, uint64_t work, int64_t seed, uint32_t threads,
                    uint32_t requested_chunks, Work &&do_chunk,
                    const std::function<void(uint64_t)> &progress) {
  const auto chunks = effective_threads(work, requested_chunks ? requested_chunks : threads);
  const auto workers = effective_threads(chunks, threads);
  std::vector<BatchResult> parts(chunks);
  std::atomic<uint32_t> next_chunk{}, finished_workers{};
  std::atomic<uint64_t> done{};
  std::atomic<bool> stop{};
  std::exception_ptr error;
  std::mutex mutex;
  std::condition_variable finished;
  auto worker = [&] {
    try {
      while (!stop) {
        const auto chunk = next_chunk.fetch_add(1);
        if (chunk >= chunks)
          break;
        do_chunk(chunk, chunks, parts[chunk], done);
      }
    } catch (...) {
      std::lock_guard lock(mutex);
      if (!error)
        error = std::current_exception();
      stop = true;
    }
    ++finished_workers;
    finished.notify_one();
  };
  std::vector<std::jthread> pool;
  pool.reserve(workers);
  for (uint32_t i = 0; i < workers; ++i)
    pool.emplace_back(worker);
  uint64_t reported{};
  std::unique_lock lock(mutex);
  while (finished_workers < workers) {
    finished.wait_for(lock, std::chrono::milliseconds(50));
    const auto current = done.load();
    if (progress && current != reported) {
      lock.unlock();
      progress(current);
      lock.lock();
      reported = current;
    }
  }
  lock.unlock();
  for (auto &t : pool)
    t.join();
  if (error)
    std::rethrow_exception(error);
  if (progress && done != reported)
    progress(done.load());
  BatchResult result;
  for (auto &part : parts) {
    result.values.insert(result.values.end(), part.values.begin(), part.values.end());
    result.reasons.insert(result.reasons.end(), part.reasons.begin(), part.reasons.end());
  }
  finish(result);
  return result;
}
} // namespace

BatchResult simulate_fixed_runs(const RuntimeProgram &p, uint64_t total_runs, int64_t seed,
                                uint32_t threads, const std::function<void(uint64_t)> &progress,
                                uint32_t chunks) {
  if (!total_runs || total_runs > 100'000'000)
    throw std::runtime_error("total-runs out of range");
  return batches(
      p, total_runs, seed, threads, chunks,
      [&](uint32_t chunk, uint32_t chunks, BatchResult &part, std::atomic<uint64_t> &done) {
        const auto begin = total_runs * chunk / chunks, end = total_runs * (chunk + 1) / chunks;
        std::mt19937_64 rng(mix_seed(seed, chunk));
        for (auto i = begin; i < end; ++i) {
          append(part, p, single_run(p, static_cast<int64_t>(rng())));
          ++done;
        }
      },
      progress);
}

} // namespace gachasimulate
