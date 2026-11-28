use super::*;
use crate::temp_dir::TempDir;

#[test]
fn rejects_a_package_that_changes_after_one_file_has_been_collected() {
    let tmp = TempDir::new();
    let package = tmp.configs();
    fs::create_dir(&package).unwrap();
    let first = package.join("first.yaml");
    fs::write(&first, b"first revision").unwrap();
    fs::write(package.join("second.yaml"), b"second file").unwrap();
    let error = read_directory_with(&package, |path, limit| {
        let bytes = read_file(path, limit)?;
        if path.ends_with("second.yaml") {
            fs::write(&first, b"a different revision")?;
        }
        Ok(bytes)
    })
    .unwrap_err();
    assert!(error.message.contains("configuration changed"));
}
