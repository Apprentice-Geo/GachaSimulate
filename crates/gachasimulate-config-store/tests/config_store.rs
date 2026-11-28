#[path = "support/temp_dir.rs"]
mod temp_dir;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use gachasimulate_config::{compile_snapshot, read_repository_index};
use gachasimulate_config_store::{
    ConfigDownloader, ConfigStore, ConfigStoreOptions, CONFIG_INDEX_DOWNLOAD_LIMIT,
    CONFIG_REFRESH_TTL, CONFIG_ZIP_DOWNLOAD_LIMIT,
};
use gachasimulate_desktop_contract::{
    ConfigSnapshotProvider, ConfigSource, DesktopError, DesktopErrorCode, RepositoryConfigStatus,
};
use gachasimulate_types::{fixtures::config_package, ConfigPackageBytes, ConfigRepositoryIndex};
use sha2::{Digest, Sha256};
use temp_dir::TempDir;
use url::Url;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const INDEX: &str = "https://repo.example/dist/index.json";
const PACKAGE: &str = "https://repo.example/dist/packages/foo.zip";

#[derive(Default)]
struct FakeDownloader {
    responses: Mutex<HashMap<String, Vec<u8>>>,
    calls: Mutex<Vec<(String, usize)>>,
}

impl FakeDownloader {
    fn serve(&self, url: &str, bytes: Vec<u8>) {
        self.responses.lock().unwrap().insert(url.into(), bytes);
    }

    fn serve_package(&self, zip: Vec<u8>) -> ConfigRepositoryIndex {
        let mut index = config_package().index;
        let entry = &mut index.configs[0];
        entry.id = "foo".into();
        entry.download_url = "packages/foo.zip".into();
        entry.sha256 = digest(&zip);
        self.serve(INDEX, serde_json::to_vec(&index).unwrap());
        self.serve(PACKAGE, zip);
        index
    }
}

impl ConfigDownloader for FakeDownloader {
    fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
        self.calls.lock().unwrap().push((url.into(), limit));
        self.responses
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| DesktopError::new(DesktopErrorCode::Repository, "offline"))
    }
}

fn options(downloader: Arc<dyn ConfigDownloader>) -> ConfigStoreOptions {
    ConfigStoreOptions {
        index_url: INDEX.into(),
        downloader,
        ..ConfigStoreOptions::default()
    }
}

fn digest(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(hex, "{byte:02x}").unwrap();
    }
    hex
}

fn files(id: &str, initial: u32) -> Vec<ConfigPackageBytes> {
    let mut files = config_package().file_bytes;
    for file in &mut files {
        let text = String::from_utf8(std::mem::take(&mut file.bytes)).unwrap();
        file.bytes = text
            .replace("id: example", &format!("id: {id}"))
            .replace("score = 1", &format!("score = {initial}"))
            .into_bytes();
    }
    files
}

fn write_package(root: &Path, id: &str, initial: u32) {
    let dir = root.join(id);
    fs::create_dir_all(&dir).unwrap();
    for file in files(id, initial) {
        fs::write(dir.join(file.path), file.bytes).unwrap();
    }
}

fn zip_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
}

fn zip_with(
    files: &[ConfigPackageBytes],
    extra: impl FnOnce(&mut ZipWriter<Cursor<Vec<u8>>>),
) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for file in files {
        writer.start_file(&file.path, zip_options()).unwrap();
        writer.write_all(&file.bytes).unwrap();
    }
    extra(&mut writer);
    writer.finish().unwrap().into_inner()
}

fn zip(files: &[ConfigPackageBytes]) -> Vec<u8> {
    zip_with(files, |_| ())
}

fn empty_staging(root: &Path) -> bool {
    root.join(".staging").read_dir().map_or_else(
        |error| error.kind() == std::io::ErrorKind::NotFound,
        |mut entries| entries.next().is_none(),
    )
}

