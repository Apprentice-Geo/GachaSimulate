#include "gachasimulate/result.hpp"
#include "gachasimulate/runtime.hpp"

#include <charconv>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>

namespace {
template <class T> T integer(const char *text, const char *name) {
  T value{};
  const auto [end, error] =
      std::from_chars(text, text + std::char_traits<char>::length(text), value);
  if (error != std::errc{} || end != text + std::char_traits<char>::length(text))
    throw std::runtime_error(std::string("invalid ") + name);
  return value;
}
[[noreturn]] void usage() {
  throw std::runtime_error("usage: gachasimulate-benchmark --ir <path> --total-runs <positive> "
                           "--seed <int64> --threads <positive> --output <absolute .gsr path>");
}
} // namespace

int main(int argc, char **argv) {
  try {
    std::string ir, output;
    uint64_t runs{};
    int64_t seed{};
    uint32_t threads{};
    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (++i == argc)
        usage();
      if (arg == "--ir")
        ir = argv[i];
      else if (arg == "--total-runs")
        runs = integer<uint64_t>(argv[i], "total-runs");
      else if (arg == "--seed")
        seed = integer<int64_t>(argv[i], "seed");
      else if (arg == "--threads")
        threads = integer<uint32_t>(argv[i], "threads");
      else if (arg == "--output")
        output = argv[i];
      else
        usage();
    }
    const auto path = gachasimulate::utf8_path(output);
    if (ir.empty() || !runs || !threads || !path.is_absolute() || path.extension() != ".gsr" ||
        std::filesystem::exists(path))
      usage();
    const auto start = std::chrono::steady_clock::now();
    const auto program = gachasimulate::load_ir_file(ir);
    const auto result = gachasimulate::simulate_fixed_runs(program, runs, seed, threads);
    gachasimulate::write_gsr_v2(output, program, result, seed);
    const auto elapsed =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::cout << "{\"elapsed_ms\":" << elapsed << ",\"total_runs\":" << result.values.size()
              << ",\"total_result\":" << result.total_result
              << ",\"gsr_bytes\":" << std::filesystem::file_size(path) << "}\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
