export declare class CompilerError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
export type ActionRange = {
    begin: number;
    count: number;
};
export type CompiledProgram = {
    ir: Record<string, unknown>;
};
export type ConfigItem = {
    id: string;
    name: string;
};
export declare function read_config_items(config_text: string): ConfigItem[];
/** Compiles the v2 YAML contract to a JSON-serializable, flat arena IR. */
export declare function compile_yaml(config_text: string, termination_text: string, manifest_text: string, result_item: string): CompiledProgram;
export declare function compile(configValue: unknown, terminationValue: unknown, manifestValue: unknown, result_item: string): CompiledProgram;
