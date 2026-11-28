//! In-memory YAML compiler and configuration repository protocol.

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

/// Compiles the selected termination file from a single snapshot. The
/// termination must be listed in its manifest.
pub fn compile_snapshot(
    _snapshot: &ConfigSnapshot,
    _termination_file: &str,
    _result_item: &str,
) -> Result<CompiledProgram, CompileError> {
    Err(CompileError::NotImplemented)
}

pub fn compile_yaml(
    _config_yaml: &str,
    _termination_yaml: &str,
    _manifest_yaml: &str,
    _result_item: &str,
) -> Result<CompiledProgram, CompileError> {
    Err(CompileError::NotImplemented)
}

/// Validates the config once and each termination against independent
/// compiler state. Reports failing files in input order.
pub fn validate_config_files(
    _config_yaml: &str,
    _terminations: &[TerminationSource],
) -> Result<(), BatchValidationError> {
    Err(BatchValidationError {
        failed_files: Vec::new(),
        diagnostics: vec![CompileDiagnostic {
            path: CONFIG_FILE.into(),
            message: CompileError::NotImplemented.to_string(),
        }],
    })
}

pub fn read_config_manifest(_manifest_yaml: &str) -> Result<ConfigManifest, CompileError> {
    Err(CompileError::NotImplemented)
}

pub fn read_config_items(_config_yaml: &str) -> Result<Vec<ConfigItem>, CompileError> {
    Err(CompileError::NotImplemented)
}

pub fn read_repository_index(_index_json: &str) -> Result<ConfigRepositoryIndex, RepositoryError> {
    Err(RepositoryError::NotImplemented)
}

pub fn read_repository_manifest(_manifest_yaml: &str) -> Result<ConfigManifest, RepositoryError> {
    Err(RepositoryError::NotImplemented)
}

/// Reads the manifest from the supplied file bytes and checks the repository
/// limits, directory ID, and exact file set. The caller retains the bytes for
/// compilation and for writing the package.
pub fn validate_config_package(
    _directory_id: &str,
    _files: &[ConfigPackageBytes],
) -> Result<ConfigManifest, RepositoryError> {
    Err(RepositoryError::NotImplemented)
}