#[test]
fn refresh_uses_ttl_and_reports_errors_without_losing_the_last_remote_index() {
    use RepositoryConfigStatus::{Available, Installed, Removed};

    let tmp = TempDir::new();
    let http = Arc::new(FakeDownloader::default());
    http.serve_package(zip(&files("foo", 1)));
    let time = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    let mut options = options(http.clone());
    let ticks = time.clone();
    options.now = Arc::new(move || start + Duration::from_secs(ticks.load(Ordering::Relaxed)));
    let store = ConfigStore::with_options(tmp.configs(), options).unwrap();
    let local = tmp.0.join("local");
    write_package(&local, "foo", 2);
    store.set_local_config_directory(&local).unwrap();

    assert_eq!(
        store.refresh_config_repository(None).unwrap().official[0].status,
        Available
    );
    assert_eq!(
        store.install_config("foo").unwrap().official[0].status,
        Installed
    );
    time.store(CONFIG_REFRESH_TTL.as_secs() - 1, Ordering::Relaxed);
    http.responses.lock().unwrap().remove(INDEX);
    let cached = store.refresh_config_repository(Some(false)).unwrap();
    assert_eq!(cached.source_error, None);
    assert_eq!(
        &*http.calls.lock().unwrap(),
        &[
            (INDEX.into(), CONFIG_INDEX_DOWNLOAD_LIMIT),
            (PACKAGE.into(), CONFIG_ZIP_DOWNLOAD_LIMIT)
        ]
    );

    time.store(CONFIG_REFRESH_TTL.as_secs(), Ordering::Relaxed);
    let offline = store.refresh_config_repository(None).unwrap();
    assert_eq!(offline.source_error.as_deref(), Some("offline"));
    assert_eq!(offline.official, cached.official);
    assert_eq!(offline.local_configs, cached.local_configs);
    assert_eq!(store.list_configs().unwrap().len(), 2);
    assert!(store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .is_ok());
    assert!(store.resolve_snapshot(ConfigSource::Local, "foo").is_ok());

    let mut invalid = config_package().index;
    invalid.configs[0].download_url = "packages/%252e%252e/example.zip".into();
    http.serve(INDEX, serde_json::to_vec(&invalid).unwrap());
    assert_eq!(store.refresh_config_repository(None).unwrap(), offline);
    let malformed = store.refresh_config_repository(Some(true)).unwrap();
    assert!(malformed.source_error.unwrap().contains("unsafe path"));
    assert_eq!(malformed.official, cached.official);

    http.serve(INDEX, br#"{"format_version":1,"configs":[]}"#.to_vec());
    let refreshed = store.refresh_config_repository(Some(true)).unwrap();
    assert_eq!(refreshed.source_error, None);
    assert_eq!(refreshed.official[0].status, Removed);
    assert_eq!(http.calls.lock().unwrap().len(), 5);
}

#[test]
fn package_urls_resolve_against_the_last_successful_effective_index_url() {
    const EFFECTIVE_INDEX: &str = "https://cdn.example/official/v2/index.json";
    const EFFECTIVE_PACKAGE: &str = "https://cdn.example/official/v2/packages/foo.zip";

    #[derive(Default)]
    struct RedirectedIndex {
        http: FakeDownloader,
        calls: Mutex<Vec<(String, bool)>>,
    }
    impl ConfigDownloader for RedirectedIndex {
        fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
            self.http.download(url, limit)
        }

        fn download_resolved(
            &self,
            url: &str,
            limit: usize,
            same_origin_redirects: bool,
        ) -> Result<(Vec<u8>, String), DesktopError> {
            self.calls
                .lock()
                .unwrap()
                .push((url.into(), same_origin_redirects));
            let bytes = self.download(url, limit)?;
            Ok((
                bytes,
                if url == INDEX { EFFECTIVE_INDEX } else { url }.into(),
            ))
        }
    }

    let tmp = TempDir::new();
    let downloader = Arc::new(RedirectedIndex::default());
    let package = zip(&files("foo", 1));
    downloader.http.serve_package(package.clone());
    downloader.http.responses.lock().unwrap().remove(PACKAGE);
    downloader.http.serve(EFFECTIVE_PACKAGE, package);
    let store = ConfigStore::with_options(tmp.configs(), options(downloader.clone())).unwrap();

    assert!(store
        .refresh_config_repository(None)
        .unwrap()
        .source_error
        .is_none());
    downloader.http.responses.lock().unwrap().remove(INDEX);
    assert!(store
        .refresh_config_repository(Some(true))
        .unwrap()
        .source_error
        .is_some());
    assert_eq!(
        store.install_config("foo").unwrap().official[0].status,
        RepositoryConfigStatus::Installed,
    );
    assert_eq!(
        &*downloader.calls.lock().unwrap(),
        &[
            (INDEX.into(), false),
            (INDEX.into(), false),
            (EFFECTIVE_PACKAGE.into(), true)
        ],
    );
}

