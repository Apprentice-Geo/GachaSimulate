#include "gachasimulate/result.hpp"
#include "gachasimulate/runtime.hpp"

#include <charconv>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif

namespace {
using Json = nlohmann::json;
[[noreturn]] void usage() {
  throw std::runtime_error(
      "usage: gachasimulate-core --ir <path> --total-runs <positive> --seed <int64> --threads "
      "<positive> --output <absolute .gsr path>");
}
template <class T> T integer(const std::string &value, const char *name) {
  T result{};
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), result);
  if (error != std::errc{} || end != value.data() + value.size())
    throw std::runtime_error(std::string("invalid ") + name);
  return result;
}
void event(const char *name, const Json &extra = Json::object()) {
  Json line = extra;
  line["type"] = name;
  std::cout << line.dump() << '\n' << std::flush;
}
void stage(const char *name) { event("stage", {{"stage", name}}); }
#ifdef _WIN32
std::string utf8(const wchar_t *value) {
  const int size =
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (!size)
    throw std::runtime_error("invalid Unicode command line");
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr,
                      nullptr);
  result.pop_back();
  return result;
}
#endif
} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  try {
    std::string ir, output;
    int64_t seed = 0;
    uint64_t runs = 0;
    uint32_t threads = 0;
    bool haveSeed = false, haveThreads = false;
    for (int i = 1; i < argc; ++i) {
#ifdef _WIN32
      const std::string arg = utf8(argv[i]);
      auto value = [&]() {
        if (++i == argc)
          usage();
        return utf8(argv[i]);
      };
#else
      const std::string arg = argv[i];
      auto value = [&]() {
        if (++i == argc)
          usage();
        return std::string(argv[i]);
      };
#endif
      if (arg == "--ir")
        ir = value();
      else if (arg == "--output")
        output = value();
      else if (arg == "--seed") {
        seed = integer<int64_t>(value(), "seed");
        haveSeed = true;
      } else if (arg == "--threads") {
        threads = integer<uint32_t>(value(), "threads");
        haveThreads = true;
      } else if (arg == "--total-runs") {
        runs = integer<uint64_t>(value(), "total-runs");
      } else
        usage();
    }
    const auto resultPath = std::filesystem::u8path(output);
    if (ir.empty() || output.empty() || !haveSeed || !haveThreads || !threads || !runs ||
        !resultPath.is_absolute() || resultPath.extension() != ".gsr" ||
        std::filesystem::exists(resultPath))
      usage();
    event("started");
    stage("loading_config");
    const auto program = gachasimulate::load_ir_file(ir);
    stage("simulating");
    int lastPercent = 0;
    auto lastProgress = std::chrono::steady_clock::now();
    const auto report_progress = [&](uint64_t completed) {
      completed = std::min(completed, runs);
      const auto percent = static_cast<int>(completed * 100 / runs);
      const auto now = std::chrono::steady_clock::now();
      if (completed != runs &&
          (percent <= lastPercent || now - lastProgress < std::chrono::milliseconds(100)))
        return;
      event("progress", {{"completed", completed}, {"total", runs}, {"unit", "runs"}});
      lastPercent = percent;
      lastProgress = now;
    };
    const auto result =
        gachasimulate::simulate_fixed_runs(program, runs, seed, threads, report_progress);
    stage("saving");
    gachasimulate::write_gsr_v2(output, program, result, seed);
    event("completed", {{"result_path", output},
                        {"total_runs", result.values.size()},
                        {"total_result", result.total_result}});
    return 0;
  } catch (const std::exception &error) {
    event("error", {{"message", error.what()}});
    std::cerr << error.what() << '\n';
    return 1;
  }
}
