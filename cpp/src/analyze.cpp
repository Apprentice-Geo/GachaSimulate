#include "gachasimulate/result.hpp"

#include <iostream>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#endif

namespace {
[[noreturn]] void usage() {
  throw std::runtime_error("usage: gachasimulate-analyze --input <file.gsr> --metric <draw|cost>");
}
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
    std::string input, metric;
    for (int i = 1; i < argc; ++i) {
#ifdef _WIN32
      const auto arg = utf8(argv[i]);
      auto value = [&] { return ++i < argc ? utf8(argv[i]) : (usage(), std::string{}); };
#else
      const std::string arg = argv[i];
      auto value = [&] { return ++i < argc ? std::string(argv[i]) : (usage(), std::string{}); };
#endif
      if (arg == "--input" && input.empty())
        input = value();
      else if (arg == "--metric" && metric.empty())
        metric = value();
      else
        usage();
    }
    if (input.empty() || (metric != "draw" && metric != "cost"))
      usage();
    std::cout << gachasimulate::analyze_gsr_v1(input, metric == "draw"
                                                          ? gachasimulate::ResultMetric::Draw
                                                          : gachasimulate::ResultMetric::Cost)
                     .dump()
              << '\n';
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
