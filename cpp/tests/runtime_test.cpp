#include "gachasimulate/runtime.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <bit>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

namespace {
std::filesystem::path fixture_path() { return std::filesystem::u8path(GACHASIMULATE_TEST_FIXTURE); }
std::filesystem::path cost_fixture_path() {
  return std::filesystem::u8path(GACHASIMULATE_TEST_COST_FIXTURE);
}
std::filesystem::path random_fixture_path() {
  return std::filesystem::u8path(GACHASIMULATE_TEST_RANDOM_FIXTURE);
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
std::string hex(const std::vector<unsigned char> &data) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  for (const auto byte : data) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}
std::string fixture_text(const char *path) {
  std::ifstream input(std::filesystem::u8path(path));
  std::ostringstream output;
  output << input.rdbuf();
  auto result = output.str();
  result.erase(std::remove_if(result.begin(), result.end(), ::isspace), result.end());
  return result;
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
  const auto program = gachasimulate::load_ir_file(random_fixture_path().string());
  const auto serial = gachasimulate::simulate_fixed_runs(program, 100, 123, 1, {}, 3);
  const auto parallel = gachasimulate::simulate_fixed_runs(program, 100, 123, 3, {}, 3);
  const auto repeat = gachasimulate::simulate_fixed_runs(program, 100, 123, 3, {}, 3);
  EXPECT_EQ(serial.draws.size(), 100U);
  EXPECT_EQ(serial.draws, parallel.draws);
  EXPECT_EQ(serial.costs, parallel.costs);
  EXPECT_EQ(serial.reasons, parallel.reasons);
  EXPECT_EQ(serial.total_draw, parallel.total_draw);
  EXPECT_EQ(serial.total_cost, parallel.total_cost);
  EXPECT_EQ(parallel.draws.size(), 100U);
  EXPECT_EQ(parallel.draws, repeat.draws);
  EXPECT_EQ(parallel.costs, repeat.costs);
  EXPECT_EQ(parallel.reasons, repeat.reasons);
  EXPECT_EQ(parallel.total_draw, repeat.total_draw);
  EXPECT_EQ(parallel.total_cost, repeat.total_cost);
}

TEST(Batch, TargetTotalDrawReachesTarget) {
  const auto program = gachasimulate::load_ir_file(random_fixture_path().string());
  const auto serial = gachasimulate::simulate_until_total_draw(program, 100, 123, 1, {}, 3);
  const auto parallel = gachasimulate::simulate_until_total_draw(program, 100, 123, 3, {}, 3);
  EXPECT_GE(serial.total_draw, 100U);
  EXPECT_EQ(serial.draws, parallel.draws);
  EXPECT_EQ(serial.costs, parallel.costs);
  EXPECT_EQ(serial.reasons, parallel.reasons);
  EXPECT_EQ(serial.total_draw, parallel.total_draw);
  EXPECT_EQ(serial.total_cost, parallel.total_cost);
}

TEST(Batch, RejectsZeroWorkersWithExplicitChunks) {
  const auto program = gachasimulate::load_ir_file(random_fixture_path().string());
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(program, 1, 123, 0, {}, 1), std::runtime_error);
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
  EXPECT_EQ(hex(bytes(plain)), fixture_text(GACHASIMULATE_TEST_GSR_FIXTURE));
  const auto cost_program = gachasimulate::load_ir_file(cost_fixture_path().string());
  gachasimulate::write_gsr_v1(cost.string(), cost_program,
                              gachasimulate::simulate_fixed_runs(cost_program, 3, 123, 1), 123);
  expect_gsr(cost, 3, true);
  std::filesystem::remove(plain);
  std::filesystem::remove(cost);
}

TEST(Gsr, RejectsInconsistentBatchData) {
  const auto program = gachasimulate::load_ir_file(fixture_path().string());
  auto result = gachasimulate::simulate_fixed_runs(program, 1, 123, 1);
  result.reasons.clear();
  EXPECT_THROW(
      gachasimulate::write_gsr_v1(output_path("invalid_test").string(), program, result, 123),
      std::runtime_error);
  result = gachasimulate::simulate_fixed_runs(program, 1, 123, 1);
  result.reasons[0] = static_cast<uint32_t>(program.strings.size());
  EXPECT_THROW(gachasimulate::write_gsr_v1(output_path("invalid_reason_test").string(), program,
                                           result, 123),
               std::runtime_error);
}
} // namespace
