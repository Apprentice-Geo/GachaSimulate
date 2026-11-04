set(input "${OUTPUT}.中文输入.json")
set(core_output "${OUTPUT}.core.gsr")
file(REMOVE "${OUTPUT}" "${core_output}")
file(COPY_FILE "${FIXTURE}" "${input}")

execute_process(
  COMMAND "${BENCHMARK}" --ir "${input}" --total-runs 7 --seed -123 --threads 3 --output "${OUTPUT}"
  RESULT_VARIABLE result
  OUTPUT_VARIABLE stdout
  ERROR_VARIABLE stderr)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "benchmark failed for Unicode paths: ${stderr}")
endif()
string(JSON runs GET "${stdout}" total_runs)
string(JSON total GET "${stdout}" total_result)
string(JSON reported_size GET "${stdout}" gsr_bytes)
file(SIZE "${OUTPUT}" actual_size)
if(NOT runs EQUAL 7 OR NOT total EQUAL 7 OR NOT reported_size EQUAL actual_size)
  message(FATAL_ERROR "unexpected benchmark result: ${stdout}")
endif()

execute_process(
  COMMAND "${CORE}" --ir "${input}" --total-runs 7 --seed -123 --threads 3 --output "${core_output}"
  RESULT_VARIABLE result
  OUTPUT_QUIET
  ERROR_VARIABLE stderr)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "core failed for Unicode paths: ${stderr}")
endif()
file(SHA256 "${OUTPUT}" benchmark_hash)
file(SHA256 "${core_output}" core_hash)
if(NOT benchmark_hash STREQUAL core_hash)
  message(FATAL_ERROR "benchmark and core produced different GSR data")
endif()
file(REMOVE "${OUTPUT}" "${core_output}" "${input}")

function(expect_failure diagnostic)
  execute_process(
    COMMAND "${BENCHMARK}" ${ARGN}
    RESULT_VARIABLE result
    OUTPUT_VARIABLE stdout
    ERROR_VARIABLE stderr)
  string(FIND "${stderr}" "${diagnostic}" found)
  if(result EQUAL 0 OR NOT stdout STREQUAL "" OR found EQUAL -1)
    message(FATAL_ERROR "benchmark should reject arguments with '${diagnostic}': ${stdout}${stderr}")
  endif()
endfunction()

expect_failure("usage:" --output)
expect_failure("invalid seed" --seed 9223372036854775808)
expect_failure("invalid threads" --threads 4294967296)
expect_failure("invalid total-runs" --total-runs -1)
expect_failure("invalid total-runs" --total-runs 7x)
