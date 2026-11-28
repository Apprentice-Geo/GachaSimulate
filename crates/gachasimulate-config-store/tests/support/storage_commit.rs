use gachasimulate_config::compile_snapshot;
use gachasimulate_desktop_contract::{ConfigSnapshotProvider, ConfigSource};
use gachasimulate_types::fixtures::config_package;

use super::*;
use crate::temp_dir::TempDir;
use crate::ConfigStore;

fn write_package(path: &Path) {
    fs::create_dir(path).unwrap();
    for file in config_package().file_bytes {
        fs::write(path.join(file.path), file.bytes).unwrap();
    }
}

fn install_fixture(storage: &Storage) {
    write_package(&storage.installed.join("example"));
    // A receipt from before transaction IDs were introduced.
    fs::write(
        storage.metadata_path("example"),
        serde_json::json!({ "id": "example", "sha256": "0".repeat(64) }).to_string(),
    )
    .unwrap();
}

fn pending_install(storage: &Storage) -> PathBuf {
    let stage = storage.stage().unwrap();
    write_json(
        &storage.pending_path("example", PENDING_INSTALL),
        &InstallMetadata {
            id: "example".into(),
            sha256: "1".repeat(64),
            tx_id: Some(stage_id(&stage).into()),
        },
    )
    .unwrap();
    let live = storage.installed.join("example");
    fs::rename(&live, stage.join(BACKUP)).unwrap();
    fs::create_dir(&live).unwrap();
    fs::write(live.join("config.yaml"), b"incomplete new package").unwrap();
    stage
}

#[test]
fn receipt_publication_failure_restores_the_original_directory() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stage = storage.stage().unwrap();

    write_package(&stage.join("example"));
    let receipt = storage.metadata_path("example");
    fs::remove_file(&receipt).unwrap();
    fs::create_dir(&receipt).unwrap();
    let result = storage.commit_install(&stage, "example", "1".repeat(64));
    assert!(Storage::finish(&stage, result).is_err());
    assert!(!stage.exists());
    assert!(receipt.is_dir());
    drop(storage);
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
    pending_install(&storage);
    assert_eq!(storage.sha256("example"), Some("0".repeat(64)));
    drop(storage);

    let store = ConfigStore::new(tmp.configs()).unwrap();
    assert!(!tmp.configs().join(".staging").exists());
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot, config_package().snapshot);
}

#[test]
fn install_retains_the_previous_package_until_the_receipt_is_published() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stage = storage.stage().unwrap();
    write_package(&stage.join("example"));
    let result = storage.commit_install(&stage, "example", "2".repeat(64));
    assert!(result.is_ok());
    assert!(stage.join(BACKUP).join("manifest.yaml").is_file());
    assert_eq!(storage.sha256("example"), Some("2".repeat(64)));
    Storage::finish(&stage, result).unwrap();
    assert!(!stage.exists());
}

#[cfg(windows)]
fn deny_rename_and_delete(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .share_mode(0x3) // FILE_SHARE_READ | FILE_SHARE_WRITE
        .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS for directories
        .open(path)
        .unwrap()
}

#[cfg(windows)]
#[test]
fn failed_rollback_blocks_a_retry_until_recovered_and_restart_keeps_the_retry() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stale = pending_install(&storage);
    let live = storage.installed.join("example");
    let lock = deny_rename_and_delete(&live);

    let failed_rollback = rollback_error(
        crate::repository_error("receipt could not be published"),
        storage.recover_install("example"),
        &stale,
    );
    assert_eq!(
        Storage::finish(&stale, failed_rollback).unwrap_err().code,
        DesktopErrorCode::CleanupBlocked,
    );

    let new_yaml = config_package()
        .snapshot
        .config_yaml
        .replace("score = 1", "score = 2");
    let stage_retry = || {
        let retry = storage.stage().unwrap();
        write_package(&retry.join("example"));
        fs::write(retry.join("example/config.yaml"), &new_yaml).unwrap();
        retry
    };
    let retry = stage_retry();
    let result = storage.commit_install(&retry, "example", "2".repeat(64));
    assert_eq!(
        Storage::finish(&retry, result).unwrap_err().code,
        DesktopErrorCode::Conflict,
    );
    assert!(!retry.exists());
    assert_eq!(storage.sha256("example"), Some("0".repeat(64)));
    assert!(stale.join(BACKUP).is_dir());
    drop(lock);

    let retry = stage_retry();
    let result = storage.commit_install(&retry, "example", "2".repeat(64));
    Storage::finish(&retry, result).unwrap();
    assert!(stale.exists());
    assert_eq!(storage.sha256("example"), Some("2".repeat(64)));
    drop(storage);

    let store = ConfigStore::new(tmp.configs()).unwrap();
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot.config_yaml, new_yaml);
    assert!(!stale.exists());
}

