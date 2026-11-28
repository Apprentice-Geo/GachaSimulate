use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
};

use gachasimulate_config_store::{ConfigStore, ConfigStoreOptions};
use gachasimulate_desktop_contract::{
    AppLink, CancelSimulationRequest, ConfigRepositoryState, ConfirmResultSessionRequest,
    ConfirmResultSessionResponse, DesktopError, DesktopErrorCode, DiscardResultDraftRequest,
    InstalledConfig, ResultCandidateSession, SaveResultFieldsRequest, SavedResultFields,
    SimulationCommandRequest, SimulationStatus, SimulationTaskSnapshot, SIMULATION_EVENT_NAME,
};
use gachasimulate_host::{DesktopHost, HostConfig, HostOpenTarget, SimulationHost};
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub config_store: Arc<ConfigStore>,
    pub host: Arc<DesktopHost>,
    shutdown_in_progress: AtomicBool,
    allow_close: AtomicBool,
}

impl AppState {
    fn new(
        app_handle: tauri::AppHandle,
        data_root: PathBuf,
        worker_binary_path: PathBuf,
    ) -> Result<Self, DesktopError> {
        let configs_dir = data_root.join("configs");
        let results_dir = data_root.join("results");

        let simulation_slot: Arc<OnceLock<SimulationHost>> = Arc::new(OnceLock::new());
        let sim_active_slot = simulation_slot.clone();
        let mut store_options = ConfigStoreOptions {
            simulation_active: Some(Arc::new(move || {
                sim_active_slot.get().is_some_and(|sim| {
                    matches!(
                        sim.get_simulation_state().ok().map(|s| s.status),
                        Some(
                            SimulationStatus::Starting
                                | SimulationStatus::Running
                                | SimulationStatus::Saving
                                | SimulationStatus::Cancelling
                        )
                    )
                })
            })),
            ..ConfigStoreOptions::default()
        };
        if let Ok(index_url) = std::env::var("GACHASIMULATE_CONFIG_INDEX_URL") {
            if !index_url.trim().is_empty() {
                store_options.index_url = index_url;
            }
        }
        let config_store = Arc::new(ConfigStore::with_options(configs_dir, store_options)?);

        let emit_handle = app_handle.clone();
        let mut host_config = HostConfig::new(
            results_dir,
            worker_binary_path,
            Arc::new(move |event| {
                let _ = emit_handle.emit(SIMULATION_EVENT_NAME, event);
            }),
        );
        let open_handle = app_handle.clone();
        host_config.opener = Some(Arc::new(move |target| match target {
            HostOpenTarget::Url(url) => open_handle
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|error| DesktopError::new(DesktopErrorCode::Io, error.to_string())),
            HostOpenTarget::Directory(path) => open_handle
                .opener()
                .open_path(path.to_string_lossy().as_ref(), None::<&str>)
                .map_err(|error| DesktopError::new(DesktopErrorCode::Io, error.to_string())),
        }));

        let host = Arc::new(DesktopHost::new(host_config, config_store.clone())?);
        let _ = simulation_slot.set(host.simulation.clone());

        Ok(Self {
            config_store,
            host,
            shutdown_in_progress: AtomicBool::new(false),
            allow_close: AtomicBool::new(false),
        })
    }
}

fn resolve_data_root(app: &tauri::App) -> Result<PathBuf, DesktopError> {
    if let Ok(override_dir) = std::env::var("GACHASIMULATE_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return Ok(PathBuf::from(override_dir));
        }
    }
    app.path()
        .app_local_data_dir()
        .map_err(|error| DesktopError::new(DesktopErrorCode::Io, error.to_string()))
}

fn resolve_worker_binary(app: &tauri::App) -> PathBuf {
    let exe_name = if cfg!(windows) {
        "gachasimulate-worker.exe"
    } else {
        "gachasimulate-worker"
    };
    let triple_name = if cfg!(windows) {
        "gachasimulate-worker-x86_64-pc-windows-msvc.exe"
    } else {
        "gachasimulate-worker"
    };
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            for candidate in [dir.join(exe_name), dir.join(triple_name)] {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join(exe_name),
            resource_dir.join("bin").join(exe_name),
            resource_dir.join("bin").join(triple_name),
        ] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    Path::new(exe_name).to_path_buf()
}

async fn run_blocking<T, F>(task: F) -> Result<T, DesktopError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DesktopError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| DesktopError::new(DesktopErrorCode::Internal, error.to_string()))?
}

#[tauri::command]
async fn open_app_link(state: State<'_, AppState>, link: AppLink) -> Result<(), DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.open_app_link(link)).await
}

#[tauri::command]
async fn list_configs(state: State<'_, AppState>) -> Result<Vec<InstalledConfig>, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.list_configs()).await
}

