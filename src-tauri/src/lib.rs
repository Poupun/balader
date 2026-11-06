//! The desktop shell. All real work lives in `balader-core`; this file only
//! wires the core's single `dispatch` contract and its event stream to the
//! webview, plus the few things only a native app can do (folder picker,
//! clipboard, Finder/Explorer, window buttons).

#[cfg(debug_assertions)]
mod bridge;

use std::sync::Arc;

use balader_core::{Core, CorePaths, ErrorCode, ErrorPayload};
use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const EVENT_CHANNEL: &str = "balader://event";

struct AppCore(Arc<Core>);

fn native_error(e: impl std::fmt::Display) -> ErrorPayload {
    ErrorPayload { code: ErrorCode::Io, message: e.to_string(), hint: None, detail: None }
}

/// The one command the UI uses for everything engine-related.
#[tauri::command]
async fn core(state: State<'_, AppCore>, cmd: String, args: Value) -> Result<Value, ErrorPayload> {
    state.0.dispatch(&cmd, args).await
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, start: Option<String>) -> Result<Option<String>, ErrorPayload> {
    let mut dialog = app.dialog().file().set_title("Where should Balader save your grabs?");
    if let Some(dir) = start.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    // Blocking is fine here: async commands run off the main thread.
    let picked = dialog.blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn read_clipboard(app: tauri::AppHandle) -> Option<String> {
    app.clipboard().read_text().ok()
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), ErrorPayload> {
    app.opener().open_path(path, None::<&str>).map_err(native_error)
}

#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), ErrorPayload> {
    app.opener().reveal_item_in_dir(path).map_err(native_error)
}

/// Custom title bar buttons (Windows draws its own pixel-art ones).
#[tauri::command]
fn window_action(window: tauri::Window, action: String) -> Result<(), ErrorPayload> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => Ok(()),
    }
    .map_err(native_error)
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).format_target(false).init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Core::start spawns tasks, so it needs the runtime context.
            let core = tauri::async_runtime::block_on(async { Core::start(CorePaths::standard(), "tauri") });
            let mut rx = core.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            #[cfg(debug_assertions)]
                            bridge::record_event(&ev);
                            let _ = handle.emit(EVENT_CHANNEL, &ev);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });
            app.manage(AppCore(core));
            #[cfg(debug_assertions)]
            bridge::start(app.handle().clone());
            Ok(())
        });

    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        core,
        pick_folder,
        read_clipboard,
        open_path,
        reveal_path,
        window_action,
        bridge::bridge_result
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![core, pick_folder, read_clipboard, open_path, reveal_path, window_action]);

    builder.build(tauri::generate_context!()).expect("error while building Balader").run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            // Never leave yt-dlp/ffmpeg running behind us.
            if let Some(core) = app.try_state::<AppCore>() {
                tauri::async_runtime::block_on(core.0.shutdown());
            }
        }
    });
}
