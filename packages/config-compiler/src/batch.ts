import type { TerminationYaml } from "./types.js";
import { prepare_config, validate_termination } from "./compiler.js";
import { CompilerError, parse_yaml } from "./validation.js";

export function validate_config_files(
  config_text: string,
  terminations: readonly TerminationYaml[],
): string[] {
  let config;
  try {
    config = prepare_config(parse_yaml(config_text, "config"));
  } catch (error) {
    if (error instanceof CompilerError) return ["config.yaml"];
    throw error;
  }

  const failed: string[] = [];
  for (const termination of terminations) {
    try {
      validate_termination(config, parse_yaml(termination.text, "termination"));
    } catch (error) {
      if (error instanceof CompilerError) failed.push(termination.file);
      else throw error;
    }
  }
  return failed;
}
