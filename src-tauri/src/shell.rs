use super::*;
use std::sync::atomic::Ordering;
pub fn open_panel(app: &tauri::AppHandle, route: &str) {
    let app = app.clone();
    let route = route.to_string();
    std::thread::spawn(move || {
        if let Some(w) = main_window(&app) {
            let _ = w.emit("panel-route", &route);
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        if app
            .state::<State>()
            .panel_opening
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        let result = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App(format!("index.html?panel={route}").into()),
        )
        .title("截图猫")
        .inner_size(700.0, 560.0)
        .min_inner_size(420.0, 380.0)
        .skip_taskbar(true)
        .visible(false)
        .build();
        app.state::<State>()
            .panel_opening
            .store(false, Ordering::SeqCst);
        match result {
            Ok(w) => {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => show_notice(&app, &e.to_string()),
        }
    });
}
pub fn show_notice(app: &tauri::AppHandle, message: &str) {
    if let Some(h) = app.try_state::<clipboard::History>() {
        if let Ok(mut note) = h.notice.lock() {
            *note = Some(message.into());
        }
    }
    let _ = app.emit_to("clipboard", "clipboard-notice", message);
}
pub fn request_capture(app: &tauri::AppHandle, mode: &str) {
    let app = app.clone();
    let mode = mode.to_string();
    #[cfg(target_os = "macos")]
    if !screen_permission() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let a = app.clone();
        app.dialog()
            .message("当前安装的截图猫没有屏幕录制权限。如果系统设置里已经开启，请移除旧条目，重新添加当前安装的截图猫，然后退出并重新打开。")
            .title("截图猫需要屏幕录制权限")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("打开屏幕录制设置".into(), "稍后".into()))
            .show(move |open| {
                if open {
                    if let Err(e) = open_screen_recording_settings() {
                        show_notice(&a, &e);
                    }
                }
            });
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = capture::begin_internal(app.clone(), mode, None).await {
            show_notice(&app, &e);
        }
    });
}
#[tauri::command]
pub fn open_optional_panel(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    route: String,
) -> Result<(), String> {
    if !["main", "clipboard"].contains(&window.label())
        || !["settings", "history"].contains(&route.as_str())
    {
        return Err("无效面板".into());
    }
    open_panel(&app, &route);
    Ok(())
}
pub fn install_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    let make =
        |id, text, accelerator: Option<&str>| MenuItem::with_id(app, id, text, true, accelerator);
    let shot = make("capture", "区域截图", Some("CmdOrCtrl+Shift+1"))?;
    let gif = make("gif", "录制 GIF 动图", Some("CmdOrCtrl+Shift+3"))?;
    let video = make("video", "录制视频", Some("CmdOrCtrl+Shift+2"))?;
    let stop = make("stop", "停止录制", Some("CmdOrCtrl+Shift+X"))?;
    let clips = make(
        "clipboard",
        "剪贴板记录",
        Some(if cfg!(target_os = "macos") {
            "Command+Control+V"
        } else {
            "Control+Alt+V"
        }),
    )?;
    let pin = make("pin", "贴上最近图片", None)?;
    let unpin = make("unpin", "关闭全部贴图", None)?;
    let paused = CheckMenuItem::with_id(app, "pause", "暂停剪贴板记录", true, false, None::<&str>)?;
    let history = make("history", "截图与视频记录…", None)?;
    let settings = make("settings", "偏好设置…", None)?;
    let quit = make("quit", "退出截图猫", Some("CmdOrCtrl+Q"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &shot, &gif, &video, &stop, &sep, &clips, &pin, &unpin, &paused, &sep2, &history,
            &settings, &sep3, &quit,
        ],
    )?;
    tauri::tray::TrayIconBuilder::with_id("main-tray")
        .icon(tauri::image::Image::from_bytes(
            if cfg!(target_os = "macos") {
                include_bytes!("../icons/tray.png")
            } else {
                include_bytes!("../icons/tray-color.png")
            },
        )?)
        .icon_as_template(cfg!(target_os = "macos"))
        .show_menu_on_left_click(true)
        .tooltip("截图猫")
        .menu(&menu)
        .on_menu_event(move |app, e| match e.id.as_ref() {
            "capture" => request_capture(app, "image"),
            "gif" => request_capture(app, "gif"),
            "video" => request_capture(app, "video"),
            "clipboard" => clipboard::request_shelf(app),
            "history" | "settings" => open_panel(app, e.id.as_ref()),
            "stop" => {
                let a = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = recording::stop_internal(&a) {
                        show_notice(&a, &e);
                    }
                });
            }
            "pin" => {
                let a = app.clone();
                std::thread::spawn(move || {
                    let result = (|| {
                        let h = a.state::<clipboard::History>();
                        let clip = h
                            .items
                            .lock()
                            .map_err(err)?
                            .iter()
                            .find(|i| i.kind == "image")
                            .cloned()
                            .ok_or("还没有复制过图片")?;
                        let entry = new_entry("image", "png", clip.width, clip.height);
                        fs::copy(
                            h.root.join(format!("{}.png", clip.id)),
                            a.state::<State>().library.join(&entry.name),
                        )
                        .map_err(err)?;
                        save_entry(&a, entry.clone())?;
                        pin_internal(&a, &entry, None)
                    })();
                    if let Err(e) = result {
                        show_notice(&a, &e);
                    }
                });
            }
            "unpin" => {
                for (label, w) in app.webview_windows() {
                    if label.starts_with("pin-") {
                        let _ = w.close();
                    }
                }
            }
            "pause" => {
                let h = app.state::<clipboard::History>();
                let value = !h.paused.load(Ordering::Relaxed);
                h.paused.store(value, Ordering::Relaxed);
                let _ = paused.set_checked(value);
                let _ = app.emit_to("clipboard", "clipboard-changed", ());
            }
            "quit" => {
                let state = app.state::<State>();
                if state.recording.lock().map(|r| r.is_some()).unwrap_or(true)
                    || *state.busy.lock().unwrap()
                {
                    show_notice(app, "请先停止录制并等待保存完成");
                } else {
                    state.quitting.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
