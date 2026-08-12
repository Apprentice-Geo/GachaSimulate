#include "gachasimulate/result.hpp"
#include "gachasimulate/runtime.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
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

template <class T> T read(const std::vector<unsigned char> &data, size_t offset) {
  std::array<unsigned char, sizeof(T)> bytes{};
  std::copy_n(data.begin() + static_cast<std::ptrdiff_t>(offset), sizeof(T), bytes.begin());
  return std::bit_cast<T>(bytes);
}
template <class T> void set(std::vector<unsigned char> &data, size_t offset, T value) {
  for (size_t i = 0; i < sizeof(T); ++i)
    data[offset + i] = static_cast<unsigned char>(value >> (8 * i));
}
std::vector<unsigned char> bytes(const std::filesystem::path &path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), {}};
}
void write_bytes(const std::filesystem::path &path, const std::vector<unsigned char> &data) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char *>(data.data()),
               static_cast<std::streamsize>(data.size()));
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
  result.erase(
      std::remove_if(result.begin(), result.end(), [](unsigned char c) { return std::isspace(c); }),
      result.end());
  return result;
}
std::filesystem::path output_path(const char *name) {
  return std::filesystem::temp_directory_path() / (std::string("gachasimulate_") + name + ".gsr");
}

void expect_gsr(const std::filesystem::path &path, uint64_t runs, uint64_t total_result,
                const std::string &result_id, const std::string &result_name) {
  const auto data = bytes(path);
  ASSERT_GE(data.size(), 96U);
  EXPECT_EQ(std::string(data.begin(), data.begin() + 4), std::string("GSR\0", 4));
  EXPECT_EQ(read<uint32_t>(data, 4), 2U);
  EXPECT_EQ(read<uint32_t>(data, 8), 96U);
  EXPECT_EQ(read<uint32_t>(data, 12), 0U);
  EXPECT_EQ(read<uint64_t>(data, 16), runs);
  EXPECT_EQ(read<uint64_t>(data, 24), total_result);
  EXPECT_EQ(read<uint64_t>(data, 56), 96U);
  EXPECT_EQ(read<uint64_t>(data, 64), 96U + runs * 8);
  EXPECT_EQ(read<uint64_t>(data, 72), 96U + runs * 12);
  EXPECT_EQ(read<uint64_t>(data, 80), data.size());
  EXPECT_EQ(read<uint64_t>(data, 88), 0U);
  EXPECT_EQ(read<uint32_t>(data, 40), 1U);
  EXPECT_EQ(read<uint32_t>(data, 44), result_id.size());
  EXPECT_EQ(read<uint32_t>(data, 48), result_name.size());
  EXPECT_EQ(std::string(data.begin() + 96 + static_cast<std::ptrdiff_t>(runs * 8),
                        data.begin() + 96 + static_cast<std::ptrdiff_t>(runs * 12)),
            std::string(runs * 4, '\0'));
}

TEST(Runtime, RunsPoolResolveAndTerminationFixture) {
  const auto result =
      gachasimulate::single_run(gachasimulate::load_ir_file(fixture_path().string()), 7);
  ASSERT_EQ(result.inventory.size(), 2U);
  EXPECT_EQ(result.inventory[0], 1);
  EXPECT_EQ(result.inventory[1], 1);
  EXPECT_EQ(result.reason, "done");
}

TEST(Runtime, RejectsV1AndInvalidPoolReference) {
  const auto path = std::filesystem::temp_directory_path() / "gachasimulate_invalid_ir.json";
  std::ifstream input(random_fixture_path());
  auto ir = nlohmann::json::parse(input);
  ir["ir_version"] = 1;
  std::ofstream(path) << ir;
  EXPECT_THROW(gachasimulate::load_ir_file(path.string()), std::runtime_error);
  ir["ir_version"] = 2;
  ir["actions"][2]["pool"] = 1;
  std::ofstream(path) << ir;
  EXPECT_THROW(gachasimulate::load_ir_file(path.string()), std::runtime_error);
  std::filesystem::remove(path);
}