#[tauri::command]
async fn get_config_repository_state(
    state: State<'_, AppState>,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.get_config_repository_state()).await
}

#[tauri::command]
async fn refresh_config_repository(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.refresh_config_repository(force)).await
}

#[tauri::command]
async fn install_config(
    state: State<'_, AppState>,
    id: String,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.install_config(&id)).await
}

#[tauri::command]
async fn update_config(
    state: State<'_, AppState>,
    id: String,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.update_config(&id)).await
}

#[tauri::command]
async fn uninstall_config(
    state: State<'_, AppState>,
    id: String,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || store.uninstall_config(&id)).await
}

#[tauri::command]
async fn select_local_config_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ConfigRepositoryState, DesktopError> {
    let store = state.config_store.clone();
    run_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("选择本地配置目录")
            .blocking_pick_folder();
        match picked {
            Some(FilePath::Path(path)) => store.set_local_config_directory(&path),
            Some(FilePath::Url(_)) => Err(DesktopError::new(
                DesktopErrorCode::InvalidRequest,
                "Selected local configuration path is not a filesystem directory",
            )),
            None => store.get_config_repository_state(),
        }
    })
    .await
}

#[tauri::command]
fn get_logical_cpu_count(state: State<'_, AppState>) -> Result<usize, DesktopError> {
    state.host.get_logical_cpu_count()
}

#[tauri::command]
fn get_simulation_state(
    state: State<'_, AppState>,
) -> Result<SimulationTaskSnapshot, DesktopError> {
    state.host.simulation.get_simulation_state()
}

#[tauri::command]
async fn start_simulation(
    state: State<'_, AppState>,
    request: SimulationCommandRequest,
) -> Result<SimulationTaskSnapshot, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.simulation.start_simulation(request)).await
}

#[tauri::command]
async fn cancel_simulation(
    state: State<'_, AppState>,
    request: CancelSimulationRequest,
) -> Result<SimulationTaskSnapshot, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.simulation.cancel_simulation(request)).await
}

#[tauri::command]
async fn open_results_directory(state: State<'_, AppState>) -> Result<(), DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.open_results_directory()).await
}

#[tauri::command]
async fn select_gsr_result(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ResultCandidateSession>, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("选择 GSR 结果文件")
            .add_filter("GachaSimulate 结果文件", &["gsr"])
            .blocking_pick_file();
        match picked {
            Some(FilePath::Path(path)) => host.results.select_gsr_result(Some(&path)),
            Some(FilePath::Url(_)) => Err(DesktopError::new(
                DesktopErrorCode::InvalidRequest,
                "Selected result file is not a local filesystem path",
            )),
            None => Ok(None),
        }
    })
    .await
}

#[tauri::command]
async fn open_simulation_result(
    state: State<'_, AppState>,
) -> Result<ResultCandidateSession, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.results.open_simulation_result()).await
}

#[tauri::command]
async fn confirm_result_session(
    state: State<'_, AppState>,
    request: ConfirmResultSessionRequest,
) -> Result<ConfirmResultSessionResponse, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.results.confirm_result_session(request)).await
}

#[tauri::command]
async fn save_result_fields(
    state: State<'_, AppState>,
    request: SaveResultFieldsRequest,
) -> Result<SavedResultFields, DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.results.save_result_fields(request)).await
}

#[tauri::command]
async fn discard_result_draft(
    state: State<'_, AppState>,
    request: DiscardResultDraftRequest,
) -> Result<(), DesktopError> {
    let host = state.host.clone();
    run_blocking(move || host.results.discard_result_draft(request)).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_root = resolve_data_root(app)?;
            let worker_binary = resolve_worker_binary(app);
            let state = AppState::new(app.handle().clone(), data_root, worker_binary)?;
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.allow_close.load(Ordering::Acquire) {
                    return;
                }
                api.prevent_close();
                if state
                    .shutdown_in_progress
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return;
                }
                let host = state.host.clone();
                let window_handle = window.clone();
                std::thread::spawn(move || {
                    let state = window_handle.state::<AppState>();
                    match host.shutdown() {
                        Ok(()) => {
                            state.allow_close.store(true, Ordering::Release);
                            if window_handle.destroy().is_err() {
                                window_handle.app_handle().exit(0);
                            }
                        }
                        Err(_) => {
                            state.shutdown_in_progress.store(false, Ordering::Release);
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_app_link,
            list_configs,
            get_config_repository_state,
            refresh_config_repository,
            install_config,
            update_config,
            uninstall_config,
            select_local_config_directory,
            get_logical_cpu_count,
            get_simulation_state,
            start_simulation,
            cancel_simulation,
            open_results_directory,
            select_gsr_result,
            open_simulation_result,
            confirm_result_session,
            save_result_fields,
            discard_result_draft,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GachaSimulate Tauri application");
}
