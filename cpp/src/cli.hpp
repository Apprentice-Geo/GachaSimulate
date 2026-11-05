#ifndef GACHASIMULATE_CLI_HPP
#define GACHASIMULATE_CLI_HPP

#include <charconv>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace gachasimulate::cli {
inline std::string argument(const char *value) { return value; }

#ifdef _WIN32
inline std::string argument(const wchar_t *value) {
  const int size =
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (!size)
    throw std::runtime_error("invalid Unicode command line");
  std::string result(size, '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), size, nullptr,
                          nullptr) != size)
    throw std::runtime_error("invalid Unicode command line");
  result.pop_back();
  return result;
}
#endif

template <class T> T integer(const std::string &value, const char *name) {
  T result{};
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), result);
  if (error != std::errc{} || end != value.data() + value.size())
    throw std::runtime_error(std::string("invalid ") + name);
  return result;
}
} // namespace gachasimulate::cli

#endif
