#include "gachasimulate/result.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <nlohmann/json.hpp>
#include <numeric>
#include <stdexcept>
#include <type_traits>

namespace gachasimulate {
namespace {
constexpr uint64_t kHeaderSize = 96;
constexpr uint64_t kMaxFileSize = 4ULL * 1024 * 1024 * 1024;
constexpr uint64_t kMaxRuns = 500'000'000;
constexpr uint32_t kMaxReasons = 65'536;
constexpr uint32_t kMaxReasonSize = 1024 * 1024;

template <class T> void put(std::ofstream &out, T value) {
  static_assert(std::is_integral_v<T>);
  for (size_t i = 0; i < sizeof(T); ++i)
    out.put(static_cast<char>(static_cast<std::make_unsigned_t<T>>(value) >> (8 * i)));
}

template <class T> T get(std::ifstream &input, const char *name) {
  std::array<unsigned char, sizeof(T)> bytes{};
  input.read(reinterpret_cast<char *>(bytes.data()), bytes.size());
  if (!input)
    throw std::runtime_error(std::string("invalid GSR: truncated ") + name);
  std::make_unsigned_t<T> value{};
  for (size_t i = 0; i < bytes.size(); ++i)
    value |= static_cast<std::make_unsigned_t<T>>(bytes[i]) << (8 * i);
  return static_cast<T>(value);
}

uint64_t checked_section(uint64_t offset, uint64_t count, uint64_t width, const char *name) {
  if (count > (kMaxFileSize - offset) / width)
    throw std::runtime_error(std::string("invalid GSR: ") + name + " exceeds file limit");
  return offset + count * width;
}

bool valid_utf8(const std::string &text) {
  const auto *p = reinterpret_cast<const unsigned char *>(text.data());
  const auto *end = p + text.size();
  while (p < end) {
    if (*p < 0x80) {
      ++p;
      continue;
    }
    unsigned count = *p >= 0xC2 && *p <= 0xDF   ? 1
                     : *p >= 0xE0 && *p <= 0xEF ? 2
                     : *p >= 0xF0 && *p <= 0xF4 ? 3
                                                : 0;
    if (!count || static_cast<size_t>(end - p) <= count)
      return false;
    const auto first = *p;
    for (unsigned i = 1; i <= count; ++i)
      if ((p[i] & 0xC0) != 0x80)
        return false;
    if ((first == 0xE0 && p[1] < 0xA0) || (first == 0xED && p[1] >= 0xA0) ||
        (first == 0xF0 && p[1] < 0x90) || (first == 0xF4 && p[1] >= 0x90))
      return false;
    p += count + 1;
  }
  return true;
}

GsrData read_gsr_impl(const std::string &path, ResultMetric metric) {
  std::ifstream input(std::filesystem::u8path(path), std::ios::binary | std::ios::ate);
  if (!input)
    throw std::runtime_error("cannot open GSR");
  const auto end = input.tellg();
  if (end < 0 || static_cast<uint64_t>(end) > kMaxFileSize)
    throw std::runtime_error("invalid GSR: file exceeds 4 GiB");
  const auto actual_size = static_cast<uint64_t>(end);
  input.seekg(0);
  std::array<char, 4> magic{};
  input.read(magic.data(), magic.size());
  if (!input || magic != std::array<char, 4>{'G', 'S', 'R', '\0'})
    throw std::runtime_error("invalid GSR: bad magic");
  const auto version = get<uint32_t>(input, "version");
  const auto header_size = get<uint32_t>(input, "header size");
  const auto flags = get<uint32_t>(input, "flags");
  GsrData data;
  data.runs = get<uint64_t>(input, "total runs");
  data.total_draw = get<uint64_t>(input, "total draws");
  data.total_cost = get<int64_t>(input, "total cost");
  static_cast<void>(get<int64_t>(input, "seed"));
  const auto reason_count = get<uint32_t>(input, "reason count");
  const auto reserved = get<uint32_t>(input, "reserved");
  const auto draw_offset = get<uint64_t>(input, "draw offset");
  const auto cost_offset = get<uint64_t>(input, "cost offset");
  const auto reason_offset = get<uint64_t>(input, "reason offset");
  const auto string_offset = get<uint64_t>(input, "string offset");
  const auto declared_size = get<uint64_t>(input, "file size");
  data.has_cost = (flags & 1U) != 0;
  if (version != 1 || header_size != kHeaderSize || (flags & ~1U) || reserved || !data.runs ||
      data.runs > kMaxRuns || !reason_count || reason_count > kMaxReasons ||
      declared_size != actual_size || draw_offset != kHeaderSize)
    throw std::runtime_error("invalid GSR: invalid header");
  const auto draw_end = checked_section(draw_offset, data.runs, 8, "draw section");
  const auto expected_cost = data.has_cost ? draw_end : 0;
  const auto cost_end =
      data.has_cost ? checked_section(expected_cost, data.runs, 8, "cost section") : draw_end;
  const auto reason_end = checked_section(cost_end, data.runs, 4, "reason section");
  if (cost_offset != expected_cost || reason_offset != cost_end || string_offset != reason_end ||
      string_offset > actual_size || (!data.has_cost && data.total_cost != 0))
    throw std::runtime_error("invalid GSR: invalid section offsets");
  if (metric == ResultMetric::Cost && !data.has_cost)
    throw std::runtime_error("GSR has no cost section");

  if (metric == ResultMetric::Draw) {
    input.seekg(static_cast<std::streamoff>(draw_offset));
    data.draws.reserve(static_cast<size_t>(data.runs));
    for (uint64_t i = 0; i < data.runs; ++i)
      data.draws.push_back(get<uint64_t>(input, "draw value"));
    uint64_t total{};
    for (const auto value : data.draws) {
      if (value > std::numeric_limits<uint64_t>::max() - total)
        throw std::runtime_error("invalid GSR: draw total overflow");
      total += value;
    }
    if (total != data.total_draw)
      throw std::runtime_error("invalid GSR: draw total mismatch");
  } else {
    input.seekg(static_cast<std::streamoff>(cost_offset));
    data.costs.reserve(static_cast<size_t>(data.runs));
    for (uint64_t i = 0; i < data.runs; ++i)
      data.costs.push_back(get<int64_t>(input, "cost value"));
    int64_t total{};
    for (const auto value : data.costs) {
      if ((value > 0 && total > std::numeric_limits<int64_t>::max() - value) ||
          (value < 0 && total < std::numeric_limits<int64_t>::min() - value))
        throw std::runtime_error("invalid GSR: cost total overflow");
      total += value;
    }
    if (total != data.total_cost)
      throw std::runtime_error("invalid GSR: cost total mismatch");
  }
  input.seekg(static_cast<std::streamoff>(reason_offset));
  data.reasons.reserve(static_cast<size_t>(data.runs));
  for (uint64_t i = 0; i < data.runs; ++i) {
    const auto id = get<uint32_t>(input, "reason id");
    if (id >= reason_count)
      throw std::runtime_error("invalid GSR: invalid reason id");
    data.reasons.push_back(id);
  }
  input.seekg(static_cast<std::streamoff>(string_offset));
  data.reason_names.reserve(reason_count);
  for (uint32_t i = 0; i < reason_count; ++i) {
    const auto size = get<uint32_t>(input, "reason length");
    if (size > kMaxReasonSize || static_cast<uint64_t>(input.tellg()) + size > actual_size)
      throw std::runtime_error("invalid GSR: invalid reason length");
    std::string name(size, '\0');
    input.read(name.data(), size);
    if (!input || !valid_utf8(name))
      throw std::runtime_error("invalid GSR: invalid reason UTF-8");
    data.reason_names.push_back(std::move(name));
  }
  if (static_cast<uint64_t>(input.tellg()) != actual_size)
    throw std::runtime_error("invalid GSR: trailing data");
  return data;
}

template <class T> std::string decimal(T value) { return std::to_string(value); }

template <class T> T percentile(const std::vector<T> &values, unsigned p) {
  const long double index = static_cast<long double>(values.size() - 1) * p / 100;
  const auto lower = static_cast<size_t>(index);
  const auto fraction = index - lower;
  return static_cast<T>(
      static_cast<long double>(values[lower]) +
      (static_cast<long double>(values[std::min(lower + 1, values.size() - 1)]) - values[lower]) *
          fraction);
}

template <class T> nlohmann::json statistics(std::vector<T> values, T mean, uint64_t runs) {
  std::sort(values.begin(), values.end());
  nlohmann::json unique = nlohmann::json::array();
  nlohmann::json cumulative = nlohmann::json::array();
  for (size_t begin = 0; begin < values.size();) {
    const auto end = std::upper_bound(values.begin() + static_cast<std::ptrdiff_t>(begin),
                                      values.end(), values[begin]);
    unique.push_back(decimal(values[begin]));
    cumulative.push_back(static_cast<double>(end - values.begin()) / runs);
    begin = static_cast<size_t>(end - values.begin());
  }
  const auto level =
      static_cast<double>(std::upper_bound(values.begin(), values.end(), mean) - values.begin()) /
      runs;
  return {{"values", std::move(unique)},
          {"cumulative", std::move(cumulative)},
          {"statistic",
           {{"P5", decimal(percentile(values, 5))},
            {"P25", decimal(percentile(values, 25))},
            {"P50", decimal(percentile(values, 50))},
            {"P75", decimal(percentile(values, 75))},
            {"P95", decimal(percentile(values, 95))},
            {"MIN", decimal(values.front())},
            {"MEAN", decimal(mean)},
            {"MEAN_LEVEL", level},
            {"MAX", decimal(values.back())}}}};
}

nlohmann::json termination(const GsrData &data) {
  std::map<std::string, uint64_t> counts;
  for (const auto id : data.reasons)
    ++counts[data.reason_names[id]];
  struct Share {
    std::string reason;
    uint64_t count{}, remainder{};
    unsigned proportion{};
  };
  std::vector<Share> shares;
  unsigned assigned{};
  for (const auto &[reason, count] : counts) {
    const auto product = count * 100;
    shares.push_back(
        {reason, count, product % data.runs, static_cast<unsigned>(product / data.runs)});
    assigned += shares.back().proportion;
  }
  std::vector<size_t> order(shares.size());
  std::iota(order.begin(), order.end(), 0);
  std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    return shares[a].remainder != shares[b].remainder ? shares[a].remainder > shares[b].remainder
                                                      : shares[a].reason < shares[b].reason;
  });
  for (unsigned i = assigned; i < 100; ++i)
    ++shares[order[i - assigned]].proportion;
  nlohmann::json result = nlohmann::json::array();
  for (const auto &share : shares)
    result.push_back({{"reason", share.reason}, {"proportion", share.proportion}});
  return result;
}
} // namespace

