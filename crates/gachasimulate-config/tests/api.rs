use std::fs;
use std::path::{Path, PathBuf};

use gachasimulate_config::{
    compile_snapshot, compile_yaml, read_config_items, read_config_manifest, read_repository_index,
    read_repository_manifest, validate_config_files, validate_config_package, ConfigPackageBytes,
    ConfigSnapshot, TerminationSource,
};
use gachasimulate_types::fixtures::{config_package, deterministic_program, EXAMPLE_INDEX_JSON};

#[test]
fn compiler_entry_points_accept_the_shared_fixture() {
    let snapshot = config_package().snapshot;
    let termination = &snapshot.terminations[0];
    let program = compile_snapshot(&snapshot, &termination.file, "score").unwrap();
    let direct = compile_yaml(
        &snapshot.config_yaml,
        &termination.content,
        &snapshot.manifest_yaml,
        "score",
    )
    .unwrap();
    assert_eq!(program, direct);
    let expected = deterministic_program();
    assert_eq!(program.items, expected.items);
    assert_eq!(program.reasons, expected.reasons);
    assert_eq!(
        program.initial.get(&program.actions),
        expected.initial.get(&expected.actions)
    );
    assert_eq!(
        program.every_draw.get(&program.actions),
        expected.every_draw.get(&expected.actions)
    );
    validate_config_files(&snapshot.config_yaml, &snapshot.terminations).unwrap();
    assert_eq!(
        read_config_items(&snapshot.config_yaml).unwrap(),
        program.items
    );
    let manifest = read_config_manifest(&snapshot.manifest_yaml).unwrap();
    assert_eq!(manifest.terminations[0].file, termination.file);
}

#[test]
fn repository_entry_points_accept_the_shared_fixture() {
    let package = config_package();
    assert_eq!(
        read_repository_index(EXAMPLE_INDEX_JSON).unwrap(),
        package.index
    );
    let manifest = read_repository_manifest(&package.snapshot.manifest_yaml).unwrap();
    assert_eq!(
        validate_config_package(&package.index.configs[0].id, &package.file_bytes).unwrap(),
        manifest,
    );
}

fn sorted_children(path: &Path) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(path)
        .unwrap_or_else(|err| panic!("{}: {err}", path.display()))
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn check_sources(root: &Path, require_package: bool) -> (usize, usize) {
    if !root.join("config.yaml").is_file() {
        return sorted_children(root)
            .iter()
            .filter(|path| path.is_dir())
            .map(|path| check_sources(path, require_package))
            .fold((0, 0), |(cases, terms), (c, t)| (cases + c, terms + t));
    }
    let config_yaml = text(&root.join("config.yaml"));
    let manifest_path = root.join("manifest.yaml");
    let manifest_yaml = if manifest_path.is_file() {
        text(&manifest_path)
    } else {
        "id: benchmark\nname: Benchmark\ndescription: ''\nterminations: [{file: termination.yaml, name: Done}]\n".into()
    };
    let manifest = read_config_manifest(&manifest_yaml)
        .unwrap_or_else(|err| panic!("{}: {err}", root.display()));
    let terminations = manifest
        .terminations
        .iter()
        .map(|term| TerminationSource {
            file: term.file.clone(),
            content: text(&root.join(&term.file)),
        })
        .collect::<Vec<_>>();
    let snapshot = ConfigSnapshot {
        manifest_yaml,
        config_yaml,
        terminations,
    };
    validate_config_files(&snapshot.config_yaml, &snapshot.terminations)
        .unwrap_or_else(|err| panic!("{}: {err}: {:?}", root.display(), err.diagnostics));
    let items = read_config_items(&snapshot.config_yaml).unwrap();
    let result = items
        .iter()
        .find(|item| item.id == "draw_count")
        .unwrap_or(&items[0]);
    for term in &snapshot.terminations {
        let program = compile_snapshot(&snapshot, &term.file, &result.id)
            .unwrap_or_else(|err| panic!("{}/{}: {err}", root.display(), term.file));
        assert_eq!(program.items[program.result_item as usize], *result);
        program.validate_invariants().unwrap();
    }
    if require_package {
        let files = sorted_children(root)
            .iter()
            .map(|path| ConfigPackageBytes {
                path: path.file_name().unwrap().to_str().unwrap().into(),
                bytes: fs::read(path).unwrap(),
            })
            .collect::<Vec<_>>();
        let id = root.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            validate_config_package(id, &files)
                .unwrap_or_else(|err| panic!("{}: {err}", root.display())),
            manifest,
        );
    }
    (1, snapshot.terminations.len())
}

#[test]
fn compiles_all_repository_fixtures_and_benchmarks() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (folder, minimum) in [("test-fixtures/configs", 5), ("benchmark/cases", 6)] {
        let (cases, terms) = check_sources(&root.join(folder), false);
        assert!(
            cases >= minimum && terms >= cases,
            "{folder}: {cases} configs, {terms} terminations"
        );
    }
}

#[test]
#[ignore = "requires GACHASIMULATE_OFFICIAL_CONFIGS to point at the official configs directory"]
fn compiles_all_official_configs() {
    let path = std::env::var_os("GACHASIMULATE_OFFICIAL_CONFIGS")
        .expect("set GACHASIMULATE_OFFICIAL_CONFIGS");
    let (cases, terms) = check_sources(Path::new(&path), true);
    assert!(cases > 0 && terms >= cases);
    eprintln!("Validated {cases} official packages and {terms} terminations");
}
