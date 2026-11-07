#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "node-compat")]
mod backend;
mod diagnostics;
mod native;
mod overlay;
mod runtime;
mod voice;
mod voice_lab;
use base64::Engine;
use runtime::RuntimeBackend as Backend;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct OverlayEnabled(Arc<AtomicBool>);
struct DiagnosticsRunning(Arc<AtomicBool>);

fn notify_backend_window(app: &AppHandle, label: &str, open: bool) {
    let backend = app.state::<Arc<Backend>>().inner().clone();
    let target = label.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = backend
            .request(&target, "__window_state", vec![json!(open)], "invoke")
            .await;
    });
}

fn open_window(app: &AppHandle, label: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(label) {
        window.unminimize()?;
        if label != "overlay" {
            window.show()?;
            window.set_focus()?;
        }
        notify_backend_window(app, label, true);
        return Ok(());
    }
    let (view, title, width, height) = match label {
        "main" => ("app", "タヌキのベタクル Tauri β", 280.0, 390.0),
        "settings" => ("settings", "Tauri β 設定", 750.0, 630.0),
        "lobbies" => ("lobbies", "Tauri β ロビー", 900.0, 500.0),
        "debug" => ("debug", "Tauri β デバッグ", 900.0, 650.0),
        "player-history" => ("player-history", "Tauri β プレイヤー履歴", 1100.0, 740.0),
        "overlay" => ("overlay", "Tauri β Overlay", 400.0, 300.0),
        _ => return Ok(()),
    };
    let compact = std::env::args().any(|arg| arg == "--compact");
    let path = format!(
        "index.html?view={view}&version={}",
        app.package_info().version
    );
    let (width, height) = if label == "main" && compact {
        (410.0, 650.0)
    } else {
        (width, height)
    };
    let mut browser_arguments="--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required".to_owned();
    let window_settings = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|path| std::fs::read(path.join("config.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    let hardware_acceleration = window_settings["hardware_acceleration"]
        .as_bool()
        .unwrap_or(true);
    if !hardware_acceleration {
        browser_arguments.push_str(" --disable-gpu");
    }
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        .title(if label == "main" {
            format!("ベタクル Tauri {}", app.package_info().version)
        } else {
            title.to_owned()
        })
        .always_on_top(label == "main" && window_settings["alwaysOnTop"] == true)
        .inner_size(width, height)
        .min_inner_size(if label=="settings"{620.0}else{280.0},if label=="settings"{440.0}else{390.0})
        .decorations(label == "player-history" || compact)
        .use_https_scheme(true)
        // Voice-role heartbeats must continue while Among Us has focus.
        .additional_browser_args(&browser_arguments)
        .on_navigation(|url| {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.host_str() == Some("localhost")
                    && url.port() == Some(1420))
        });
    let builder = if label == "overlay" {
        builder
            .transparent(true)
            .shadow(false)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .always_on_top(true)
    } else {
        builder
    };
    let window = builder.build()?;
    if label == "overlay" {
        window.set_ignore_cursor_events(true)?;
    }
    let handle = app.clone();
    let owned_label = label.to_owned();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            notify_backend_window(&handle, &owned_label, false);
        }
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            if owned_label == "main" && !voice::enabled() {
                handle.exit(0);
            }
        }
        if voice::enabled()
            && owned_label == "main"
            && matches!(event, tauri::WindowEvent::Resized(_))
        {
            if let Some(window) = handle.get_webview_window("main") {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.destroy();
                }
            }
        }
    });
    notify_backend_window(app, label, true);
    Ok(())
}

fn allowed_external(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|url| {
        matches!(
            url.scheme(),
            "https" | "http" | "steam" | "com.epicgames.launcher"
        )
    })
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    if !allowed_external(&url) {
        return Err("Unsupported URL scheme".into());
    }
    open::that_detached(url).map_err(|error| error.to_string())
}