TEST(Batch, FixedRunsCountsAndIsRepeatable) {
  const auto program = gachasimulate::load_ir_file(random_fixture_path().string());
  const auto serial = gachasimulate::simulate_fixed_runs(program, 100, 123, 1, {}, 3);
  const auto parallel = gachasimulate::simulate_fixed_runs(program, 100, 123, 3, {}, 3);
  const auto repeat = gachasimulate::simulate_fixed_runs(program, 100, 123, 3, {}, 3);
  EXPECT_EQ(serial.values.size(), 100U);
  EXPECT_EQ(serial.values, parallel.values);
  EXPECT_EQ(serial.reasons, parallel.reasons);
  EXPECT_EQ(serial.total_result, parallel.total_result);
  EXPECT_EQ(parallel.values, repeat.values);
  EXPECT_EQ(parallel.reasons, repeat.reasons);
  EXPECT_EQ(parallel.total_result, repeat.total_result);
}

TEST(Batch, SupportsAnArbitraryResultItem) {
  const auto program = gachasimulate::load_ir_file(cost_fixture_path().string());
  const auto result = gachasimulate::simulate_fixed_runs(program, 3, 123, 1);
  EXPECT_EQ(result.values, (std::vector<uint64_t>{7, 7, 7}));
  EXPECT_EQ(result.total_result, 21U);
}

TEST(Batch, RejectsZeroWorkersAndInvalidResultValues) {
  const auto program = gachasimulate::load_ir_file(random_fixture_path().string());
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(program, 1, 123, 0, {}, 1), std::runtime_error);
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(program, 100'000'001, 123, 1),
               std::runtime_error);

  auto negative = gachasimulate::load_ir_file(fixture_path().string());
  negative.result_item = 1;
  negative.actions[1].amount = 5;
  negative.conditions[0].value = -100;
  EXPECT_LT(gachasimulate::single_run(negative, 123).inventory[1], 0);
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(negative, 1, 123, 1), std::runtime_error);

  auto overflow = gachasimulate::load_ir_file(fixture_path().string());
  overflow.result_item = 1;
  overflow.actions[0].amount = std::numeric_limits<int64_t>::max();
  overflow.resolves[1] = {};
  EXPECT_EQ(gachasimulate::single_run(overflow, 123).inventory[1],
            std::numeric_limits<int64_t>::max());
  EXPECT_THROW(gachasimulate::simulate_fixed_runs(overflow, 3, 123, 1), std::runtime_error);
}

TEST(Gsr, WritesV2HeaderAndFixture) {
  const auto path = output_path("v2_fixture");
  std::filesystem::remove(path);
  const auto program = gachasimulate::load_ir_file(fixture_path().string());
  const auto result = gachasimulate::simulate_fixed_runs(program, 3, 123, 1);
  gachasimulate::write_gsr_v2(path.string(), program, result, 123);
  expect_gsr(path, 3, 3, "draw_count", "Draw count");
  EXPECT_EQ(hex(bytes(path)), fixture_text(GACHASIMULATE_TEST_GSR_FIXTURE));
  std::filesystem::remove(path);
}

TEST(Gsr, RejectsInconsistentBatchDataAndOverflow) {
  const auto program = gachasimulate::load_ir_file(fixture_path().string());
  auto result = gachasimulate::simulate_fixed_runs(program, 1, 123, 1);
  result.reasons.clear();
  EXPECT_THROW(
      gachasimulate::write_gsr_v2(output_path("invalid_test").string(), program, result, 123),
      std::runtime_error);
  result = gachasimulate::simulate_fixed_runs(program, 1, 123, 1);
  result.reasons[0] = static_cast<uint32_t>(program.strings.size());
  EXPECT_THROW(gachasimulate::write_gsr_v2(output_path("invalid_reason_test").string(), program,
                                           result, 123),
               std::runtime_error);
  result = {{std::numeric_limits<uint64_t>::max(), 1}, {0, 0}, 0};
  EXPECT_THROW(
      gachasimulate::write_gsr_v2(output_path("overflow_test").string(), program, result, 123),
      std::runtime_error);
}

