from __future__ import annotations

from pathlib import Path

import yaml

from gachasimulate.builder import build_from_files, load_yaml_file

ROOT = Path(__file__).resolve().parents[1]
CONFIG_ROOT = ROOT / "configs"


def test_all_config_files_build_from_yaml() -> None:
    config_paths = sorted(CONFIG_ROOT.glob("**/config.yaml"))
    assert config_paths

    for config_path in config_paths:
        manifest_path = config_path.parent / "manifest.yaml"
        assert manifest_path.exists(), config_path
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        assert manifest["id"] == config_path.parent.name
        assert manifest["terminations"]
        termination_paths = sorted(config_path.parent.glob("termination*.yaml"))
        assert termination_paths, config_path
        for termination_path in termination_paths:
            assert load_yaml_file(config_path)["schema_version"] == 1
            build_from_files(config_path, termination_path)


def test_configs_do_not_contain_legacy_json_rules() -> None:
    assert not list(CONFIG_ROOT.glob("**/*.json"))
