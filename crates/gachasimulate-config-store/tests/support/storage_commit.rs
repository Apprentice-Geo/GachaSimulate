#[path = "temp_dir.rs"]
mod temp_dir;

use gachasimulate_config::compile_snapshot;
use gachasimulate_desktop_contract::{ConfigSnapshotProvider, ConfigSource};
use gachasimulate_types::fixtures::config_package;

use super::*;
use crate::ConfigStore;
use temp_dir::TempDir;

fn install_fixture(storage: &Storage) {
    let path = storage.installed.join("example");
    fs::create_dir(&path).unwrap();
    for file in config_package().file_bytes {
        fs::write(path.join(file.path), file.bytes).unwrap();
    }
    write_json(
        &storage.metadata_path("example"),
        &InstallMetadata {
            id: "example".into(),
            sha256: "0".repeat(64),
        },
    )
    .unwrap();
}

#[test]
fn failure_to_rename_staged_package_restores_the_original_directory_and_receipt() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stage = storage.stage().unwrap();

    // The staged package is absent, so publishing it fails after the live
    // directory has been moved to the backup.
    let result = storage.commit_install(&stage, "example", "1".repeat(64));
    assert!(Storage::finish(&stage, result).is_err());
    assert!(!stage.exists());
    assert_eq!(storage.sha256("example"), Some("0".repeat(64)));
    let store = ConfigStore::new(tmp.configs()).unwrap();
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot, config_package().snapshot);
    compile_snapshot(&resolved.snapshot, "termination.yaml", "score").unwrap();
}

#[test]
fn startup_restores_an_interrupted_install_before_discarding_staging() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stage = storage.stage().unwrap();
    write_json(
        &stage.join(PENDING_METADATA),
        &InstallMetadata {
            id: "example".into(),
            sha256: "1".repeat(64),
        },
    )
    .unwrap();
    let live = storage.installed.join("example");
    fs::rename(&live, stage.join("backup-example")).unwrap();
    fs::create_dir(&live).unwrap();
    fs::write(live.join("config.yaml"), b"incomplete new package").unwrap();
    drop(storage);

    let store = ConfigStore::new(tmp.configs()).unwrap();
    assert!(!tmp.configs().join(".staging").exists());
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot, config_package().snapshot);
}
