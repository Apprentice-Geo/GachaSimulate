use gachasimulate_config::{
    compile_snapshot, compile_yaml, read_config_items, read_config_manifest, read_repository_index,
    read_repository_manifest, validate_config_files, validate_config_package, CompileError,
    RepositoryError,
};
use gachasimulate_types::fixtures::{config_package, EXAMPLE_INDEX_JSON};

#[test]
fn compiler_entry_points_accept_the_fixture() {
    let snapshot = config_package().snapshot;
    let termination = &snapshot.terminations[0];
    assert!(matches!(
        compile_snapshot(&snapshot, &termination.file, "score"),
        Err(CompileError::NotImplemented)
    ));
    assert!(matches!(
        compile_yaml(
            &snapshot.config_yaml,
            &termination.content,
            &snapshot.manifest_yaml,
            "score"
        ),
        Err(CompileError::NotImplemented)
    ));
    assert_eq!(
        validate_config_files(&snapshot.config_yaml, &snapshot.terminations)
            .unwrap_err()
            .diagnostics[0]
            .message,
        CompileError::NotImplemented.to_string()
    );
    assert!(matches!(
        read_config_items(&snapshot.config_yaml),
        Err(CompileError::NotImplemented)
    ));
    assert!(matches!(
        read_config_manifest(&snapshot.manifest_yaml),
        Err(CompileError::NotImplemented)
    ));
}

#[test]
fn repository_entry_points_accept_the_fixture() {
    let package = config_package();
    assert!(matches!(
        read_repository_index(EXAMPLE_INDEX_JSON),
        Err(RepositoryError::NotImplemented)
    ));
    assert!(matches!(
        read_repository_manifest(&package.snapshot.manifest_yaml),
        Err(RepositoryError::NotImplemented)
    ));
    assert!(matches!(
        validate_config_package(&package.index.configs[0].id, &package.file_bytes),
        Err(RepositoryError::NotImplemented)
    ));
}
