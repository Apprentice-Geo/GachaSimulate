#include "gachasimulate/result.hpp"

#include <gtest/gtest.h>

#include <filesystem>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
class GsrWriterTest : public ::testing::Test {
protected:
  gachasimulate::RuntimeProgram program;
  std::string path;

  void SetUp() override {
    program.result_id = "result";
    program.result_name = "Result";
    const auto filename = std::string("gachasimulate_gsr_writer_") +
                          ::testing::UnitTest::GetInstance()->current_test_info()->name() + ".gsr";
    const auto value = (std::filesystem::temp_directory_path() / filename).u8string();
    path.assign(reinterpret_cast<const char *>(value.data()), value.size());
  }

  void TearDown() override {
    std::error_code ignored;
    std::filesystem::remove(gachasimulate::utf8_path(path), ignored);
  }
};

TEST_F(GsrWriterTest, MapsSparseIdsAndSameNameAliasesWithoutUsingUnreferencedStrings) {
  program.strings.resize(1'001);
  program.strings[0] = "bravo";
  program.strings[500] = "alpha";
  program.strings[1'000] = "bravo";
  program.strings[1] = std::string(1, static_cast<char>(0xFF));
  const gachasimulate::BatchResult batch{{1, 2, 3, 4, 5}, {1'000, 500, 0, 500, 1'000}, 15};
  gachasimulate::write_gsr_v2(path, program, batch, 0);

  const auto data = gachasimulate::read_gsr_v2(path);
  EXPECT_EQ(data.reason_names, (std::vector<std::string>{"alpha", "bravo"}));
  EXPECT_EQ(data.reasons, (std::vector<uint32_t>{1, 0, 1, 0, 1}));
  EXPECT_EQ(data.values, batch.values);
  EXPECT_EQ(data.total_result, batch.total_result);
}

TEST_F(GsrWriterTest, WritesARepeatedLongReasonOnceInTheStringTable) {
  constexpr uint64_t runs = 4'096;
  program.strings = {std::string(65'536, 'a')};
  const gachasimulate::BatchResult batch{std::vector<uint64_t>(runs, 1),
                                         std::vector<uint32_t>(runs, 0), runs};
  gachasimulate::write_gsr_v2(path, program, batch, 0);

  const auto data = gachasimulate::read_gsr_v2(path);
  EXPECT_EQ(data.reason_names, program.strings);
  EXPECT_EQ(data.reasons, batch.reasons);
  EXPECT_EQ(data.values, batch.values);
  EXPECT_EQ(std::filesystem::file_size(gachasimulate::utf8_path(path)),
            96 + runs * 12 + program.result_id.size() + program.result_name.size() + 4 +
                program.strings.front().size());
}

TEST_F(GsrWriterTest, AppliesTheReasonLimitToDistinctNamesInsteadOfOriginalIds) {
  constexpr size_t original_ids = 65'537;
  program.strings.assign(original_ids, "done");
  gachasimulate::BatchResult batch{std::vector<uint64_t>(original_ids, 0),
                                   std::vector<uint32_t>(original_ids), 0};
  std::iota(batch.reasons.begin(), batch.reasons.end(), 0);
  gachasimulate::write_gsr_v2(path, program, batch, 0);

  const auto data = gachasimulate::read_gsr_v2(path);
  EXPECT_EQ(data.reason_names, (std::vector<std::string>{"done"}));
  EXPECT_EQ(data.reasons, std::vector<uint32_t>(original_ids, 0));

  for (size_t i = 0; i < original_ids; ++i)
    program.strings[i] = std::to_string(i);
  EXPECT_THROW(gachasimulate::write_gsr_v2(path, program, batch, 0), std::runtime_error);
}

TEST_F(GsrWriterTest, RejectsInvalidReferencedStringsBeforeCreatingTheOutput) {
  const gachasimulate::BatchResult batch{{1, 1}, {0, 0}, 2};
  for (const auto &reason :
       {std::string{}, std::string(1'048'577, 'a'), std::string(1, static_cast<char>(0xFF))}) {
    program.strings = {reason};
    EXPECT_THROW(gachasimulate::write_gsr_v2(path, program, batch, 0), std::runtime_error);
    EXPECT_FALSE(std::filesystem::exists(gachasimulate::utf8_path(path)));
  }
}
} // namespace