#[test]
fn a_second_store_cannot_open_or_recover_the_root_until_the_first_is_dropped() {
    let tmp = TempDir::new();
    let root = tmp.configs();
    let store = ConfigStore::new(root.clone()).unwrap();
    let stage = root.join(".staging/in-progress");
    fs::create_dir_all(&stage).unwrap();

    let error = ConfigStore::new(root.clone())
        .err()
        .expect("second store acquired the lock");
    assert_eq!(error.code, DesktopErrorCode::Conflict);
    assert!(stage.is_dir());
    drop(store);

    let _store = ConfigStore::new(root).unwrap();
    assert!(!stage.exists());
}

#[test]
fn sources_with_the_same_id_coexist_and_return_independent_owned_snapshots() {
    let tmp = TempDir::new();
    let root = tmp.configs();
    fs::create_dir_all(root.join(".staging/abandoned/partial")).unwrap();
    let http = Arc::new(FakeDownloader::default());
    let package = zip(&files("foo", 1));
    assert_eq!(package, zip(&files("foo", 1)));
    http.serve_package(package);
    let store = ConfigStore::with_options(root.clone(), options(http)).unwrap();
    assert!(!root.join(".staging").exists());
    let local = tmp.0.join("local");
    write_package(&local, "foo", 2);
    write_package(&local, "aaa", 1);
    fs::create_dir(local.join("invalid")).unwrap();
    store.set_local_config_directory(&local).unwrap();
    store.refresh_config_repository(None).unwrap();
    store.install_config("foo").unwrap();

    let found = store.list_configs().unwrap();
    assert_eq!(
        found
            .iter()
            .map(|c| (c.source, c.id.as_str()))
            .collect::<Vec<_>>(),
        [
            (ConfigSource::Installed, "foo"),
            (ConfigSource::Local, "aaa"),
            (ConfigSource::Local, "foo"),
        ]
    );
    assert_eq!(found[0].items[0].id, "score");
    assert_eq!(found[0].terminations[0].file, "termination.yaml");
    assert_eq!(root.join("installed/foo").read_dir().unwrap().count(), 3);
    let official = store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .unwrap();
    let snapshot = store.resolve_snapshot(ConfigSource::Local, "foo").unwrap();
    assert!(official.snapshot.config_yaml.contains("score = 1"));
    assert!(snapshot.snapshot.config_yaml.contains("score = 2"));
    assert_eq!(snapshot.source, ConfigSource::Local);
    assert_eq!(snapshot.config_id, "foo");
    assert_eq!(
        store
            .resolve_snapshot(ConfigSource::Installed, "aaa")
            .unwrap_err()
            .code,
        DesktopErrorCode::NotFound
    );

    let new_local = tmp.0.join("new-local");
    write_package(&new_local, "different", 3);
    store.set_local_config_directory(&new_local).unwrap();
    assert_eq!(
        store
            .resolve_snapshot(ConfigSource::Local, "foo")
            .unwrap_err()
            .code,
        DesktopErrorCode::NotFound
    );
    fs::remove_dir_all(local).unwrap();
    compile_snapshot(&snapshot.snapshot, "termination.yaml", "score").unwrap();

    drop(store);
    let reopened = ConfigStore::new(root).unwrap();
    let state = reopened.get_config_repository_state().unwrap();
    assert_eq!(state.local_directory.as_deref(), new_local.to_str());
    assert_eq!(state.local_configs[0].id, "different");
    assert_eq!(state.official[0].status, RepositoryConfigStatus::Installed);
    fs::remove_dir_all(new_local).unwrap();
    let state = reopened.get_config_repository_state().unwrap();
    assert!(state.local_error.is_some());
    assert!(state.local_configs.is_empty());
    assert_eq!(reopened.list_configs().unwrap().len(), 1);
    assert!(reopened
        .uninstall_config("foo")
        .unwrap()
        .official
        .is_empty());
    assert_eq!(
        reopened
            .resolve_snapshot(ConfigSource::Installed, "foo")
            .unwrap_err()
            .code,
        DesktopErrorCode::NotFound
    );
}

