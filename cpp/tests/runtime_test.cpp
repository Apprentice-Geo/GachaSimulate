#include "gachasimulate/runtime.hpp"
#include <gtest/gtest.h>
#include <filesystem>
#include <fstream>

namespace {
std::filesystem::path write_ir(const std::string& text) {
  const auto path = std::filesystem::temp_directory_path() / "gachasimulate_runtime_test.json";
  std::ofstream(path) << text;
  return path;
}

TEST(Runtime, RunsDeterministicPoolAndResolve) {
  const auto path = write_ir(R"({"ir_version":1,"draw_count_item":0,"items":[{"id":0,"name":1},{"id":2,"name":2}],"strings":["draw_count","Draw count","target","Target","done"],"actions":[{"kind":"add_item","item":1,"amount":3},{"kind":"reduce_item","item":1,"amount":2},{"kind":"terminate","reason":4}],"pools":[{"id":0,"entries":{"begin":0,"count":1}}],"pool_entries":[{"threshold":1,"actions":{"begin":0,"count":1}}],"rules":[],"condition_nodes":[{"kind":"check","item":1,"op":">=","value":1,"actions":{"begin":2,"count":1}}],"condition_children":[],"item_resolve":[{"retain":0,"reduce_per_batch":0,"actions":{"begin":0,"count":0}},{"retain":1,"reduce_per_batch":2,"actions":{"begin":1,"count":1}}],"initial":{"begin":0,"count":0},"every_draw":{"begin":0,"count":0},"termination":{"begin":0,"count":0},"termination_condition":0})");
  const auto result = gachasimulate::single_run(gachasimulate::load_ir_file(path.string()), 7);
  EXPECT_EQ(result.inventory[0], 1); EXPECT_EQ(result.inventory[1], 1); EXPECT_EQ(result.reason, "done");
}

TEST(Loader, RejectsMismatchedResolveBatch) {
  const auto path = write_ir(R"({"ir_version":1,"draw_count_item":0,"items":[{"id":0,"name":0}],"strings":["x"],"actions":[],"pools":[],"pool_entries":[],"rules":[],"condition_nodes":[],"condition_children":[],"item_resolve":[{"retain":0,"reduce_per_batch":1,"actions":{"begin":0,"count":0}}],"initial":{"begin":0,"count":0},"every_draw":{"begin":0,"count":0},"termination":{"begin":0,"count":0},"termination_condition":0})");
  EXPECT_THROW(gachasimulate::load_ir_file(path.string()), std::runtime_error);
}
}  // namespace
