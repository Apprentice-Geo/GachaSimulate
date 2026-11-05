#include "gachasimulate/runtime.hpp"

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
std::string path_utf8(const std::filesystem::path &path) {
  const auto value = path.u8string();
  return {reinterpret_cast<const char *>(value.data()), value.size()};
}

class IrSafety : public ::testing::Test {
protected:
  nlohmann::json ir;
  std::filesystem::path path;

  void SetUp() override {
    std::ifstream input(gachasimulate::utf8_path(GACHASIMULATE_TEST_FIXTURE));
    ir = nlohmann::json::parse(input);
    path = std::filesystem::temp_directory_path() /
           (std::string("gachasimulate_ir_") +
            ::testing::UnitTest::GetInstance()->current_test_info()->name() + ".json");
  }
  void TearDown() override { std::filesystem::remove(path); }

  gachasimulate::RuntimeProgram load() {
    {
      std::ofstream output(path);
      output << ir;
    }
    return gachasimulate::load_ir_file(path_utf8(path));
  }

  void append_logic(std::initializer_list<uint32_t> children) {
    const auto begin = ir["condition_children"].size();
    for (const auto child : children)
      ir["condition_children"].push_back(child);
    ir["condition_nodes"].push_back({{"kind", "logic"},
                                     {"op", "AND"},
                                     {"children", {{"begin", begin}, {"count", children.size()}}},
                                     {"actions", {{"begin", 0}, {"count", 0}}}});
  }
};

TEST_F(IrSafety, ValidatesSharedConditionDag) {
  // Each node refers twice to the previous subgraph. Expanding paths would visit
  // trillions of nodes, although the entire graph has only 40 nodes and 78 edges.
  for (uint32_t i = 1; i < 40; ++i)
    append_logic({i - 1, i - 1});
  EXPECT_EQ(load().conditions.size(), 40U);
}

TEST_F(IrSafety, ChecksDepthOfPreviouslyValidatedSubgraphs) {
  // Nodes are visited in index order, so every child has already been cached.
  for (uint32_t i = 1; i < 256; ++i)
    append_logic({i - 1});
  EXPECT_EQ(load().conditions.size(), 256U);
  append_logic({255});
  try {
    load();
    FAIL() << "accepted a condition path deeper than 256";
  } catch (const std::runtime_error &error) {
    EXPECT_STREQ(error.what(), "invalid IR: condition depth exceeds 256");
  }
}

TEST_F(IrSafety, RejectsCyclesInUnreferencedConditions) {
  append_logic({2});
  append_logic({1});
  try {
    load();
    FAIL() << "accepted a cycle outside the termination condition";
  } catch (const std::runtime_error &error) {
    EXPECT_STREQ(error.what(), "invalid IR: cyclic condition tree");
  }
}

TEST_F(IrSafety, RejectsDeepForwardConditionPaths) {
  const auto leaf = ir["condition_nodes"][0];
  ir["condition_nodes"] = nlohmann::json::array();
  for (uint32_t i = 0; i < 10'000; ++i)
    append_logic({i + 1});
  ir["condition_nodes"].push_back(leaf);
  EXPECT_THROW(load(), std::runtime_error);
}

TEST(BatchSafety, PropagatesWorkerFailureWithoutReturningPartialResults) {
  auto program = gachasimulate::load_ir_file(GACHASIMULATE_TEST_FIXTURE);
  program.result_item = 1;
  program.actions[1].amount = 5;
  program.conditions[0].value = -100;
  try {
    gachasimulate::simulate_fixed_runs(program, {.total_runs = 100'000, .seed = 0, .threads = 4});
    FAIL() << "returned a partial batch after a run failed";
  } catch (const std::runtime_error &error) {
    EXPECT_STREQ(error.what(), "runtime negative result item");
  }
}

TEST(BatchSafety, PropagatesProgressFailureOnCallingThreadAndCanRunAgain) {
  const auto program = gachasimulate::load_ir_file(GACHASIMULATE_TEST_FIXTURE);
  const auto caller = std::this_thread::get_id();
  struct ProgressFailure : std::runtime_error {
    ProgressFailure() : std::runtime_error("progress failure") {}
  };
  unsigned calls{};
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(program,
                                                  {.total_runs = 2'000, .seed = 0, .threads = 2},
                                                  [&](uint64_t) {
                                                    EXPECT_EQ(std::this_thread::get_id(), caller);
                                                    ++calls;
                                                    throw ProgressFailure{};
                                                  }),
               ProgressFailure);
  EXPECT_EQ(calls, 1U);
  const auto result =
      gachasimulate::simulate_fixed_runs(program, {.total_runs = 3, .seed = 0, .threads = 2});
  EXPECT_EQ(result.values, (std::vector<uint64_t>{1, 1, 1}));
  EXPECT_EQ(result.total_result, 3U);
}
} // namespace