#[test]
fn rejects_unsafe_archives_and_invalid_packages_without_publishing_them() {
    let tmp = TempDir::new();
    let root = tmp.configs();
    let http = Arc::new(FakeDownloader::default());
    let store = ConfigStore::with_options(root.clone(), options(http.clone())).unwrap();
    let valid = files("foo", 1);
    let extra_file = |path: &str, bytes| ConfigPackageBytes {
        path: path.into(),
        bytes,
    };

    let mut duplicate = zip(&[
        extra_file("first1.yaml", vec![]),
        extra_file("first2.yaml", vec![]),
    ]);
    let duplicate_names: Vec<_> = duplicate
        .windows(11)
        .enumerate()
        .filter_map(|(offset, name)| (name == b"first2.yaml").then_some(offset))
        .collect();
    assert_eq!(duplicate_names.len(), 2);
    for offset in duplicate_names {
        duplicate[offset..offset + 11].copy_from_slice(b"first1.yaml");
    }
    let mut non_regular = zip(&[extra_file("fifo.yaml", vec![])]);
    let central = non_regular
        .windows(4)
        .position(|bytes| bytes == b"PK\x01\x02")
        .unwrap();
    non_regular[central + 5] = 3; // Unix host system.
    non_regular[central + 40..central + 42].copy_from_slice(&0o010644u16.to_le_bytes());

    let mut cases = vec![
        ("duplicate", duplicate),
        ("not a regular file", non_regular),
        (
            "collision",
            zip(&[
                extra_file("file.yaml", vec![]),
                extra_file("FILE.yaml", vec![]),
            ]),
        ),
        (
            "64 entries",
            zip(&(0..65)
                .map(|i| extra_file(&format!("file{i}.yaml"), vec![]))
                .collect::<Vec<_>>()),
        ),
        (
            "exceeds 1 MiB",
            zip(&[extra_file("extra.yaml", vec![b'a'; 1024 * 1024 + 1])]),
        ),
        (
            "not a regular file",
            zip_with(&valid, |writer| {
                writer
                    .add_symlink("link.yaml", "config.yaml", zip_options())
                    .unwrap();
            }),
        ),
        (
            "not a regular file",
            zip_with(&valid, |writer| {
                writer.add_directory("nested/", zip_options()).unwrap();
            }),
        ),
        (
            "manifest",
            zip(&[extra_file("manifest.yaml", b"{malformed YAML".to_vec())]),
        ),
        ("manifest.id", zip(&files("wrong", 1))),
    ];
    for name in [
        "../escape.yaml",
        "nested/chunk.yaml",
        "nested\\chunk.yaml",
        "C:drive.yaml",
        "con.yaml",
        "lpt9.yaml",
        "bad\u{7f}.yaml",
    ] {
        cases.push((
            "unsafe configuration file name",
            zip(&[extra_file(name, vec![])]),
        ));
    }
    for (message, package) in cases {
        http.serve_package(package);
        store.refresh_config_repository(Some(true)).unwrap();
        let error = store.install_config("foo").unwrap_err();
        assert!(
            error.message.contains(message),
            "expected {message:?}, got {error}"
        );
        assert!(store.list_configs().unwrap().is_empty());
        assert!(empty_staging(&root));
    }
    assert!(!root.join("escape.yaml").exists());
    for id in [
        "../foo",
        "foo\\bar",
        "con",
        "lpt1",
        "C:foo",
        "FOO",
        "",
        &"x".repeat(65),
    ] {
        assert_eq!(
            store.install_config(id).unwrap_err().code,
            DesktopErrorCode::InvalidRequest
        );
        assert_eq!(
            store.uninstall_config(id).unwrap_err().code,
            DesktopErrorCode::InvalidRequest
        );
        assert_eq!(
            store
                .resolve_snapshot(ConfigSource::Local, id)
                .unwrap_err()
                .code,
            DesktopErrorCode::InvalidRequest
        );
    }
}

