#include "gachasimulate/result.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <numeric>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>

#include <nlohmann/json.hpp>

namespace gachasimulate {
namespace {
constexpr uint64_t kHeaderSize = 96;
constexpr uint64_t kMaxFileSize = 16ULL * 1024 * 1024 * 1024;
constexpr uint64_t kMaxRuns = 1'000'000'007;
constexpr uint32_t kMaxReasons = 65'536;
constexpr uint32_t kMaxStringSize = 1024 * 1024;

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
  if (offset > kMaxFileSize || count > (kMaxFileSize - offset) / width)
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
    const unsigned count = *p >= 0xC2 && *p <= 0xDF   ? 1
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

std::string read_string(std::ifstream &input, uint32_t size, uint64_t file_size, const char *name) {
  const auto position = input.tellg();
  if (!size || size > kMaxStringSize || size > file_size || position < 0 ||
      static_cast<uint64_t>(position) > file_size - size)
    throw std::runtime_error(std::string("invalid GSR: invalid ") + name + " length");
  std::string value(size, '\0');
  input.read(value.data(), size);
  if (!input || !valid_utf8(value))
    throw std::runtime_error(std::string("invalid GSR: invalid ") + name + " UTF-8");
  return value;
}

template <class T> std::string decimal(T value) { return std::to_string(value); }

using Frequencies = std::vector<std::pair<uint64_t, uint64_t>>;

uint64_t value_at(const Frequencies &frequencies, uint64_t index) {
  uint64_t cumulative{};
  for (const auto &[value, count] : frequencies) {
    cumulative += count;
    if (index < cumulative)
      return value;
  }
  throw std::runtime_error("invalid GSR: result frequency mismatch");
}

uint64_t percentile(const Frequencies &frequencies, uint64_t runs, unsigned p) {
  const long double index = static_cast<long double>(runs - 1) * p / 100;
  const auto lower = static_cast<uint64_t>(index);
  const auto fraction = index - lower;
  const auto lower_value = value_at(frequencies, lower);
  const auto upper_value = value_at(frequencies, std::min(lower + 1, runs - 1));
  return static_cast<uint64_t>(static_cast<long double>(lower_value) +
                               (static_cast<long double>(upper_value) - lower_value) * fraction);
}

nlohmann::json statistics(const Frequencies &frequencies, uint64_t mean, uint64_t runs) {
  nlohmann::json unique = nlohmann::json::array();
  nlohmann::json cumulative = nlohmann::json::array();
  uint64_t count{};
  uint64_t mean_count{};
  for (const auto &[value, frequency] : frequencies) {
    count += frequency;
    unique.push_back(decimal(value));
    cumulative.push_back(static_cast<double>(count) / runs);
    if (value <= mean)
      mean_count = count;
  }
  if (count != runs)
    throw std::runtime_error("invalid GSR: result frequency mismatch");
  return {{"values", std::move(unique)},
          {"cumulative", std::move(cumulative)},
          {"statistic",
           {{"P5", decimal(percentile(frequencies, runs, 5))},
            {"P25", decimal(percentile(frequencies, runs, 25))},
            {"P50", decimal(percentile(frequencies, runs, 50))},
            {"P75", decimal(percentile(frequencies, runs, 75))},
            {"P95", decimal(percentile(frequencies, runs, 95))},
            {"MIN", decimal(frequencies.front().first)},
            {"MEAN", decimal(mean)},
            {"MEAN_LEVEL", static_cast<double>(mean_count) / runs},
            {"MAX", decimal(frequencies.back().first)}}}};
}

nlohmann::json termination(const std::vector<std::string> &reason_names,
                           const std::vector<uint64_t> &reason_counts, uint64_t runs) {
  std::map<std::string, uint64_t> counts;
  for (size_t i = 0; i < reason_names.size(); ++i)
    if (reason_counts[i])
      counts[reason_names[i]] += reason_counts[i];
  struct Share {
    std::string reason;
    uint64_t remainder{};
    unsigned proportion{};
  };
  std::vector<Share> shares;
  unsigned assigned{};
  for (const auto &[reason, count] : counts) {
    const auto product = count * 100;
    shares.push_back({reason, product % runs, static_cast<unsigned>(product / runs)});
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

struct GsrMetadata {
  uint64_t runs{}, total_result{};
  std::string result_id;
  std::string result_name;
  std::vector<std::string> reason_names;
};

template <class Begin, class Result, class Reason>
GsrMetadata read_gsr_v2_sections(const std::string &path, Begin &&begin, Result &&result,
                                 Reason &&reason) {
  std::ifstream input(utf8_path(path), std::ios::binary | std::ios::ate);
  if (!input)
    throw std::runtime_error("cannot open GSR");
  const auto end = input.tellg();
  if (end < 0 || static_cast<uint64_t>(end) > kMaxFileSize)
    throw std::runtime_error("invalid GSR: file exceeds 16 GiB");
  const auto actual_size = static_cast<uint64_t>(end);
  input.seekg(0);
  std::array<char, 4> magic{};
  input.read(magic.data(), magic.size());
  if (!input || magic != std::array<char, 4>{'G', 'S', 'R', '\0'})
    throw std::runtime_error("invalid GSR: bad magic");
  const auto version = get<uint32_t>(input, "version");
  const auto header_size = get<uint32_t>(input, "header size");
  const auto flags = get<uint32_t>(input, "flags");
  GsrMetadata data;
  data.runs = get<uint64_t>(input, "total runs");
  data.total_result = get<uint64_t>(input, "total result");
  static_cast<void>(get<int64_t>(input, "seed"));
  const auto reason_count = get<uint32_t>(input, "reason count");
  const auto result_id_size = get<uint32_t>(input, "result id size");
  const auto result_name_size = get<uint32_t>(input, "result name size");
  const auto reserved32 = get<uint32_t>(input, "reserved");
  const auto result_offset = get<uint64_t>(input, "result offset");
  const auto reason_offset = get<uint64_t>(input, "reason offset");
  const auto string_offset = get<uint64_t>(input, "string offset");
  const auto declared_size = get<uint64_t>(input, "file size");
  const auto reserved64 = get<uint64_t>(input, "reserved");
  if (version != 2 || header_size != kHeaderSize || flags || reserved32 || reserved64 ||
      !data.runs || data.runs > kMaxRuns || !reason_count || reason_count > kMaxReasons ||
      !result_id_size || !result_name_size || result_id_size > kMaxStringSize ||
      result_name_size > kMaxStringSize || declared_size != actual_size ||
      result_offset != kHeaderSize)
    throw std::runtime_error("invalid GSR: invalid header");
  const auto result_end = checked_section(result_offset, data.runs, 8, "result section");
  const auto reason_end = checked_section(reason_offset, data.runs, 4, "reason section");
  if (reason_offset != result_end || string_offset != reason_end || string_offset > actual_size ||
      result_id_size > actual_size - string_offset ||
      result_name_size > actual_size - string_offset - result_id_size)
    throw std::runtime_error("invalid GSR: invalid section offsets");

  begin(data.runs, reason_count);
  input.seekg(static_cast<std::streamoff>(result_offset));
  uint64_t total{};
  for (uint64_t i = 0; i < data.runs; ++i) {
    const auto value = get<uint64_t>(input, "result value");
    if (value > std::numeric_limits<uint64_t>::max() - total)
      throw std::runtime_error("invalid GSR: result total overflow");
    total += value;
    result(value);
  }
  if (total != data.total_result)
    throw std::runtime_error("invalid GSR: result total mismatch");
  input.seekg(static_cast<std::streamoff>(reason_offset));
  for (uint64_t i = 0; i < data.runs; ++i) {
    const auto id = get<uint32_t>(input, "reason id");
    if (id >= reason_count)
      throw std::runtime_error("invalid GSR: invalid reason id");
    reason(id);
  }
  input.seekg(static_cast<std::streamoff>(string_offset));
  data.result_id = read_string(input, result_id_size, actual_size, "result id");
  data.result_name = read_string(input, result_name_size, actual_size, "result name");
  data.reason_names.reserve(reason_count);
  for (uint32_t i = 0; i < reason_count; ++i)
    data.reason_names.push_back(
        read_string(input, get<uint32_t>(input, "reason length"), actual_size, "reason"));
  if (input.tellg() < 0 || static_cast<uint64_t>(input.tellg()) != actual_size)
    throw std::runtime_error("invalid GSR: trailing data");
  return data;
}

void add_minimum_json_bytes(uint64_t &size, uint64_t addition, uint64_t limit) {
  if (size > limit || addition > limit - size) {
    size = limit == std::numeric_limits<uint64_t>::max() ? limit : limit + 1;
    throw std::runtime_error("analysis JSON exceeds 64 MiB");
  }
  size += addition;
}
} // namespace

GsrData read_gsr_v2(const std::string &path) {
  GsrData data;
  const auto metadata = read_gsr_v2_sections(
      path,
      [&](uint64_t runs, uint32_t) {
        data.values.reserve(static_cast<size_t>(runs));
        data.reasons.reserve(static_cast<size_t>(runs));
      },
      [&](uint64_t value) { data.values.push_back(value); },
      [&](uint32_t reason) { data.reasons.push_back(reason); });
  data.runs = metadata.runs;
  data.total_result = metadata.total_result;
  data.result_id = metadata.result_id;
  data.result_name = metadata.result_name;
  data.reason_names = metadata.reason_names;
  return data;
}

void write_gsr_v2(const std::string &path, const RuntimeProgram &p, const BatchResult &r,
                  int64_t seed) {
  if (r.values.empty() || r.values.size() > kMaxRuns || r.values.size() != r.reasons.size())
    throw std::runtime_error("invalid batch result");
  uint64_t total{};
  for (const auto value : r.values) {
    if (value > std::numeric_limits<uint64_t>::max() - total)
      throw std::runtime_error("total result overflow");
    total += value;
  }
  if (total != r.total_result)
    throw std::runtime_error("invalid batch totals");
  if (p.result_id.empty() || p.result_name.empty() || p.result_id.size() > kMaxStringSize ||
      p.result_name.size() > kMaxStringSize || !valid_utf8(p.result_id) ||
      !valid_utf8(p.result_name))
    throw std::runtime_error("invalid result item string");
  std::vector<uint32_t> raw = r.reasons;
  for (const auto id : raw)
    if (id >= p.strings.size() || p.strings[id].empty() || p.strings[id].size() > kMaxStringSize ||
        !valid_utf8(p.strings[id]))
      throw std::runtime_error("invalid reason string");
  std::sort(raw.begin(), raw.end(),
            [&](uint32_t left, uint32_t right) { return p.strings[left] < p.strings[right]; });
  raw.erase(std::unique(
                raw.begin(), raw.end(),
                [&](uint32_t left, uint32_t right) { return p.strings[left] == p.strings[right]; }),
            raw.end());
  if (raw.empty() || raw.size() > kMaxReasons)
    throw std::runtime_error("invalid reason count");
  std::vector<uint32_t> reasons;
  reasons.reserve(r.reasons.size());
  uint64_t strings_size = p.result_id.size() + p.result_name.size();
  for (const auto id : raw)
    strings_size += 4 + p.strings[id].size();
  for (const auto id : r.reasons)
    reasons.push_back(
        static_cast<uint32_t>(std::lower_bound(raw.begin(), raw.end(), p.strings[id],
                                               [&](uint32_t raw_id, const std::string &reason) {
                                                 return p.strings[raw_id] < reason;
                                               }) -
                              raw.begin()));
  const auto result_offset = kHeaderSize;
  const auto reason_offset = checked_section(result_offset, r.values.size(), 8, "result section");
  const auto string_offset = checked_section(reason_offset, reasons.size(), 4, "reason section");
  if (strings_size > kMaxFileSize - string_offset)
    throw std::runtime_error("GSR exceeds 16 GiB");
  const auto file_size = string_offset + strings_size;
  std::ofstream out(utf8_path(path), std::ios::binary | std::ios::trunc);
  if (!out)
    throw std::runtime_error("cannot create output");
  out.write("GSR\0", 4);
  put<uint32_t>(out, 2);
  put<uint32_t>(out, kHeaderSize);
  put<uint32_t>(out, 0);
  put<uint64_t>(out, r.values.size());
  put<uint64_t>(out, r.total_result);
  put<int64_t>(out, seed);
  put<uint32_t>(out, raw.size());
  put<uint32_t>(out, p.result_id.size());
  put<uint32_t>(out, p.result_name.size());
  put<uint32_t>(out, 0);
  put<uint64_t>(out, result_offset);
  put<uint64_t>(out, reason_offset);
  put<uint64_t>(out, string_offset);
  put<uint64_t>(out, file_size);
  put<uint64_t>(out, 0);
  for (const auto value : r.values)
    put<uint64_t>(out, value);
  for (const auto value : reasons)
    put<uint32_t>(out, value);
  out.write(p.result_id.data(), static_cast<std::streamsize>(p.result_id.size()));
  out.write(p.result_name.data(), static_cast<std::streamsize>(p.result_name.size()));
  for (const auto id : raw) {
    put<uint32_t>(out, p.strings[id].size());
    out.write(p.strings[id].data(), static_cast<std::streamsize>(p.strings[id].size()));
  }
  if (!out)
    throw std::runtime_error("failed writing GSR");
}

std::string analyze_gsr_v2(const std::string &path, uint64_t byte_limit) {
  std::unordered_map<uint64_t, uint64_t> counts;
  std::vector<uint64_t> reason_counts;
  // This saturated lower bound counts only bytes that every compact Analysis JSON must contain
  // for its values and cumulative arrays. It is unrelated to hash-table memory, and because no
  // optional or representation-dependent bytes are counted, early rejection cannot discard an
  // output that might still fit within the byte limit.
  uint64_t minimum_json_bytes = 4; // The two pairs of array brackets.
  const auto data = read_gsr_v2_sections(
      path,
      [&](uint64_t runs, uint32_t reason_count) {
        counts.reserve(static_cast<size_t>(std::min<uint64_t>(runs, 1'000'000)));
        reason_counts.assign(reason_count, 0);
        if (minimum_json_bytes > byte_limit)
          throw std::runtime_error("analysis JSON exceeds 64 MiB");
      },
      [&](uint64_t value) {
        const auto [entry, inserted] = counts.try_emplace(value, 0);
        ++entry->second;
        if (inserted) {
          const auto separators = counts.size() == 1 ? 0U : 2U;
          add_minimum_json_bytes(minimum_json_bytes, decimal(value).size() + 3U + separators,
                                 byte_limit);
        }
      },
      [&](uint32_t reason) { ++reason_counts[reason]; });
  Frequencies frequencies(counts.begin(), counts.end());
  std::sort(frequencies.begin(), frequencies.end(),
            [](const auto &left, const auto &right) { return left.first < right.first; });
  nlohmann::json output{
      {"result_item", {{"id", data.result_id}, {"name", data.result_name}}},
      {"totals", {{"runs", decimal(data.runs)}, {"result", decimal(data.total_result)}}},
      {"termination_reason", termination(data.reason_names, reason_counts, data.runs)}};
  output.update(statistics(frequencies, data.total_result / data.runs, data.runs));
  auto serialized = output.dump();
  if (serialized.size() > byte_limit)
    throw std::runtime_error("analysis JSON exceeds 64 MiB");
  return serialized;
}
} // namespace gachasimulate
