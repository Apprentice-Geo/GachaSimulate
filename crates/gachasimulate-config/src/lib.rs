//! In-memory YAML compiler and configuration repository protocol.

mod compiler;
mod program_builder;
mod repository;
mod source;
mod yaml;

pub use compiler::{compile_snapshot, compile_yaml, validate_config_files};
pub use gachasimulate_types::{
    Action, ActionRange, BatchValidationError, Comparison, CompileDiagnostic, CompileError,
    CompiledProgram, ConditionNode, ConfigItem, ConfigManifest, ConfigPackageBytes,
    ConfigPackageFile, ConfigRepositoryEntry, ConfigRepositoryIndex, ConfigSnapshot,
    ConfigTermination, ItemResolve, LogicOp, Pool, PoolEntry, ProgramInvariantError,
    RepositoryError, Rule, RuleMode, TerminationSource, YamlValue, CONFIG_FILE,
    CONFIG_PACKAGE_FILE_LIMIT, CONFIG_PACKAGE_FILE_SIZE_LIMIT, CONFIG_REPOSITORY_FORMAT_VERSION,
    MANIFEST_FILE, MAX_CONDITION_DEPTH, REPOSITORY_CONFIG_LIMIT, REPOSITORY_DESCRIPTION_BYTE_LIMIT,
    REPOSITORY_ID_BYTE_LIMIT, REPOSITORY_INDEX_TEXT_LIMIT, REPOSITORY_NAME_BYTE_LIMIT,
    REPOSITORY_TERMINATION_FILE_BYTE_LIMIT, REPOSITORY_TERMINATION_LIMIT,
    REPOSITORY_TERMINATION_NAME_BYTE_LIMIT, YAML_TEXT_LIMIT,
};
pub use repository::{read_repository_index, read_repository_manifest, validate_config_package};
pub use source::{read_config_items, read_config_manifest};