#[test]
fn failed_updates_keep_the_previous_snapshot_and_successful_updates_replace_it() {
    use RepositoryConfigStatus::{Available, Installed, UpdateAvailable};

    let tmp = TempDir::new();
    let root = tmp.configs();
    let http = Arc::new(FakeDownloader::default());
    let store = ConfigStore::with_options(root.clone(), options(http.clone())).unwrap();
    http.serve_package(zip(&files("foo", 1)));
    store.refresh_config_repository(None).unwrap();
    store.install_config("foo").unwrap();
    let previous = store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .unwrap();
    let sha_path = root.join("installed-meta/foo.json");
    let receipt = fs::read(&sha_path).unwrap();

    let mut broken = files("foo", 2);
    broken[0]
        .bytes
        .extend_from_slice(b"  - file: other.yaml\n    name: Broken\n");
    broken.push(ConfigPackageBytes {
        path: "other.yaml".into(),
        bytes: b"schema_version: 2\nbroken: true\n".to_vec(),
    });
    http.serve_package(zip(&broken));
    assert_eq!(
        store
            .refresh_config_repository(Some(true))
            .unwrap()
            .official[0]
            .status,
        UpdateAvailable
    );
    let error = store.update_config("foo").unwrap_err();
    assert_eq!(error.code, DesktopErrorCode::Compile);
    assert!(error.message.contains("other.yaml"));
    assert_eq!(fs::read(&sha_path).unwrap(), receipt);
    assert!(empty_staging(&root));

    let new = zip(&files("foo", 2));
    http.serve_package(new.clone());
    store.refresh_config_repository(Some(true)).unwrap();
    http.serve(PACKAGE, zip(&files("foo", 3)));
    assert!(store
        .update_config("foo")
        .unwrap_err()
        .message
        .contains("SHA-256"));
    assert!(empty_staging(&root));

    http.serve(PACKAGE, new);
    fs::remove_file(&sha_path).unwrap();
    fs::create_dir(&sha_path).unwrap(); // A directory cannot be atomically replaced by a file.
    let error = store.update_config("foo").unwrap_err();
    assert_eq!(error.code, DesktopErrorCode::Io);
    assert!(error.message.contains("foo.json"));
    assert!(empty_staging(&root));
    fs::remove_dir(&sha_path).unwrap();
    fs::write(&sha_path, receipt).unwrap();

    let restored = store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .unwrap();
    assert_eq!(restored, previous);
    compile_snapshot(&restored.snapshot, "termination.yaml", "score").unwrap();
    assert_eq!(
        store.update_config("foo").unwrap().official[0].status,
        Installed
    );
    assert!(store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .unwrap()
        .snapshot
        .config_yaml
        .contains("score = 2"));
    assert_eq!(
        store.uninstall_config("foo").unwrap().official[0].status,
        Available
    );
    assert!(!sha_path.exists());
}

