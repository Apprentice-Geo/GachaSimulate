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
/** Compiles the v1 YAML contract to a JSON-serializable, flat arena IR. */
export declare function compile_yaml(config_text: string, termination_text: string): CompiledProgram;
export declare function compile(configValue: unknown, terminationValue: unknown): CompiledProgram;