TEST(Gsr, ReadsAndAnalyzesV2Statistics) {
  const auto path = output_path("analysis_test");
  std::filesystem::remove(path);
  auto program = gachasimulate::load_ir_file(fixture_path().string());
  const auto exchange = static_cast<uint32_t>(program.strings.size());
  program.strings.push_back("exchange");
  const auto skin = static_cast<uint32_t>(program.strings.size());
  program.strings.push_back("skin");
  gachasimulate::BatchResult result{{1, 2, 4, 4}, {exchange, skin, skin, skin}, 11};
  gachasimulate::write_gsr_v2(path.string(), program, result, 0);
  const auto analysis = gachasimulate::analyze_gsr_v2(path.string());
  EXPECT_EQ(analysis.at("analysis_version"), 2);
  EXPECT_EQ(analysis.at("result_item"),
            nlohmann::json({{"id", "draw_count"}, {"name", "Draw count"}}));
  EXPECT_EQ(analysis.at("totals"), nlohmann::json({{"runs", "4"}, {"result", "11"}}));
  EXPECT_EQ(analysis.at("values"), nlohmann::json({"1", "2", "4"}));
  EXPECT_EQ(analysis.at("cumulative"), nlohmann::json({0.25, 0.5, 1.0}));
  EXPECT_EQ(analysis.at("statistic").at("P50"), "3");
  EXPECT_EQ(analysis.at("statistic").at("MEAN"), "2");
  EXPECT_EQ(analysis.at("statistic").at("MEAN_LEVEL"), 0.5);
  EXPECT_EQ(analysis.at("termination_reason"),
            nlohmann::json({{{"reason", "exchange"}, {"proportion", 25}},
                            {{"reason", "skin"}, {"proportion", 75}}}));
  std::filesystem::remove(path);
}

TEST(Gsr, RejectsMalformedV2HeadersSectionsReasonsAndUtf8) {
  const auto valid_path = output_path("valid_reader_test");
  const auto invalid_path = output_path("invalid_reader_test");
  std::filesystem::remove(valid_path);
  auto program = gachasimulate::load_ir_file(fixture_path().string());
  gachasimulate::write_gsr_v2(valid_path.string(), program,
                              gachasimulate::simulate_fixed_runs(program, 3, 123, 1), 123);
  const auto valid = bytes(valid_path);
  auto rejected = [&](const std::vector<unsigned char> &data) {
    write_bytes(invalid_path, data);
    EXPECT_THROW(gachasimulate::analyze_gsr_v2(invalid_path.string()), std::runtime_error);
  };
  auto changed = valid;
  changed[0] = 'X';
  rejected(changed);
  for (const auto [offset, value] : std::array<std::pair<size_t, uint32_t>, 6>{
           {{4, 1}, {8, 95}, {12, 2}, {40, 65'537}, {52, 1}, {88, 1}}}) {
    changed = valid;
    set(changed, offset, value);
    rejected(changed);
  }
  changed = valid;
  set<uint64_t>(changed, 16, 500'000'001);
  rejected(changed);
  changed = valid;
  set<uint64_t>(changed, 72, 97);
  rejected(changed);
  changed = valid;
  changed.pop_back();
  rejected(changed);
  changed = valid;
  set<uint32_t>(changed, static_cast<size_t>(read<uint64_t>(changed, 64)), 1);
  rejected(changed);
  changed = valid;
  changed.back() = 0xFF;
  rejected(changed);
  std::filesystem::remove(valid_path);
  std::filesystem::remove(invalid_path);
}
} // namespace