GsrData read_gsr_v1(const std::string &path, ResultMetric metric) {
  return read_gsr_impl(path, metric);
}

void write_gsr_v1(const std::string &path, const RuntimeProgram &p, const BatchResult &r,
                  int64_t seed) {
  if (r.draws.empty() || r.draws.size() > kMaxRuns || r.draws.size() != r.reasons.size() ||
      (p.cost_item && r.costs.size() != r.draws.size()) || (!p.cost_item && !r.costs.empty()))
    throw std::runtime_error("invalid batch result");
  uint64_t total_draw{};
  for (const auto value : r.draws) {
    if (value > std::numeric_limits<uint64_t>::max() - total_draw)
      throw std::runtime_error("total draw overflow");
    total_draw += value;
  }
  int64_t total_cost{};
  for (const auto value : r.costs) {
    if ((value > 0 && total_cost > std::numeric_limits<int64_t>::max() - value) ||
        (value < 0 && total_cost < std::numeric_limits<int64_t>::min() - value))
      throw std::runtime_error("total cost overflow");
    total_cost += value;
  }
  if (total_draw != r.total_draw || total_cost != r.total_cost)
    throw std::runtime_error("invalid batch totals");
  std::vector<uint32_t> raw = r.reasons;
  std::sort(raw.begin(), raw.end());
  raw.erase(std::unique(raw.begin(), raw.end()), raw.end());
  if (raw.empty() || raw.size() > kMaxReasons)
    throw std::runtime_error("invalid reason count");
  std::vector<uint32_t> reasons;
  reasons.reserve(r.reasons.size());
  for (auto id : r.reasons) {
    if (id >= p.strings.size())
      throw std::runtime_error("invalid reason id");
    reasons.push_back(
        static_cast<uint32_t>(std::lower_bound(raw.begin(), raw.end(), id) - raw.begin()));
  }
  uint64_t strings_size{};
  for (auto id : raw) {
    const auto size = p.strings[id].size();
    if (size > kMaxReasonSize || !valid_utf8(p.strings[id]))
      throw std::runtime_error("invalid reason string");
    strings_size += 4 + size;
  }
  const uint64_t draw_off = kHeaderSize;
  const auto draw_end = checked_section(draw_off, r.draws.size(), 8, "draw section");
  const uint64_t cost_off = p.cost_item ? draw_end : 0;
  const auto cost_end =
      p.cost_item ? checked_section(cost_off, r.costs.size(), 8, "cost section") : draw_end;
  const auto reason_off = cost_end;
  const auto string_off = checked_section(reason_off, reasons.size(), 4, "reason section");
  if (strings_size > kMaxFileSize - string_off)
    throw std::runtime_error("GSR exceeds 4 GiB");
  const auto file_size = string_off + strings_size;
  std::ofstream out(std::filesystem::u8path(path), std::ios::binary | std::ios::trunc);
  if (!out)
    throw std::runtime_error("cannot create output");
  out.write("GSR\0", 4);
  put<uint32_t>(out, 1);
  put<uint32_t>(out, kHeaderSize);
  put<uint32_t>(out, p.cost_item ? 1 : 0);
  put<uint64_t>(out, r.draws.size());
  put<uint64_t>(out, r.total_draw);
  put<int64_t>(out, r.total_cost);
  put<int64_t>(out, seed);
  put<uint32_t>(out, raw.size());
  put<uint32_t>(out, 0);
  put<uint64_t>(out, draw_off);
  put<uint64_t>(out, cost_off);
  put<uint64_t>(out, reason_off);
  put<uint64_t>(out, string_off);
  put<uint64_t>(out, file_size);
  for (auto value : r.draws)
    put<uint64_t>(out, value);
  if (p.cost_item)
    for (auto value : r.costs)
      put<int64_t>(out, value);
  for (auto value : reasons)
    put<uint32_t>(out, value);
  for (auto id : raw) {
    put<uint32_t>(out, p.strings[id].size());
    out.write(p.strings[id].data(), static_cast<std::streamsize>(p.strings[id].size()));
  }
  if (!out)
    throw std::runtime_error("failed writing GSR");
}

nlohmann::json analyze_gsr_v1(const std::string &path, ResultMetric metric) {
  auto data = read_gsr_v1(path, metric);
  nlohmann::json output{{"analysis_version", 1},
                        {"metric", metric == ResultMetric::Draw ? "draw" : "cost"},
                        {"totals",
                         {{"runs", decimal(data.runs)},
                          {"draw", decimal(data.total_draw)},
                          {"cost", data.has_cost ? nlohmann::json(decimal(data.total_cost))
                                                 : nlohmann::json(nullptr)}}},
                        {"termination_reason", termination(data)}};
  nlohmann::json calculated;
  if (metric == ResultMetric::Draw) {
    const auto mean = data.total_draw / data.runs;
    calculated = statistics(std::move(data.draws), mean, data.runs);
  } else {
    const auto mean = data.total_cost / static_cast<int64_t>(data.runs);
    calculated = statistics(std::move(data.costs), mean, data.runs);
  }
  output.update(calculated);
  return output;
}
} // namespace gachasimulate