#[test]
fn detects_oversized_downloads_even_when_an_injected_downloader_ignores_limits() {
    let tmp = TempDir::new();
    let http = Arc::new(FakeDownloader::default());
    let store = ConfigStore::with_options(tmp.configs(), options(http.clone())).unwrap();
    http.serve(INDEX, vec![b' '; CONFIG_INDEX_DOWNLOAD_LIMIT + 1]);
    assert!(store
        .refresh_config_repository(None)
        .unwrap()
        .source_error
        .unwrap()
        .contains("exceeds"));
    http.serve_package(vec![0; CONFIG_ZIP_DOWNLOAD_LIMIT + 1]);
    store.refresh_config_repository(Some(true)).unwrap();
    assert!(store
        .install_config("foo")
        .unwrap_err()
        .message
        .contains("exceeds"));
}

#[test]
fn local_resolution_requires_a_bounded_flat_package_and_a_real_root() {
    let tmp = TempDir::new();
    let local = tmp.0.join("local");
    write_package(&local, "foo", 1);
    let config = local.join("foo");
    let store = ConfigStore::new(tmp.configs()).unwrap();
    for invalid in [local.join("missing"), config.join("config.yaml")] {
        assert_eq!(
            store.set_local_config_directory(&invalid).unwrap_err().code,
            DesktopErrorCode::InvalidRequest
        );
    }
    store.set_local_config_directory(&local).unwrap();
    assert!(store.resolve_snapshot(ConfigSource::Local, "foo").is_ok());

    let extra = config.join("unknown.yaml");
    fs::write(&extra, b"{}\n").unwrap();
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("unexpected file"));
    fs::remove_file(extra).unwrap();

    let nested = config.join("nested.yaml");
    fs::create_dir(&nested).unwrap();
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("regular file"));
    fs::remove_dir(nested).unwrap();

    let yaml = config.join("config.yaml");
    fs::write(&yaml, vec![b' '; 1024 * 1024 + 1]).unwrap();
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("exceeds"));
    write_package(&local, "foo", 1);

    for index in 0..62 {
        fs::write(config.join(format!("extra-{index}.yaml")), []).unwrap();
    }
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("64 files"));
    assert!(store.list_configs().unwrap().is_empty());
}

#[cfg(any(unix, windows))]
#[test]
fn scans_and_resolution_reject_local_symlinks() {
    #[cfg(unix)]
    use std::os::unix::fs::{symlink as symlink_dir, symlink as symlink_file};
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};

    let tmp = TempDir::new();
    let parent = tmp.0.join("parent");
    let local = parent.join("local");
    write_package(&local, "foo", 1);
    let alias = tmp.0.join("alias");
    if let Err(error) = symlink_dir(&local, &alias) {
        #[cfg(windows)]
        if error.raw_os_error() == Some(1314) {
            // Windows requires Developer Mode or symbolic-link privilege.
            return;
        }
        panic!("could not create directory symlink: {error}");
    }
    let store = ConfigStore::new(tmp.configs()).unwrap();
    assert_eq!(
        store.set_local_config_directory(&alias).unwrap_err().code,
        DesktopErrorCode::InvalidRequest
    );
    assert_eq!(
        store
            .set_local_config_directory(&alias.join("."))
            .unwrap_err()
            .code,
        DesktopErrorCode::InvalidRequest
    );
    store.set_local_config_directory(&local).unwrap();

    let yaml = local.join("foo/config.yaml");
    let target = tmp.0.join("external.yaml");
    fs::rename(&yaml, &target).unwrap();
    symlink_file(&target, &yaml).unwrap();
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("regular file"));
    assert!(store.list_configs().unwrap().is_empty());
    assert!(target.is_file());

    fs::remove_file(&yaml).unwrap();
    fs::rename(&target, &yaml).unwrap();
    let moved = tmp.0.join("moved");
    fs::rename(&parent, &moved).unwrap();
    symlink_dir(&moved, &parent).unwrap();
    assert!(fs::symlink_metadata(&local).unwrap().is_dir());
    assert!(store
        .resolve_snapshot(ConfigSource::Local, "foo")
        .unwrap_err()
        .message
        .contains("real directory"));
}

