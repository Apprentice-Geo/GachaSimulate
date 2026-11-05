#include "cli.hpp"
#include "gachasimulate/result.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using gachasimulate::cli::argument;
[[noreturn]] void usage() {
  throw std::runtime_error("usage: gachasimulate-analyze --input <file.gsr>");
}
} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  try {
    std::string input;
    for (int i = 1; i < argc; ++i) {
      const auto arg = argument(argv[i]);
      auto value = [&] { return ++i < argc ? argument(argv[i]) : (usage(), std::string{}); };
      if (arg == "--input" && input.empty())
        input = value();
      else
        usage();
    }
    if (input.empty())
      usage();
    std::cout << gachasimulate::analyze_gsr_v2(input) << '\n';
    return 0;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