#[test]
fn startup_restores_uncommitted_uninstall_with_or_without_a_receipt() {
    for had_receipt in [false, true] {
        let tmp = TempDir::new();
        let storage = Storage::new(&tmp.configs()).unwrap();
        install_fixture(&storage);
        let receipt = storage.metadata_path("example");
        if !had_receipt {
            fs::remove_file(&receipt).unwrap();
        }
        let stage = storage.stage().unwrap();
        write_json(
            &storage.pending_path("example", PENDING_UNINSTALL),
            &UninstallMetadata {
                id: "example".into(),
                tx_id: stage_id(&stage).into(),
                had_receipt,
            },
        )
        .unwrap();
        fs::rename(storage.installed.join("example"), stage.join(BACKUP)).unwrap();
        if had_receipt {
            fs::rename(&receipt, stage.join(REMOVED_RECEIPT)).unwrap();
        }
        drop(storage);

        let store = ConfigStore::new(tmp.configs()).unwrap();
        let snapshot = store
            .resolve_snapshot(ConfigSource::Installed, "example")
            .unwrap();
        assert_eq!(snapshot.snapshot, config_package().snapshot);
        assert_eq!(receipt.is_file(), had_receipt);
        assert!(!stage.exists());
    }
}

#[cfg(windows)]
#[test]
fn committed_uninstall_with_locked_backup_does_not_affect_reinstall_or_restart() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stage = storage.stage().unwrap();
    let result = storage.uninstall(&stage, "example");
    let backup = stage.join(BACKUP).join("config.yaml");
    let lock = deny_rename_and_delete(&backup);
    Storage::finish(&stage, result).unwrap();
    assert!(backup.is_file());
    assert!(!storage.installed.join("example").exists());
    assert_eq!(storage.sha256("example"), None);

    let reinstall = storage.stage().unwrap();
    write_package(&reinstall.join("example"));
    let new_yaml = config_package()
        .snapshot
        .config_yaml
        .replace("score = 1", "score = 3");
    fs::write(reinstall.join("example/config.yaml"), &new_yaml).unwrap();
    let result = storage.commit_install(&reinstall, "example", "3".repeat(64));
    Storage::finish(&reinstall, result).unwrap();
    drop(storage);

    let store = ConfigStore::new(tmp.configs()).unwrap();
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot.config_yaml, new_yaml);
    assert!(backup.is_file());
    drop(lock);
    drop(store);
    let store = ConfigStore::new(tmp.configs()).unwrap();
    assert_eq!(
        store
            .resolve_snapshot(ConfigSource::Installed, "example")
            .unwrap(),
        resolved,
    );
    assert!(!stage.exists());
}

#[test]
fn an_inactive_install_stage_cannot_authorize_rollback_over_a_committed_generation() {
    let tmp = TempDir::new();
    let storage = Storage::new(&tmp.configs()).unwrap();
    install_fixture(&storage);
    let stale = storage.stage().unwrap();
    let live = storage.installed.join("example");
    fs::rename(&live, stale.join("backup-example")).unwrap();
    write_json(
        &stale.join("install.json"),
        &InstallMetadata {
            id: "example".into(),
            sha256: "0".repeat(64),
            tx_id: Some(stage_id(&stale).into()),
        },
    )
    .unwrap();
    let stage = storage.stage().unwrap();
    write_package(&stage.join("example"));
    let new_yaml = config_package()
        .snapshot
        .config_yaml
        .replace("score = 1", "score = 4");
    fs::write(stage.join("example/config.yaml"), &new_yaml).unwrap();
    let result = storage.commit_install(&stage, "example", "4".repeat(64));
    Storage::finish(&stage, result).unwrap();
    drop(storage);

    let store = ConfigStore::new(tmp.configs()).unwrap();
    let resolved = store
        .resolve_snapshot(ConfigSource::Installed, "example")
        .unwrap();
    assert_eq!(resolved.snapshot.config_yaml, new_yaml);
    assert!(!stale.exists());
}
