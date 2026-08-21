cmake_minimum_required(VERSION 3.25)
project(GachaSimulateRuntime LANGUAGES CXX)

include(CTest)
include(FetchContent)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  add_compile_definitions(NOMINMAX)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
FetchContent_MakeAvailable(nlohmann_json)

add_library(gachasimulate_runtime src/runtime.cpp)
target_include_directories(gachasimulate_runtime PUBLIC include)
target_link_libraries(gachasimulate_runtime PUBLIC nlohmann_json::nlohmann_json)

add_library(gachasimulate_result src/result.cpp)
target_include_directories(gachasimulate_result PUBLIC include)
target_link_libraries(gachasimulate_result PUBLIC gachasimulate_runtime nlohmann_json::nlohmann_json)

add_executable(gachasimulate-core src/main.cpp)
target_link_libraries(gachasimulate-core PRIVATE gachasimulate_runtime gachasimulate_result)
add_executable(gachasimulate-analyze src/analyze.cpp)
target_link_libraries(gachasimulate-analyze PRIVATE gachasimulate_result)
install(TARGETS gachasimulate-core gachasimulate-analyze RUNTIME DESTINATION bin)

if(BUILD_TESTING)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz
    URL_HASH SHA256=8ad598c73ad796e0d8280b082cebd82a630d73e73cd3c70057938a6501bba5d7)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
  include(GoogleTest)
  add_executable(gachasimulate_runtime_tests tests/runtime_test.cpp)
  target_link_libraries(gachasimulate_runtime_tests PRIVATE gachasimulate_runtime gachasimulate_result GTest::gtest_main)
  target_compile_definitions(gachasimulate_runtime_tests PRIVATE
    GACHASIMULATE_TEST_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/batch_fixture_ir.json"
    GACHASIMULATE_TEST_COST_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/batch_cost_fixture_ir.json"
    GACHASIMULATE_TEST_RANDOM_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/batch_random_fixture_ir.json"
    GACHASIMULATE_TEST_GSR_FIXTURE="${CMAKE_CURRENT_SOURCE_DIR}/tests/gsr_v2_fixture.hex")
  gtest_discover_tests(gachasimulate_runtime_tests)
  add_test(NAME Cli.EmitsJsonlProtocol COMMAND ${CMAKE_COMMAND}
    -DCORE=$<TARGET_FILE:gachasimulate-core>
    -DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/tests/batch_fixture_ir.json
    -DOUTPUT=${CMAKE_CURRENT_BINARY_DIR}/cli_中文输出.gsr
    -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_protocol_test.cmake)
endif()

add_executable(gachasimulate-benchmark src/benchmark.cpp)
target_link_libraries(gachasimulate-benchmark PRIVATE gachasimulate_runtime gachasimulate_result)

set(first_party_targets
  gachasimulate_runtime
  gachasimulate_result
  gachasimulate-core
  gachasimulate-analyze
  gachasimulate-benchmark)
if(BUILD_TESTING)
  list(APPEND first_party_targets gachasimulate_runtime_tests)
endif()
set_property(TARGET ${first_party_targets} PROPERTY COMPILE_WARNING_AS_ERROR ON)
