#pragma once

#include "gachasimulate/runtime.hpp"

#include <nlohmann/json.hpp>

namespace gachasimulate {
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
nlohmann::json analyze_gsr_v2(const std::string &utf8_path);
} // namespace gachasimulate
