#include "gachasimulate/runtime.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <bit>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {
std::filesystem::path fixture_path() { return std::filesystem::u8path(GACHASIMULATE_TEST_FIXTURE); }
std::filesystem::path cost_fixture_path() {
  return std::filesystem::u8path(GACHASIMULATE_TEST_COST_FIXTURE);
}

template <class T> T read(const std::vector<unsigned char> &bytes, size_t offset) {
  std::array<unsigned char, sizeof(T)> data{};
  std::copy_n(bytes.begin() + static_cast<std::ptrdiff_t>(offset), sizeof(T), data.begin());
  return std::bit_cast<T>(data);
}
std::vector<unsigned char> bytes(const std::filesystem::path &path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), {}};
}
std::filesystem::path output_path(const char *name) {
  return std::filesystem::temp_directory_path() / (std::string("gachasimulate_") + name + ".gsr");
}
void expect_gsr(const std::filesystem::path &path, uint64_t runs, bool has_cost) {
  const auto data = bytes(path);
  ASSERT_GE(data.size(), 96U);
  EXPECT_EQ(std::string(data.begin(), data.begin() + 4), std::string("GSR\0", 4));
  EXPECT_EQ(read<uint32_t>(data, 4), 1U);
  EXPECT_EQ(read<uint32_t>(data, 8), 96U);
  EXPECT_EQ(read<uint32_t>(data, 12) & 1U, has_cost ? 1U : 0U);
  EXPECT_EQ(read<uint64_t>(data, 16), runs);
  EXPECT_EQ(read<uint64_t>(data, 24), runs);
  EXPECT_EQ(read<uint64_t>(data, 56), 96U);
  EXPECT_EQ(read<uint64_t>(data, 64) != 0, has_cost);
  EXPECT_EQ(read<uint64_t>(data, 88), data.size());
  const auto reason_offset = read<uint64_t>(data, 72);
  const auto string_offset = read<uint64_t>(data, 80);
  ASSERT_LT(reason_offset, string_offset);
  EXPECT_EQ(read<uint32_t>(data, static_cast<size_t>(reason_offset)), 0U);
  EXPECT_EQ(read<uint32_t>(data, 48), 1U);
  EXPECT_EQ(read<uint32_t>(data, static_cast<size_t>(string_offset)), 4U);
  EXPECT_EQ(std::string(data.begin() + static_cast<std::ptrdiff_t>(string_offset + 4), data.end()),
            "done");
}

TEST(Runtime, RunsPoolResolveAndTerminationFixture) {
  const auto result =
      gachasimulate::single_run(gachasimulate::load_ir_file(fixture_path().string()), 7);
  ASSERT_EQ(result.inventory.size(), 2U);
  EXPECT_EQ(result.inventory[0], 1);
  EXPECT_EQ(result.inventory[1], 1);
  EXPECT_EQ(result.reason, "done");
}

TEST(Batch, FixedRunsCountsAndIsRepeatable) {
  const auto program = gachasimulate::load_ir_file(fixture_path().string());
  const auto serial = gachasimulate::simulate_fixed_runs(program, 7, 123, 1);
  const auto parallel = gachasimulate::simulate_fixed_runs(program, 7, 123, 3);
  const auto repeat = gachasimulate::simulate_fixed_runs(program, 7, 123, 3);
  EXPECT_EQ(serial.draws.size(), 7U);
  EXPECT_EQ(parallel.draws.size(), 7U);
  EXPECT_EQ(parallel.draws, repeat.draws);
  EXPECT_EQ(parallel.reasons, repeat.reasons);
}

TEST(Batch, TargetTotalDrawReachesTarget) {
  const auto result = gachasimulate::simulate_until_total_draw(
      gachasimulate::load_ir_file(fixture_path().string()), 7, 123, 3);
  EXPECT_GE(result.total_draw, 7U);
}

TEST(Gsr, WritesHeaderArraysReasonRemapAndOptionalCost) {
  const auto plain = output_path("plain_test");
  const auto cost = output_path("cost_test");
  std::filesystem::remove(plain);
  std::filesystem::remove(cost);
  const auto program = gachasimulate::load_ir_file(fixture_path().string());
  gachasimulate::write_gsr_v1(plain.string(), program,
                              gachasimulate::simulate_fixed_runs(program, 3, 123, 1), 123);
  expect_gsr(plain, 3, false);
  const auto cost_program = gachasimulate::load_ir_file(cost_fixture_path().string());
  gachasimulate::write_gsr_v1(cost.string(), cost_program,
                              gachasimulate::simulate_fixed_runs(cost_program, 3, 123, 1), 123);
  expect_gsr(cost, 3, true);
  std::filesystem::remove(plain);
  std::filesystem::remove(cost);
}
} // namespace
