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
#[cfg(target_os = "macos")]
fn open_screen_recording_settings() -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{ns_string, NSURL};
    let url = NSURL::URLWithString(ns_string!(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    ))
    .ok_or("无法打开屏幕录制设置")?;
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err("请手动打开「系统设置 → 隐私与安全性 → 屏幕与系统录音」".into())
    }
}
#[tauri::command]
fn screen_permission_status(window: tauri::WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    Ok(screen_permission())
}
#[tauri::command]
fn request_screen_permission(window: tauri::WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    #[cfg(target_os = "macos")]
    if !screen_permission() {
        open_screen_recording_settings()?;
    }
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
    tauri::async_runtime::spawn_blocking(move || pin_internal(&app, &e))
        .await
        .map_err(err)?
}
fn pin_internal(app: &tauri::AppHandle, e: &Entry) -> Result<(), String> {
    let label = format!("pin-{}", e.id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let pin = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?view=pin&id={}", e.id).into()),
    )
    .title("桌面贴图")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .visible(false)
    .center()
    .build()
    .map_err(err)?;
    let size = tauri::PhysicalSize::new(e.width, e.height);
    pin.set_size(size).map_err(err)?;
    pin.center().map_err(err)?;
    let window = pin.clone();
    pin.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
            // Preserve image pixels when moving between displays with different scaling.
            let window = window.clone();
            let _ = window.clone().run_on_main_thread(move || {
                let _ = window.set_size(size);
            });
        }
    });
    pin.show().map_err(err)?;
    pin.set_focus().map_err(err)?;
    Ok(())
}
#[tauri::command]
fn pin_data(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
    id: String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let (e, p) = pin_source(&window, &state, &id)?;
    let png = fs::read(p).map_err(err)?;
    let mut value = serde_json::to_value(e).map_err(err)?;
    value["data"] = serde_json::json!(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ));
    Ok(value)
}
fn pin_source(
    window: &tauri::WebviewWindow,
    state: &State,
    id: &str,
) -> Result<(Entry, PathBuf), String> {
    if window.label() != format!("pin-{id}") {
        return Err("无效贴图窗口".into());
    }
    let (entry, path) = entry_path(state, id)?;
    if entry.kind != "image" {
        return Err("仅截图可以贴图".into());
    }
    Ok((entry, path))
}
fn pin_edit_png(data: &str, entry: &Entry) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if data.len() > 100 * 1024 * 1024 {
        return Err("贴图过大".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            data.strip_prefix("data:image/png;base64,")
                .ok_or("需要 PNG 图片")?,
        )
        .map_err(err)?;
    let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes)).map_err(err)?;
    if image::ImageDecoder::dimensions(&decoder) != (entry.width, entry.height) {
        return Err("贴图分辨率不匹配".into());
    }
    image::DynamicImage::from_decoder(decoder).map_err(err)?;
    Ok(bytes)
}
#[tauri::command]
async fn save_pin_edit(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    data: String,
) -> Result<(), String> {
    let (original, _) = pin_source(&window, &app.state::<State>(), &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = pin_edit_png(&data, &original)?;
        let entry = new_entry("image", "png", original.width, original.height);
        fs::write(app.state::<State>().library.join(&entry.name), bytes).map_err(err)?;
        save_entry(&app, entry)?;
        Ok(())
    })
    .await
    .map_err(err)?
}
#[tauri::command]
async fn save_pin_as(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    data: Option<String>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let (entry, source) = pin_source(&window, &app.state::<State>(), &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match data {
            Some(data) => pin_edit_png(&data, &entry)?,
            None => fs::read(source).map_err(err)?,
        };
        let destination = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("另存贴图")
            .set_file_name("截图.png")
            .add_filter("PNG 图片", &["png"])
            .blocking_save_file();
        if let Some(destination) = destination {
            fs::write(destination.into_path().map_err(err)?, bytes).map_err(err)?;
            return Ok(true);
        }
        Ok(false)
    })
    .await
    .map_err(err)?
}
fn restore(app: &tauri::AppHandle) {
    for label in ["overlay", "controls"] {
        if let Some(window) = app.get_webview_window(label) {
            // Detach the webview first so the next capture can reuse its label.
            let _ = window.as_ref().close();
            let _ = window.destroy();
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
                                "clipboard" => clipboard::request_shelf(app),
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
            screen_permission_status,
            save_image,
            save_settings,
            import_image,
            export_entry,
            pin_entry,
            pin_data,
            save_pin_edit,
            save_pin_as,
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
