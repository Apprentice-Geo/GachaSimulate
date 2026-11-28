use gachasimulate_config::{
    read_repository_index, read_repository_manifest, validate_config_package, ConfigPackageBytes,
    RepositoryError, YamlValue, CONFIG_PACKAGE_FILE_SIZE_LIMIT, REPOSITORY_CONFIG_LIMIT,
    REPOSITORY_INDEX_TEXT_LIMIT, REPOSITORY_TERMINATION_LIMIT,
};
use serde_json::{json, Value};

fn entry(id: &str) -> Value {
    json!({
        "id": id,
        "name": "Example",
        "description": "Description",
        "download_url": format!("packages/{id}.zip"),
        "sha256": "0".repeat(64),
    })
}

fn index(configs: Vec<Value>) -> String {
    json!({"format_version": 1, "configs": configs}).to_string()
}

fn term(position: usize) -> Value {
    json!({"file": format!("termination_{position}.yaml"), "name": format!("Done {position}")})
}

fn manifest() -> Value {
    json!({"id": "example", "name": "Example", "description": "Description", "terminations": [term(0)]})
}

fn rejected<T: std::fmt::Debug>(result: Result<T, RepositoryError>, path: &str, message: &str) {
    let RepositoryError::Invalid {
        path: location,
        message: actual,
    } = result.unwrap_err()
    else {
        panic!("expected repository validation error");
    };
    assert_eq!(location, path, "{location}: {actual}");
    assert!(actual.contains(message), "{location}: {actual}");
}

#[test]
fn validates_index_shape_fields_ids_and_sort_order() {
    let parsed = read_repository_index(&index(vec![entry("a"), entry("a_1"), entry("b")])).unwrap();
    assert_eq!(parsed.format_version, 1);
    assert_eq!(
        parsed
            .configs
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "a_1", "b"]
    );
    assert!(
        read_repository_index("{\"format_version\":1.0,\"configs\":[]}")
            .unwrap()
            .configs
            .is_empty()
    );
    for (source, path, message) in [
        ("null", "index", "must be an object"),
        ("not json", "index", "must be valid JSON"),
        ("{\"configs\":[]}", "index.format_version", "is required"),
        ("{\"format_version\":1}", "index.configs", "is required"),
        (
            "{\"format_version\":2,\"configs\":[]}",
            "index.format_version",
            "must be 1",
        ),
        (
            "{\"format_version\":\"1\",\"configs\":[]}",
            "index.format_version",
            "must be 1",
        ),
        (
            "{\"format_version\":true,\"configs\":[]}",
            "index.format_version",
            "must be 1",
        ),
        (
            "{\"format_version\":1,\"configs\":[],\"unknown\":true}",
            "index.unknown",
            "unsupported field",
        ),
        (
            "{\"format_version\":1,\"configs\":{}}",
            "index.configs",
            "must be an array",
        ),
        (
            "{\"format_version\":1,\"configs\":[null]}",
            "index.configs[0]",
            "must be an object",
        ),
    ] {
        rejected(read_repository_index(source), path, message);
    }
    let mut missing = entry("example");
    missing.as_object_mut().unwrap().remove("name");
    rejected(
        read_repository_index(&index(vec![missing])),
        "index.configs[0].name",
        "is required",
    );
    for (field, value, message) in [
        ("unknown", json!(true), "unsupported field"),
        ("sha256", json!("A".repeat(64)), "lowercase SHA-256"),
        ("sha256", json!("0".repeat(63)), "lowercase SHA-256"),
        ("name", json!(""), "non-empty"),
        ("name", json!(" \u{feff}\t"), "non-empty"),
        ("name", json!("名".repeat(86)), "256 UTF-8 bytes"),
        ("description", json!("说".repeat(2731)), "8192 UTF-8 bytes"),
        ("description", json!(false), "must be a string"),
    ] {
        let mut modified = entry("example");
        modified[field] = value;
        rejected(
            read_repository_index(&index(vec![modified])),
            &format!("index.configs[0].{field}"),
            message,
        );
    }
    for id in [
        "",
        "Uppercase",
        "_hidden",
        "a.b",
        "a/b",
        "con",
        "prn",
        "aux",
        "nul",
        "com1",
        "com9",
        "lpt1",
        "lpt9",
    ] {
        rejected(
            read_repository_index(&index(vec![entry(id)])),
            "index.configs[0].id",
            "safe lowercase",
        );
    }
    read_repository_index(&index(vec![entry("0"), entry("com0"), entry("lpt10")])).unwrap();
    rejected(
        read_repository_index(&index(vec![entry(&"a".repeat(65))])),
        "index.configs[0].id",
        "64 UTF-8 bytes",
    );
    rejected(
        read_repository_index(&index(vec![entry("b"), entry("a")])),
        "index.configs",
        "ASCII order",
    );
    rejected(
        read_repository_index(&index(vec![entry("a"), entry("a")])),
        "index.configs[1].id",
        "must be unique",
    );
}

