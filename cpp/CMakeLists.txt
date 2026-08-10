cmake_minimum_required(VERSION 3.25)
project(GachaSimulateRuntime LANGUAGES CXX)

include(CTest)
include(FetchContent)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
FetchContent_MakeAvailable(nlohmann_json)

add_library(gachasimulate_runtime src/runtime.cpp)
target_include_directories(gachasimulate_runtime PUBLIC include)
target_link_libraries(gachasimulate_runtime PUBLIC nlohmann_json::nlohmann_json)

add_executable(gachasimulate-core src/main.cpp)
target_link_libraries(gachasimulate-core PRIVATE gachasimulate_runtime)
install(TARGETS gachasimulate-core RUNTIME DESTINATION bin)

if(BUILD_TESTING)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz
    URL_HASH SHA256=8ad598c73ad796e0d8280b082cebd82a630d73e73cd3c70057938a6501bba5d7)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
  include(GoogleTest)
  add_executable(gachasimulate_runtime_tests tests/runtime_test.cpp)
  target_link_libraries(gachasimulate_runtime_tests PRIVATE gachasimulate_runtime GTest::gtest_main)
  gtest_discover_tests(gachasimulate_runtime_tests)
endif()
