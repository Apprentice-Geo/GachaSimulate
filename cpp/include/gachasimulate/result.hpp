#ifndef GACHASIMULATE_RESULT_HPP
#define GACHASIMULATE_RESULT_HPP

#include "gachasimulate/runtime.hpp"

namespace gachasimulate {
inline constexpr uint64_t kAnalysisJsonByteLimit = 64ULL * 1024 * 1024;

struct GsrData {
  uint64_t runs{}, total_result{};
  std::string result_id;
  std::string result_name;
  std::vector<uint64_t> values;
  std::vector<uint32_t> reasons;
  std::vector<std::string> reason_names;
};

void write_gsr_v2(const std::string &utf8_path, const RuntimeProgram &program,
                  const BatchResult &result, int64_t seed);
GsrData read_gsr_v2(const std::string &utf8_path);
std::string analyze_gsr_v2(const std::string &utf8_path,
                           uint64_t byte_limit = kAnalysisJsonByteLimit);
} // namespace gachasimulate

#endif
