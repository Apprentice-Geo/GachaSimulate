#pragma once

#include "gachasimulate/runtime.hpp"

#include <nlohmann/json.hpp>

namespace gachasimulate {
enum class ResultMetric : uint8_t { Draw, Cost };
struct GsrData {
  uint64_t runs{}, total_draw{};
  int64_t total_cost{};
  bool has_cost{};
  std::vector<uint64_t> draws;
  std::vector<int64_t> costs;
  std::vector<uint32_t> reasons;
  std::vector<std::string> reason_names;
};

void write_gsr_v1(const std::string &utf8_path, const RuntimeProgram &program,
                  const BatchResult &result, int64_t seed);
GsrData read_gsr_v1(const std::string &utf8_path, ResultMetric metric);
nlohmann::json analyze_gsr_v1(const std::string &utf8_path, ResultMetric metric);
} // namespace gachasimulate
