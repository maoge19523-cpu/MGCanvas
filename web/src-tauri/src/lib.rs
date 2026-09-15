mod ffmpeg_compose;
mod media_cache;

use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use media_cache::MediaCacheState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_fs::FsExt;

const SPLASH_ANIMATION_FAILSAFE_DURATION: Duration = Duration::from_secs(4);
const SPLASH_FALLBACK_DURATION: Duration = Duration::from_secs(10);

struct StartupState {
    frontend_ready: AtomicBool,
    splash_animation_complete: AtomicBool,
    reveal_scheduled: AtomicBool,
}

impl StartupState {
    fn new() -> Self {
        Self {
            frontend_ready: AtomicBool::new(false),
            splash_animation_complete: AtomicBool::new(false),
            reveal_scheduled: AtomicBool::new(false),
        }
    }
}

fn try_reveal_main_window(app: AppHandle, force: bool) {
    let state = app.state::<StartupState>();
    let ready_to_reveal = force
        || (state.frontend_ready.load(Ordering::Acquire)
            && state.splash_animation_complete.load(Ordering::Acquire));
    if !ready_to_reveal {
        return;
    }
    if state.reveal_scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Some(main) = app.get_webview_window("main") {
            if main.is_minimized().unwrap_or(false) {
                let _ = main.unminimize();
            }
            let _ = main.show();
            let _ = main.set_focus();
        }
        if let Some(splashscreen) = app.get_webview_window("splashscreen") {
            let _ = splashscreen.close();
        }
    });
}

#[tauri::command]
fn frontend_ready(app: AppHandle) {
    app.state::<StartupState>()
        .frontend_ready
        .store(true, Ordering::Release);
    try_reveal_main_window(app, false);
}

#[tauri::command]
fn splash_animation_complete(app: AppHandle) {
    app.state::<StartupState>()
        .splash_animation_complete
        .store(true, Ordering::Release);
    try_reveal_main_window(app, false);
}

#[tauri::command]
fn open_downloads_directory(app: AppHandle, directory: Option<String>) -> Result<(), String> {
    let downloads = resolve_download_directory(&app, directory)?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command
        .arg(downloads)
        .spawn()
        .map_err(|error| format!("无法打开下载目录：{error}"))?;
    Ok(())
}

/// 用系统默认浏览器打开外部链接（仅允许 http/https）。
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let target = url.trim();
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("只允许打开 http 或 https 链接".to_owned());
    }

    #[cfg(target_os = "windows")]
    let mut command = Command::new("cmd");
    #[cfg(target_os = "windows")]
    command.args(["/C", "start", "", target]);
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "macos")]
    command.arg(target);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    command.arg(target);

    command
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;
    Ok(())
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CanvasMediaExport {
    exported: usize,
    failed: Vec<String>,
    directory: String,
}

/// 批量导出画布生成结果到指定目录：同名文件自动追加序号避免覆盖。
#[tauri::command]
fn export_canvas_media(paths: Vec<String>, directory: String) -> Result<CanvasMediaExport, String> {
    let trimmed = directory.trim();
    if trimmed.is_empty() {
        return Err("请先选择导出目录".to_owned());
    }
    let target = std::path::PathBuf::from(trimmed);
    if !target.is_dir() {
        return Err("导出目录不存在".to_owned());
    }

    let mut exported = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for raw in paths {
        let source = std::path::PathBuf::from(raw.trim());
        if !source.is_file() {
            failed.push(raw);
            continue;
        }
        let name = source
            .file_name()
            .map(|value| value.to_owned())
            .unwrap_or_else(|| std::ffi::OsString::from("mgcanvas-output"));
        let destination = unique_export_path(&target, &name);
        match std::fs::copy(&source, &destination) {
            Ok(_) => exported += 1,
            Err(_) => failed.push(raw),
        }
    }

    Ok(CanvasMediaExport {
        exported,
        failed,
        directory: target.to_string_lossy().to_string(),
    })
}

/// 生成不冲突的目标路径：已存在时在文件名后追加 -1、-2 …
fn unique_export_path(directory: &std::path::Path, name: &std::ffi::OsStr) -> std::path::PathBuf {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "mgcanvas-output".to_owned());
    let extension = std::path::Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_string());
    for index in 1..10_000 {
        let file_name = match extension.as_deref() {
            Some(ext) if !ext.is_empty() => format!("{stem}-{index}.{ext}"),
            _ => format!("{stem}-{index}"),
        };
        let next = directory.join(file_name);
        if !next.exists() {
            return next;
        }
    }
    candidate
}

#[tauri::command]
fn allow_download_directory(app: AppHandle, directory: String) -> Result<String, String> {
    let path = resolve_download_directory(&app, Some(directory))?;
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|error| format!("无法授权素材存放目录：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn resolve_download_directory(
    app: &AppHandle,
    directory: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let path = match directory
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        Some(value) => std::path::PathBuf::from(value),
        None => app
            .path()
            .download_dir()
            .map_err(|error| format!("无法定位下载目录：{error}"))?,
    };
    if !path.is_dir() {
        return Err("选择的素材存放目录不存在或不可访问".to_owned());
    }
    path.canonicalize()
        .map_err(|error| format!("无法读取素材存放目录：{error}"))
}

/// 显示并聚焦主窗口（从系统托盘唤起时使用）。
fn reveal_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 系统托盘：常驻通知区域，左键切换主窗口显隐，右键提供显示主窗口与退出。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出猫歌映画", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("猫歌映画")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let visible = app.get_webview_window("main").and_then(|window| window.is_visible().ok()).unwrap_or(false);
                if visible {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    reveal_main_window(app);
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(StartupState::new())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init());

    // The updater plugin validates `plugins.updater` while the application is
    // starting. Only signed release builds supply that configuration.
    #[cfg(feature = "desktop-updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .plugin(mgcanvas_comfyui_local::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(main) = app.get_webview_window("main") {
                main.set_decorations(false)?;
            }

            if let Some(splashscreen) = app.get_webview_window("splashscreen") {
                splashscreen.set_ignore_cursor_events(true)?;
            }

            let cache_dir = app.path().app_local_data_dir()?.join("media-cache");
            app.manage(MediaCacheState::new(cache_dir)?);

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let animation_failsafe_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SPLASH_ANIMATION_FAILSAFE_DURATION).await;
                animation_failsafe_app
                    .state::<StartupState>()
                    .splash_animation_complete
                    .store(true, Ordering::Release);
                try_reveal_main_window(animation_failsafe_app, false);
            });

            let fallback_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SPLASH_FALLBACK_DURATION).await;
                try_reveal_main_window(fallback_app, true);
            });

            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭主窗口时隐藏到系统托盘，保证正在进行的生成与合成任务不被中断。
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            splash_animation_complete,
            open_downloads_directory,
            open_external_url,
            allow_download_directory,
            export_canvas_media,
            ffmpeg_compose::detect_ffmpeg,
            ffmpeg_compose::compose_video,
            media_cache::cache_remote_media,
            media_cache::import_legacy_cached_media
        ])
        .run(tauri::generate_context!())
        .expect("MGCanvas desktop client failed to start");
}
