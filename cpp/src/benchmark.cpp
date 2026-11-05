#include "cli.hpp"
#include "gachasimulate/result.hpp"
#include "gachasimulate/runtime.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>

namespace {
using gachasimulate::cli::argument;
using gachasimulate::cli::integer;
[[noreturn]] void usage() {
  throw std::runtime_error("usage: gachasimulate-benchmark --ir <path> --total-runs <positive> "
                           "--seed <int64> --threads <positive> --output <absolute .gsr path>");
}
} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  try {
    std::string ir, output;
    uint64_t runs{};
    int64_t seed{};
    uint32_t threads{};
    for (int i = 1; i < argc; ++i) {
      const std::string arg = argument(argv[i]);
      if (++i == argc)
        usage();
      const auto value = argument(argv[i]);
      if (arg == "--ir")
        ir = value;
      else if (arg == "--total-runs")
        runs = integer<uint64_t>(value, "total-runs");
      else if (arg == "--seed")
        seed = integer<int64_t>(value, "seed");
      else if (arg == "--threads")
        threads = integer<uint32_t>(value, "threads");
      else if (arg == "--output")
        output = value;
      else
        usage();
    }
    const auto path = gachasimulate::utf8_path(output);
    if (ir.empty() || !runs || !threads || !path.is_absolute() || path.extension() != ".gsr" ||
        std::filesystem::exists(path))
      usage();
    const auto start = std::chrono::steady_clock::now();
    const auto program = gachasimulate::load_ir_file(ir);
    const auto result = gachasimulate::simulate_fixed_runs(
        program, {.total_runs = runs, .seed = seed, .threads = threads});
    gachasimulate::write_gsr_v2(output, program, result, seed);
    const auto elapsed =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::cout << "{\"elapsed_ms\":" << elapsed << ",\"total_runs\":" << result.values.size()
              << ",\"total_result\":" << result.total_result
              << ",\"gsr_bytes\":" << std::filesystem::file_size(path) << "}\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
