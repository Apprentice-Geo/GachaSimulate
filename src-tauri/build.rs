const APP_COMMANDS: &[&str] = &[
    "open_app_link",
    "list_configs",
    "get_config_repository_state",
    "refresh_config_repository",
    "install_config",
    "update_config",
    "uninstall_config",
    "select_local_config_directory",
    "get_logical_cpu_count",
    "get_simulation_state",
    "start_simulation",
    "cancel_simulation",
    "open_results_directory",
    "select_gsr_result",
    "open_simulation_result",
    "confirm_result_session",
    "save_result_fields",
    "discard_result_draft",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
