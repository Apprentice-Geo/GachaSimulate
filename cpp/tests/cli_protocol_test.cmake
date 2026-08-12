file(REMOVE "${OUTPUT}")
execute_process(
  COMMAND "${CORE}" --ir "${FIXTURE}" --total-runs 7 --seed 123 --threads 3 --output "${OUTPUT}"
  RESULT_VARIABLE result
  OUTPUT_VARIABLE stdout
  ERROR_VARIABLE stderr)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "core failed: ${stderr}")
endif()
foreach(expected
    "{\"type\":\"started\"}"
    "{\"stage\":\"loading_config\",\"type\":\"stage\"}"
    "{\"stage\":\"simulating\",\"type\":\"stage\"}"
    "\"type\":\"progress\""
    "{\"stage\":\"saving\",\"type\":\"stage\"}"
    "\"type\":\"completed\""
    "\"total_result\":7"
    "\"total_runs\":7")
  string(FIND "${stdout}" "${expected}" position)
  if(position EQUAL -1)
    message(FATAL_ERROR "missing JSONL fragment ${expected}: ${stdout}")
  endif()
endforeach()
string(FIND "${stdout}" "\"event\":" legacy_event)
if(NOT legacy_event EQUAL -1)
  message(FATAL_ERROR "legacy event field found: ${stdout}")
endif()
file(REMOVE "${OUTPUT}")
execute_process(
  COMMAND "${CORE}" --ir "${FIXTURE}.missing" --total-runs 1 --seed 123 --threads 1 --output "${OUTPUT}"
  RESULT_VARIABLE error_result
  OUTPUT_VARIABLE error_stdout)
if(error_result EQUAL 0)
  message(FATAL_ERROR "invalid IR unexpectedly succeeded")
endif()
string(FIND "${error_stdout}" "\"type\":\"error\"" error_event)
if(error_event EQUAL -1)
  message(FATAL_ERROR "missing JSONL error event: ${error_stdout}")
endif()
file(REMOVE "${OUTPUT}")