#[test]
fn mutations_conflict_with_an_in_flight_update_or_an_active_simulation() {
    struct BlockingPackage {
        response: FakeDownloader,
        entered: mpsc::Sender<()>,
        proceed: Mutex<mpsc::Receiver<()>>,
    }
    impl ConfigDownloader for BlockingPackage {
        fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
            if url == PACKAGE {
                self.entered.send(()).unwrap();
                self.proceed
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }
            self.response.download(url, limit)
        }
    }
    let tmp = TempDir::new();
    let (entered, downloading) = mpsc::channel();
    let (proceed, wait) = mpsc::channel();
    let http = Arc::new(BlockingPackage {
        response: FakeDownloader::default(),
        entered,
        proceed: Mutex::new(wait),
    });
    http.response.serve_package(zip(&files("foo", 1)));
    let active = Arc::new(AtomicBool::new(false));
    let simulation = active.clone();
    let mut options = options(http);
    options.simulation_active = Some(Arc::new(move || simulation.load(Ordering::SeqCst)));
    let store = Arc::new(ConfigStore::with_options(tmp.configs(), options).unwrap());
    store.refresh_config_repository(None).unwrap();
    let worker_store = store.clone();
    let install = std::thread::spawn(move || worker_store.install_config("foo"));
    downloading.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        store.update_config("foo").unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        store.uninstall_config("foo").unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        store.set_local_config_directory(&tmp.0).unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert!(store.list_configs().unwrap().is_empty());
    active.store(true, Ordering::SeqCst);
    proceed.send(()).unwrap();
    assert_eq!(
        install.join().unwrap().unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert!(empty_staging(&tmp.configs()));
    assert_eq!(
        store.install_config("foo").unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        store.update_config("foo").unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        store.uninstall_config("foo").unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        store.set_local_config_directory(&tmp.0).unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert!(store.list_configs().unwrap().is_empty());
}

#[test]
fn update_and_uninstall_recheck_simulation_after_waiting_for_the_shared_gate() {
    struct UpdateDownload {
        http: FakeDownloader,
        entered: mpsc::Sender<()>,
        proceed: Mutex<mpsc::Receiver<()>>,
        block: AtomicBool,
    }
    impl ConfigDownloader for UpdateDownload {
        fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
            if url == PACKAGE && self.block.load(Ordering::SeqCst) {
                self.entered.send(()).unwrap();
                self.proceed
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
            }
            self.http.download(url, limit)
        }
    }
    let tmp = TempDir::new();
    let (entered, downloading) = mpsc::channel();
    let (proceed, wait) = mpsc::channel();
    let downloader = Arc::new(UpdateDownload {
        http: FakeDownloader::default(),
        entered,
        proceed: Mutex::new(wait),
        block: AtomicBool::new(false),
    });
    downloader.http.serve_package(zip(&files("foo", 1)));
    let gate = Arc::new(Mutex::new(()));
    let active = Arc::new(AtomicBool::new(false));
    let mut options = options(downloader.clone());
    options.mutation_gate = Some(gate.clone());
    let simulation = active.clone();
    options.simulation_active = Some(Arc::new(move || simulation.load(Ordering::SeqCst)));
    let store = Arc::new(ConfigStore::with_options(tmp.configs(), options).unwrap());
    store.refresh_config_repository(None).unwrap();
    store.install_config("foo").unwrap();
    let previous = store
        .resolve_snapshot(ConfigSource::Installed, "foo")
        .unwrap();
    downloader.http.serve_package(zip(&files("foo", 2)));
    store.refresh_config_repository(Some(true)).unwrap();
    downloader.block.store(true, Ordering::SeqCst);

    let (finished, result) = mpsc::channel();
    let worker = store.clone();
    let update = std::thread::spawn(move || finished.send(worker.update_config("foo")).unwrap());
    downloading.recv_timeout(Duration::from_secs(10)).unwrap();
    let simulation_admission = gate.try_lock().expect("download must not hold the gate");
    proceed.send(()).unwrap();
    assert_eq!(
        result.recv_timeout(Duration::from_millis(100)).unwrap_err(),
        mpsc::RecvTimeoutError::Timeout,
    );
    active.store(true, Ordering::SeqCst);
    drop(simulation_admission);
    let error = result
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, DesktopErrorCode::Conflict);
    update.join().unwrap();

    let simulation_admission = gate.lock().unwrap();
    active.store(false, Ordering::SeqCst);
    let (finished, result) = mpsc::channel();
    let worker = store.clone();
    let uninstall =
        std::thread::spawn(move || finished.send(worker.uninstall_config("foo")).unwrap());
    assert_eq!(
        result.recv_timeout(Duration::from_millis(100)).unwrap_err(),
        mpsc::RecvTimeoutError::Timeout,
    );
    active.store(true, Ordering::SeqCst);
    drop(simulation_admission);
    let error = result
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, DesktopErrorCode::Conflict);
    uninstall.join().unwrap();

    assert_eq!(
        store
            .resolve_snapshot(ConfigSource::Installed, "foo")
            .unwrap(),
        previous
    );
    assert_eq!(
        store.get_config_repository_state().unwrap().official[0].status,
        RepositoryConfigStatus::UpdateAvailable
    );
    assert!(empty_staging(&tmp.configs()));
}

