from __future__ import annotations

from pathlib import Path

from gachasimulate.builder import build_from_files

ROOT = Path(__file__).resolve().parents[1]
CONFIG_ROOT = ROOT / "configs"


def test_all_config_files_build_from_yaml() -> None:
    config_paths = sorted(CONFIG_ROOT.glob("*/config.yaml"))
    assert config_paths

    for config_path in config_paths:
        termination_paths = sorted(config_path.parent.glob("termination*.yaml"))
        assert termination_paths, config_path
        for termination_path in termination_paths:
            build_from_files(config_path, termination_path)


def test_configs_do_not_contain_legacy_json_rules() -> None:
    assert not list(CONFIG_ROOT.glob("**/*.json"))
