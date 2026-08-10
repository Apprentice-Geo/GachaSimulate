#include "gachasimulate/runtime.hpp"
#include <iostream>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#endif

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
  try {
    std::string path; int64_t seed = 0; bool single = false;
#ifdef _WIN32
    const auto utf8 = [](const wchar_t* value) {
      const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
      if (!size) throw std::runtime_error("invalid Unicode command line");
      std::string result(size, '\0');
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr, nullptr);
      result.pop_back(); return result;
    };
#endif
    for (int i = 1; i < argc; ++i) {
#ifdef _WIN32
      const std::string arg = utf8(argv[i]);
#else
      const std::string arg = argv[i];
#endif
      if (arg == "--ir" && ++i < argc) {
#ifdef _WIN32
        path = utf8(argv[i]);
#else
        path = argv[i];
#endif
      } else if (arg == "--seed" && ++i < argc) {
#ifdef _WIN32
        seed = std::stoll(utf8(argv[i]));
#else
        seed = std::stoll(argv[i]);
#endif
      }
      else if (arg == "--single-run") single = true;
      else throw std::runtime_error("usage: gachasimulate-core --ir <utf8-path> --single-run --seed <int64>");
    }
    if (path.empty() || !single) throw std::runtime_error("usage: gachasimulate-core --ir <utf8-path> --single-run --seed <int64>");
    const auto result = gachasimulate::single_run(gachasimulate::load_ir_file(path), seed);
    std::cout << "{\"inventory\":[";
    for (size_t i = 0; i < result.inventory.size(); ++i) std::cout << (i ? "," : "") << result.inventory[i];
    std::cout << "],\"draw_count\":" << result.draw_count << ",\"termination_reason\":\"";
    for (char c : result.reason) { if (c == '\\' || c == '\"') std::cout << '\\'; std::cout << c; }
    std::cout << "\"}\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