#[tauri::command]
async fn pick_path(
    app: AppHandle,
    window: tauri::WebviewWindow,
    kind: String,
) -> Result<Value, String> {
    if !["main", "settings", "debug", "player-history"].contains(&window.label()) {
        return Err("File picker is unavailable in this window".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app.dialog().file().set_parent(&window);
        let path = |file: tauri_plugin_dialog::FilePath| {
            file.into_path()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        };
        match kind.as_str() {
            "attachments" => picker
                .blocking_pick_files()
                .map(|files| {
                    files
                        .into_iter()
                        .map(path)
                        .collect::<Result<Vec<_>, _>>()
                        .map(|paths| json!(paths))
                })
                .unwrap_or(Ok(Value::Null)),
            "executable" => picker
                .add_filter("Executable", &["exe"])
                .blocking_pick_file()
                .map(|file| path(file).map(|p| json!(p)))
                .unwrap_or(Ok(Value::Null)),
            "log" => picker
                .set_file_name("TanukiBCL-Tauri-debug.log")
                .add_filter("Log", &["log"])
                .blocking_save_file()
                .map(|file| path(file).map(|p| json!(p)))
                .unwrap_or(Ok(Value::Null)),
            _ => Err("Unknown file picker".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn frontend_log(app: AppHandle, window: tauri::WebviewWindow, message: String) {
    use std::{fs::OpenOptions, io::Write};
    if let Ok(directory) = app.path().app_config_dir() {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("logs/frontend.log"))
        {
            let _ = writeln!(
                file,
                "[{}] {}",
                window.label(),
                message.chars().take(8192).collect::<String>()
            );
        }
    }
}

fn control(app: &AppHandle, frame: &Value) {
    let action = frame["action"].as_str().unwrap_or("");
    let target = frame["target"].as_str().unwrap_or("main");
    let value = &frame["value"];
    let result: Result<(), Box<dyn std::error::Error>> = (|| {
        match action {
            "open" => open_window(app, target)?,
            "quit" if voice::enabled() => {
                if let Some(window) = app.get_webview_window("main") {
                    window.destroy()?;
                }
            }
            "quit" => app.exit(0),
            "relaunch" => app.restart(),
            "openExternal" => {
                if let Some(url) = value.as_str().filter(|url| allowed_external(url)) {
                    open::that_detached(url)?;
                }
            }
            "error" => {
                app.dialog()
                    .message(value["message"].as_str().unwrap_or("Error"))
                    .title(value["title"].as_str().unwrap_or("Tauri beta"))
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .show(|_| {});
            }
            "overlay" => {
                let enabled = value.as_bool().unwrap_or(false);
                if enabled {
                    open_window(app, "overlay")?;
                }
                app.state::<OverlayEnabled>()
                    .0
                    .store(enabled, Ordering::Relaxed);
                if !enabled {
                    if let Some(window) = app.get_webview_window("overlay") {
                        window.hide()?;
                    }
                }
            }
            _ => {
                if let Some(window) = app.get_webview_window(target) {
                    match action {
                        "reload" => window.eval("location.reload()")?,
                        "minimize" => window.minimize()?,
                        "alwaysOnTop" => {
                            window.set_always_on_top(value.as_bool().unwrap_or(false))?
                        }
                        "close" => {
                            if target == "main" {
                                app.exit(0);
                            } else {
                                window.close()?;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Tauri control {action}: {error}");
    }
}

#[tauri::command]
async fn ipc(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, Arc<Backend>>,
    channel: String,
    args: Vec<Value>,
    mode: String,
) -> Result<Value, String> {
    if channel.starts_with("__") || !matches!(mode.as_str(), "send" | "invoke") {
        return Err("Invalid IPC request".into());
    }
    backend.request(window.label(), &channel, args, &mode).await
}

fn main() {
    if voice::run_probe() || native::run_probe() {
        return;
    }
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ipc,
            open_external,
            pick_path,
            frontend_log,
            voice::native_voice,
            voice_lab::voice_lab
        ]);
    for scheme in ["static", "generate", "nos-cosmetic", "snr-cosmetic"] {
        builder = builder.register_asynchronous_uri_scheme_protocol(
            scheme,
            move |ctx, request, responder| {
                let backend = ctx.app_handle().state::<Arc<Backend>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let args = vec![
                        json!(scheme),
                        json!(request.uri().path()),
                        json!(request.uri().query().unwrap_or("")),
                    ];
                    let result = backend.request("main", "__asset", args, "invoke").await;
                    let bytes = result.ok().and_then(|value| {
                        value.as_str().and_then(|text| {
                            base64::engine::general_purpose::STANDARD.decode(text).ok()
                        })
                    });
                    let (status, body) =
                        bytes.map(|bytes| (200, bytes)).unwrap_or((404, Vec::new()));
                    let response = tauri::http::Response::builder()
                        .status(status)
                        .header("Content-Type", "image/png")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "no-cache")
                        .body(body)
                        .unwrap();
                    responder.respond(response);
                });
            },
        );
    }
    let app = builder
        .setup(|app| {
            let enabled = Arc::new(AtomicBool::new(false));
            app.manage(OverlayEnabled(enabled.clone()));
            let backend = Backend::start(app.handle())?;
            app.manage(backend.clone());
            if let Some(lab) = voice_lab::Lab::load()? {
                app.manage(lab.clone());
                lab.start(app.handle());
            }
            if voice::enabled() {
                if backend.name() != "rust" {
                    return Err("--native-voice requires --backend=rust".into());
                }
                let settings = tauri::async_runtime::block_on(backend.request(
                    "main",
                    "settings:get",
                    vec![],
                    "invoke",
                ))?;
                app.manage(voice::Service::start(app.handle(), settings)?);
                setup_voice_tray(app.handle())?;
                voice::open_browser_fixture(app.handle())?;
                tauri::async_runtime::spawn(async move {
                    let _ = backend.request("main", "START_HOOK", vec![], "send").await;
                });
            }
            let running = Arc::new(AtomicBool::new(true));
            diagnostics::start(app.path().app_config_dir()?.join("logs"), running.clone());
            app.manage(DiagnosticsRunning(running));
            overlay::start(app.handle().clone(), enabled);
            if !voice::headless() {
                open_window(app.handle(), "main")?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to start TanukiBCL Tauri beta");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            if voice::enabled() {
                api.prevent_exit();
            }
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(voice) = app.try_state::<Arc<voice::Service>>() {
                voice.stop();
            }
            app.state::<DiagnosticsRunning>()
                .0
                .store(false, Ordering::Relaxed);
            app.state::<OverlayEnabled>()
                .0
                .store(false, Ordering::Relaxed);
            app.state::<Arc<Backend>>().stop();
        }
    });
}

fn setup_voice_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let restore = MenuItem::with_id(app, "voice-open", "画面を開く", true, None::<&str>)?;
    let mute = MenuItem::with_id(
        app,
        "voice-mute",
        "マイクのミュートを切り替え",
        true,
        None::<&str>,
    )?;
    let deafen = MenuItem::with_id(
        app,
        "voice-deafen",
        "スピーカーのミュートを切り替え",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "voice-quit",
        "通話を終了して閉じる",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&restore, &mute, &deafen, &quit])?;
    let mut tray = TrayIconBuilder::with_id("native-voice")
        .tooltip("ベタクル Rust音声試作 — 通話はトレイから終了できます")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "voice-open" => {
                let _ = open_window(app, "main");
            }
            "voice-mute" => {
                app.state::<Arc<voice::Service>>()
                    .backend_event("TOGGLE_MUTE", &[]);
            }
            "voice-deafen" => {
                app.state::<Arc<voice::Service>>()
                    .backend_event("TOGGLE_DEAFEN", &[]);
            }
            "voice-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = open_window(tray.app_handle(), "main");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_links_only_use_supported_protocols() {
        for url in [
            "https://github.com/kuretoshi/BetterCrewLink",
            "steam://rungameid/945360",
        ] {
            assert!(super::allowed_external(url));
        }
        for url in [
            "file:///C:/Windows/system32/cmd.exe",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(!super::allowed_external(url));
        }
    }
}
