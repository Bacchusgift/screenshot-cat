#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod capture;
mod clipboard;
mod focus;
mod shell;
use shell::{open_panel, show_notice};
use std::sync::atomic::{AtomicBool, Ordering};
mod recording;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    kind: String,
    name: String,
    created_at: u64,
    width: u32,
    height: u32,
    duration: f64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    fps: u32,
    countdown: u32,
    encoder: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            fps: 30,
            countdown: 3,
            encoder: "auto".into(),
        }
    }
}
#[derive(Default)]
struct State {
    quitting: AtomicBool,
    panel_opening: AtomicBool,
    library: PathBuf,
    entries: Mutex<Vec<Entry>>,
    settings: Mutex<Settings>,
    selection: Mutex<Option<capture::Selection>>,
    recording: Mutex<Option<recording::Recording>>,
    busy: Mutex<bool>,
    shortcuts: Mutex<Vec<serde_json::Value>>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}
fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("此窗口无权执行此操作".into())
    }
}
fn entry_path(state: &State, id: &str) -> Result<(Entry, PathBuf), String> {
    let entries = state.entries.lock().map_err(err)?;
    let e = entries
        .iter()
        .find(|e| e.id == id)
        .ok_or("记录不存在")?
        .clone();
    let p = state.library.join(&e.name);
    Ok((e, p))
}
fn save_entry(app: &tauri::AppHandle, entry: Entry) -> Result<Entry, String> {
    let state = app.state::<State>();
    let mut entries = state.entries.lock().map_err(err)?;
    entries.insert(0, entry.clone());
    let json = serde_json::to_vec(&*entries).map_err(err)?;
    let tmp = state.library.join("index.tmp");
    fs::write(&tmp, json).map_err(err)?;
    fs::rename(tmp, state.library.join("index.json")).map_err(err)?;
    let _ = app.emit_to("main", "library-changed", ());
    Ok(entry)
}
fn new_entry(kind: &str, ext: &str, w: u32, h: u32) -> Entry {
    let id = uuid::Uuid::new_v4().to_string();
    Entry {
        name: format!("{id}.{ext}"),
        id,
        kind: kind.into(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        width: w,
        height: h,
        duration: 0.0,
    }
}
fn screen_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        core_graphics::access::ScreenCaptureAccess.preflight()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
#[tauri::command]
fn request_screen_permission(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    require_main(&window)?;
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        if core_graphics::access::ScreenCaptureAccess.request() {
            return Ok(true);
        }
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                None::<&str>,
            )
            .map_err(err)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(screen_permission())
}
#[tauri::command]
fn init(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<State>,
) -> Result<serde_json::Value, String> {
    require_main(&window)?;
    Ok(
        serde_json::json!({"entries":*state.entries.lock().map_err(err)?,"settings":*state.settings.lock().map_err(err)?,"library":state.library,"platform":std::env::consts::OS,"screenPermission":screen_permission(),"shortcuts":*state.shortcuts.lock().map_err(err)?,"ffmpeg":recording::ffmpeg_path(&app).is_ok(),"pins":app.webview_windows().keys().filter(|k| k.starts_with("pin-")).collect::<Vec<_>>() }),
    )
}
#[tauri::command]
fn save_image(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    data: String,
) -> Result<Entry, String> {
    require_main(&window)?;
    use base64::Engine;
    if data.len() > 100 * 1024 * 1024 {
        return Err("图片过大".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            data.strip_prefix("data:image/png;base64,")
                .ok_or("需要 PNG 图片")?,
        )
        .map_err(err)?;
    let image = image::load_from_memory(&bytes).map_err(err)?;
    let entry = new_entry("image", "png", image.width(), image.height());
    fs::write(app.state::<State>().library.join(&entry.name), &bytes).map_err(err)?;
    let entry = save_entry(&app, entry)?;
    clipboard::copy_png(&app, &bytes)?;
    Ok(entry)
}
#[tauri::command]
fn save_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    settings: Settings,
) -> Result<(), String> {
    require_main(&window)?;
    if ![15, 30, 60].contains(&settings.fps)
        || ![0, 3, 5].contains(&settings.countdown)
        || !["auto", "software"].contains(&settings.encoder.as_str())
    {
        return Err("无效设置".into());
    }
    fs::write(
        state.library.join("settings.json"),
        serde_json::to_vec(&settings).map_err(err)?,
    )
    .map_err(err)?;
    *state.settings.lock().map_err(err)? = settings;
    Ok(())
}
#[tauri::command]
fn import_image(window: tauri::WebviewWindow, path: PathBuf) -> Result<String, String> {
    require_main(&window)?;
    use base64::Engine;
    let image = image::open(path).map_err(err)?;
    if image.width() as u64 * image.height() as u64 > 40_000_000 {
        return Err("图片不能超过 4000 万像素".into());
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(err)?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    ))
}
#[tauri::command]
fn export_entry(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    id: String,
    destination: PathBuf,
) -> Result<(), String> {
    require_main(&window)?;
    let (_, source) = entry_path(&state, &id)?;
    fs::copy(source, destination).map_err(err)?;
    Ok(())
}
#[tauri::command]
async fn pin_entry(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
    id: String,
) -> Result<(), String> {
    require_main(&window)?;
    let (e, _) = entry_path(&state, &id)?;
    if e.kind != "image" {
        return Err("仅截图可以贴图".into());
    }
    pin_internal(&app, &e)
}
fn pin_internal(app: &tauri::AppHandle, e: &Entry) -> Result<(), String> {
    let label = format!("pin-{}", e.id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let scale = (650.0 / e.width as f64)
        .min(500.0 / e.height as f64)
        .min(1.0);
    tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?view=pin&id={}", e.id).into()),
    )
    .title("桌面贴图")
    .inner_size(
        (e.width as f64 * scale).max(200.0),
        (e.height as f64 * scale + 42.0).max(150.0),
    )
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .build()
    .map_err(err)?;
    let _ = app.emit_to("main", "library-changed", ());
    Ok(())
}
#[tauri::command]
fn pin_data(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    id: String,
) -> Result<serde_json::Value, String> {
    if window.label() != format!("pin-{id}") {
        return Err("无效贴图窗口".into());
    }
    let (e, p) = entry_path(&state, &id)?;
    let mut value = serde_json::to_value(e).map_err(err)?;
    value["path"] = serde_json::json!(p);
    Ok(value)
}
fn restore(app: &tauri::AppHandle) {
    for label in ["overlay", "controls"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
    if let Ok(mut s) = app.state::<State>().selection.lock() {
        *s = None;
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let library = app.path().app_data_dir()?.join("captures");
            fs::create_dir_all(&library)?;
            let entries = fs::read(library.join("index.json"))
                .ok()
                .and_then(|v| serde_json::from_slice(&v).ok())
                .unwrap_or_default();
            let settings = fs::read(library.join("settings.json"))
                .ok()
                .and_then(|v| serde_json::from_slice(&v).ok())
                .unwrap_or_default();
            app.manage(State {
                library,
                entries: Mutex::new(entries),
                settings: Mutex::new(settings),
                ..Default::default()
            });
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            app.manage(clipboard::History::load(
                app.path().app_data_dir()?.join("clipboard"),
            )?);
            clipboard::watch(app.handle().clone());
            for (key, mode, label) in [
                ("CmdOrCtrl+Shift+1", "image", "区域截图"),
                ("CmdOrCtrl+Shift+2", "video", "区域录屏"),
                ("CmdOrCtrl+Shift+3", "gif", "GIF 动图"),
                ("CmdOrCtrl+Shift+X", "stop", "停止录制"),
                ("CmdOrCtrl+Shift+D", "drawing", "切换绘制"),
                (
                    if cfg!(target_os = "macos") {
                        "Command+Control+V"
                    } else {
                        "Control+Alt+V"
                    },
                    "clipboard",
                    "剪贴板记录",
                ),
            ] {
                let mode = mode.to_string();
                let result = app
                    .global_shortcut()
                    .on_shortcut(key, move |app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            match mode.as_str() {
                                "clipboard" => clipboard::request_shelf(app, true),
                                "stop" => {
                                    let a = app.clone();
                                    std::thread::spawn(move || {
                                        if let Err(e) = recording::stop_internal(&a) {
                                            show_notice(&a, &e);
                                        }
                                    });
                                }
                                "drawing" => {
                                    if let Err(e) = recording::toggle_internal(app) {
                                        show_notice(app, &e);
                                    }
                                }
                                _ => shell::request_capture(app, &mode),
                            }
                        }
                    });
                app.state::<State>()
                    .shortcuts
                    .lock()
                    .unwrap()
                    .push(serde_json::json!({"key":key,"label":label,"registered":result.is_ok()}));
            }
            shell::install_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|w, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if w.label() == "clipboard" {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if w.label() == "clipboard" {
                    let _ = w.hide();
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if w.label().starts_with("pin-") {
                    let _ = w.app_handle().emit_to("main", "library-changed", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            init,
            shell::open_optional_panel,
            clipboard::clipboard_items,
            clipboard::hide_clipboard,
            clipboard::use_clipboard,
            clipboard::clear_clipboard_history,
            clipboard::clipboard_image_data,
            clipboard::edit_clipboard,
            request_screen_permission,
            save_image,
            save_settings,
            import_image,
            export_entry,
            pin_entry,
            pin_data,
            capture::monitors,
            capture::begin_capture,
            capture::overlay_data,
            capture::cancel_capture,
            capture::select_region,
            recording::start_recording,
            recording::stop_recording,
            recording::toggle_drawing,
            recording::recording_settings,
            recording::cancel_recording
        ])
        .build(tauri::generate_context!())
        .expect("应用启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { ref api, code, .. } = event {
                let state = app.state::<State>();
                let active = state.recording.lock().map(|r| r.is_some()).unwrap_or(true)
                    || state.busy.lock().map(|b| *b).unwrap_or(true);
                if active {
                    api.prevent_exit();
                    show_notice(app, "请先停止录制并等待保存完成");
                } else if code.is_none() && !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                clipboard::request_shelf(app, true);
            }
        });
}

#[cfg(test)]
mod background_tests {
    #[test]
    fn startup_never_creates_a_workbench_renderer() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["create"] == false));
        assert!(include_str!("../Info.plist").contains("<key>LSUIElement</key><true/>"));
    }
    #[test]
    fn missing_target_never_sends_paste_to_another_app() {
        assert!(crate::focus::paste(0).is_err());
    }
}