#[test]
#[ignore = "requires GACHASIMULATE_CONFIGS_DIST to point at GachaSimulate-Configs/dist"]
fn real_1e_packages_install_and_compile_when_dist_is_supplied() {
    let dist = PathBuf::from(
        std::env::var_os("GACHASIMULATE_CONFIGS_DIST")
            .expect("GACHASIMULATE_CONFIGS_DIST must point at GachaSimulate-Configs/dist"),
    );
    let index_json = fs::read_to_string(dist.join("index.json")).unwrap();
    let index = read_repository_index(&index_json).unwrap();
    assert!(!index.configs.is_empty());
    let temp = TempDir::new();
    let http = Arc::new(FakeDownloader::default());
    let base = Url::parse(INDEX).unwrap();
    http.serve(INDEX, index_json.into_bytes());
    for entry in &index.configs {
        let url = base.join(&entry.download_url).unwrap();
        http.serve(
            url.as_str(),
            fs::read(dist.join(&entry.download_url)).unwrap(),
        );
    }
    let store = ConfigStore::with_options(temp.configs(), options(http)).unwrap();
    let state = store.refresh_config_repository(None).unwrap();
    assert!(state.source_error.is_none());
    assert_eq!(state.official.len(), index.configs.len());
    for entry in &index.configs {
        let state = store.install_config(&entry.id).unwrap();
        assert_eq!(
            state
                .official
                .iter()
                .find(|config| config.id == entry.id)
                .unwrap()
                .status,
            RepositoryConfigStatus::Installed
        );
    }
    let configs = store.list_configs().unwrap();
    assert_eq!(configs.len(), index.configs.len());
    for config in configs {
        let result = store
            .resolve_snapshot(ConfigSource::Installed, &config.id)
            .unwrap();
        for term in &config.terminations {
            compile_snapshot(&result.snapshot, &term.file, "draw_count").unwrap();
        }
    }
}