#[test]
fn checks_relative_download_paths_after_each_layer_of_utf8_percent_decoding() {
    let with_url = |url: &str| {
        let mut modified = entry("example");
        modified["download_url"] = json!(url);
        index(vec![modified])
    };
    for url in [
        "",
        "https://example.test/package.zip",
        " http:example.test/package.zip",
        "s+3.-:value",
        "//example.test/package.zip",
        "/packages/example.zip",
        " /packages/example.zip",
        "packages\\example.zip",
        "packages//example.zip",
        "packages/",
        "packages/.. ",
        " packages/a.zip",
        "packages/a.zip ",
        "packages/.",
        "packages/..",
        "\tpackages/a.zip",
        "packages/..\u{1f}",
        "packages/./example.zip",
        "packages/../example.zip",
        "packages/%2e%2e/example.zip",
        "packages/%252e%252e/example.zip",
        "packages/%2fexample.zip",
        "packages/%255cexample.zip",
        "packages/example.zip?download=1",
        "packages/example.zip#archive",
        "packages/%00example.zip",
        "packages/%7fexample.zip",
        "packages/\tfile.zip",
        "packages/%zz.zip",
        "packages/%",
        "packages/%25",
        "packages/%80",
        "packages/%C0%AF",
        "packages/%ED%A0%80",
        "packages/%C3%25A9",
        "packages/%%34%31",
        "packages/%25%32e/file.zip",
    ] {
        rejected(
            read_repository_index(&with_url(url)),
            "index.configs[0].download_url",
            "",
        );
    }
    for url in [
        "packages/新包.zip",
        "packages/file name.zip",
        "packages/file%20name.zip",
        "packages/%E6%96%B0.zip",
        "packages/%25C3%25A9.zip",
        "packages/name%3F.zip",
        "packages/sub:dir/package",
        "packages/%25%34%31.zip",
        "packages/a..b",
    ] {
        let parsed = read_repository_index(&with_url(url)).unwrap();
        assert_eq!(parsed.configs[0].download_url, url);
    }
    let long = format!("packages/%{}61", "25".repeat(80_000));
    read_repository_index(&with_url(&long)).unwrap();
}

#[test]
fn enforces_index_count_and_text_byte_boundaries() {
    let mut configs = (0..REPOSITORY_CONFIG_LIMIT)
        .map(|i| entry(&format!("config_{i:04}")))
        .collect::<Vec<_>>();
    assert_eq!(
        read_repository_index(&index(configs.clone()))
            .unwrap()
            .configs
            .len(),
        REPOSITORY_CONFIG_LIMIT
    );
    configs.push(entry("config_9999"));
    rejected(
        read_repository_index(&index(configs)),
        "index.configs",
        "1024 entries",
    );

    let mut source = index(vec![entry("example")]);
    source.push_str(&" ".repeat(REPOSITORY_INDEX_TEXT_LIMIT - source.len()));
    read_repository_index(&source).unwrap();
    source.push('界');
    rejected(read_repository_index(&source), "index", "1 MiB");
}

#[test]
fn enforces_manifest_limits_and_preserves_metadata() {
    let mut source = manifest();
    source["id"] = json!("a".repeat(64));
    source["name"] = json!(format!("{}a", "名".repeat(85)));
    source["description"] = json!(format!("{}aa", "说".repeat(2730)));
    source["terminations"][0] = json!({"file": format!("{}.yaml", "a".repeat(250)), "name": format!("{}aa", "名".repeat(42))});
    assert_eq!(
        read_repository_manifest(&source.to_string())
            .unwrap()
            .terminations[0]
            .file
            .len(),
        255
    );
    for (pointer, invalid_value, path, message) in [
        (
            "/id",
            json!("a".repeat(65)),
            "manifest.id",
            "64 UTF-8 bytes",
        ),
        ("/id", json!("Uppercase"), "manifest.id", "safe lowercase"),
        ("/id", json!("com1"), "manifest.id", "safe lowercase"),
        (
            "/name",
            json!("名".repeat(86)),
            "manifest.name",
            "256 UTF-8 bytes",
        ),
        (
            "/description",
            json!("说".repeat(2731)),
            "manifest.description",
            "8192 UTF-8 bytes",
        ),
        (
            "/terminations/0/file",
            json!(format!("{}.yaml", "a".repeat(251))),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/file",
            json!("Done.yaml"),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/file",
            json!("done.yml"),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/file",
            json!("done.extra.yaml"),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/file",
            json!("con.yaml"),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/file",
            json!("lpt9.yaml"),
            "manifest.terminations[0].file",
            "safe lowercase",
        ),
        (
            "/terminations/0/name",
            json!("名".repeat(43)),
            "manifest.terminations[0].name",
            "128 UTF-8 bytes",
        ),
        (
            "/terminations",
            json!([term(0), term(0)]),
            "manifest.terminations[1].file",
            "must be unique",
        ),
    ] {
        let mut invalid_source = source.clone();
        *invalid_source.pointer_mut(pointer).unwrap() = invalid_value;
        rejected(
            read_repository_manifest(&invalid_source.to_string()),
            path,
            message,
        );
    }
    source["terminations"] = json!((0..REPOSITORY_TERMINATION_LIMIT)
        .map(term)
        .collect::<Vec<_>>());
    assert_eq!(
        read_repository_manifest(&source.to_string())
            .unwrap()
            .terminations
            .len(),
        62
    );
    source["terminations"]
        .as_array_mut()
        .unwrap()
        .push(term(62));
    rejected(
        read_repository_manifest(&source.to_string()),
        "manifest.terminations",
        "62 entries",
    );

    let yaml = "id: example\nname: Example\ndescription: ''\nterminations: [{file: done.yaml, name: Done}]\nmetadata: {42: 1.0e+400}";
    assert_eq!(
        read_repository_manifest(yaml).unwrap().metadata,
        Some(YamlValue::Mapping(vec![(
            YamlValue::Integer("42".into()),
            YamlValue::Float("1.0e+400".into())
        )]))
    );
    assert!(matches!(
        read_repository_manifest(&manifest().to_string().replace("Example", "   ")),
        Err(RepositoryError::Compile(_)),
    ));
}

fn file(path: &str, bytes: impl Into<Vec<u8>>) -> ConfigPackageBytes {
    ConfigPackageBytes {
        path: path.into(),
        bytes: bytes.into(),
    }
}

fn package() -> Vec<ConfigPackageBytes> {
    vec![
        file("manifest.yaml", manifest().to_string()),
        file("config.yaml", [255]),
        file("termination_0.yaml", b"invalid: [not parsed"),
    ]
}

#[test]
fn validates_package_identity_utf8_and_exact_flat_file_set() {
    let files = package();
    assert_eq!(
        validate_config_package("example", &files).unwrap().id,
        "example"
    );
    let mut reordered = files.clone();
    reordered.reverse();
    validate_config_package("example", &reordered).unwrap();
    rejected(
        validate_config_package("other", &files),
        "directory_id",
        "must match manifest.id",
    );
    rejected(
        validate_config_package("example", &files[1..]),
        "files",
        "missing required file: manifest.yaml",
    );
    rejected(
        validate_config_package("example", &files[..2]),
        "files",
        "missing required file: termination_0.yaml",
    );
    rejected(
        validate_config_package("example", &[files[0].clone(), files[2].clone()]),
        "files",
        "missing required file: config.yaml",
    );
    for (path, message) in [
        ("extra.yaml", "unexpected file: extra.yaml"),
        ("nested/termination_0.yaml", "single file name"),
        ("nested\\termination_0.yaml", "single file name"),
        ("", "single file name"),
        ("termination_0.yaml", "must not be duplicated"),
        ("TERMINATION_0.YAML", "case folding"),
    ] {
        let mut invalid_files = files.clone();
        invalid_files.push(file(path, []));
        rejected(
            validate_config_package("example", &invalid_files),
            if path == "extra.yaml" {
                "files"
            } else {
                "files[3].path"
            },
            message,
        );
    }
    let mut invalid = files;
    invalid[0].bytes = vec![255];
    rejected(
        validate_config_package("example", &invalid),
        "manifest.yaml",
        "valid UTF-8",
    );
}

#[test]
fn accepts_sixty_four_one_mib_files_and_rejects_either_limit_exceeded() {
    let mut manifest = manifest();
    manifest["terminations"] = json!((0..REPOSITORY_TERMINATION_LIMIT)
        .map(term)
        .collect::<Vec<_>>());
    let max_size = CONFIG_PACKAGE_FILE_SIZE_LIMIT as usize;
    let mut bytes = manifest.to_string().into_bytes();
    bytes.extend(b"\n#");
    bytes.resize(max_size, b'x');
    let mut files = vec![
        file("manifest.yaml", bytes),
        file("config.yaml", vec![0; max_size]),
    ];
    files.extend(
        (0..REPOSITORY_TERMINATION_LIMIT)
            .map(|i| file(&format!("termination_{i}.yaml"), vec![0; max_size])),
    );
    assert_eq!(files.len(), 64);
    validate_config_package("example", &files).unwrap();
    files.push(file("extra.yaml", []));
    rejected(
        validate_config_package("example", &files),
        "files",
        "64 entries",
    );
    files.pop();
    files[0].bytes.push(b'x');
    rejected(
        validate_config_package("example", &files),
        "files[0].size",
        "1 MiB",
    );
    files[0].bytes.pop();
    files[1].bytes.push(0);
    rejected(
        validate_config_package("example", &files),
        "files[1].size",
        "1 MiB",
    );
}
