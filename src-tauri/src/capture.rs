use super::*;
use base64::Engine;
#[cfg(not(target_os = "macos"))]
use tauri::PhysicalPosition;
use tauri::PhysicalSize;
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn checked(&self, w: u32, h: u32) -> Result<Self, String> {
        if self.width < 2
            || self.height < 2
            || self.x >= w
            || self.y >= h
            || self.width > w - self.x
            || self.height > h - self.y
        {
            return Err("选区超出屏幕或尺寸过小".into());
        }
        Ok(self.clone())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub mode: String,
    pub monitor_id: u32,
    pub monitor_index: usize,
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub origin_x: i32,
    pub origin_y: i32,
    pub rect: Option<Rect>,
}
#[tauri::command]
pub fn monitors(window: tauri::WebviewWindow) -> Result<Vec<serde_json::Value>, String> {
    require_main(&window)?;
    xcap::Monitor::all().map_err(err)?.iter().enumerate().map(|(i,m)|Ok(serde_json::json!({"id":m.id().map_err(err)?,"index":i,"name":m.name().map_err(err)?,"width":m.width().map_err(err)?,"height":m.height().map_err(err)?,"primary":m.is_primary().map_err(err)?}))).collect()
}
#[tauri::command]
pub async fn begin_capture(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    mode: String,
    monitor_id: Option<u32>,
) -> Result<(), String> {
    require_main(&window)?;
    begin_internal(app, mode, monitor_id).await
}
pub async fn begin_internal(
    app: tauri::AppHandle,
    mode: String,
    monitor_id: Option<u32>,
) -> Result<(), String> {
    if !screen_permission() {
        return Err("请先在系统设置中允许截图猫进行屏幕录制，然后退出并重新打开应用".into());
    }
    if !["image", "video", "gif"].contains(&mode.as_str()) {
        return Err("无效截取类型".into());
    }
    {
        let s = app.state::<State>();
        if *s.busy.lock().map_err(err)?
            || s.recording.lock().map_err(err)?.is_some()
            || s.selection.lock().map_err(err)?.is_some()
        {
            return Err("已有截取任务正在进行".into());
        }
        *s.busy.lock().map_err(err)? = true;
    }
    let a = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(w) = main_window(&a) {
            w.hide().map_err(err)?;
        }
        std::thread::sleep(std::time::Duration::from_millis(220));
        let list = xcap::Monitor::all().map_err(err)?;
        let pointer_monitor = if monitor_id.is_none() {
            #[cfg(target_os = "macos")]
            let point = core_graphics::event_source::CGEventSource::new(
                core_graphics::event_source::CGEventSourceStateID::CombinedSessionState,
            )
            .ok()
            .and_then(|source| core_graphics::event::CGEvent::new(source).ok())
            .map(|e| e.location())
            .map(|p| (p.x as i32, p.y as i32));
            #[cfg(not(target_os = "macos"))]
            let point = main_window(&a)
                .and_then(|w| w.cursor_position().ok())
                .map(|p| (p.x as i32, p.y as i32));
            point
                .and_then(|(x, y)| xcap::Monitor::from_point(x, y).ok())
                .and_then(|m| m.id().ok())
        } else {
            None
        };
        let chosen_id = monitor_id.or(pointer_monitor);
        let (index, monitor) = list
            .iter()
            .enumerate()
            .find(|(_, m)| {
                chosen_id
                    .map(|id| m.id().ok() == Some(id))
                    .unwrap_or_else(|| m.is_primary().unwrap_or(false))
            })
            .ok_or("没有可用显示器")?;
        let image = monitor
            .capture_image()
            .map_err(|e| format!("无法读取屏幕，请允许屏幕录制权限后重新启动应用：{e}"))?;
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(err)?;
        let selection = Selection {
            mode,
            monitor_id: monitor.id().map_err(err)?,
            monitor_index: index,
            image: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            ),
            width: image.width(),
            height: image.height(),
            scale: monitor.scale_factor().map_err(err)? as f64,
            origin_x: monitor.x().map_err(err)?,
            origin_y: monitor.y().map_err(err)?,
            rect: None,
        };
        *a.state::<State>().selection.lock().map_err(err)? = Some(selection.clone());
        let overlay = tauri::WebviewWindowBuilder::new(
            &a,
            "overlay",
            tauri::WebviewUrl::App("index.html?view=overlay".into()),
        )
        .title("选择截取区域")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(err)?;
        #[cfg(target_os = "macos")]
        overlay
            .set_position(tauri::LogicalPosition::new(
                selection.origin_x as f64,
                selection.origin_y as f64,
            ))
            .map_err(err)?;
        #[cfg(not(target_os = "macos"))]
        overlay
            .set_position(PhysicalPosition::new(
                selection.origin_x,
                selection.origin_y,
            ))
            .map_err(err)?;
        overlay
            .set_size(PhysicalSize::new(selection.width, selection.height))
            .map_err(err)?;
        overlay.show().map_err(err)?;
        overlay.set_focus().map_err(err)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(err)
    .and_then(|v| v);
    *app.state::<State>().busy.lock().map_err(err)? = false;
    if result.is_err() {
        restore(&app);
    }
    result
}
#[tauri::command]
pub fn overlay_data(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
) -> Result<Selection, String> {
    if window.label() != "overlay" {
        return Err("无权读取选区".into());
    }
    state
        .selection
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("选区已关闭".into())
}
#[tauri::command]
pub fn cancel_capture(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "overlay" {
        return Err("无效窗口".into());
    }
    if app
        .state::<State>()
        .recording
        .lock()
        .map_err(err)?
        .is_none()
    {
        restore(&app);
    }
    Ok(())
}
#[tauri::command]
pub async fn select_region(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    rect: Rect,
) -> Result<(), String> {
    if window.label() != "overlay" {
        return Err("无效窗口".into());
    }
    let state = app.state::<State>();
    let mut selection = state.selection.lock().map_err(err)?;
    let s = selection.as_mut().ok_or("选区已关闭")?;
    let rect = rect.checked(s.width, s.height)?;
    if s.mode == "image" {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s.image.split(',').nth(1).ok_or("图片无效")?)
            .map_err(err)?;
        let image = image::load_from_memory(&bytes).map_err(err)?.crop_imm(
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        );
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(err)?;
        drop(selection);
        restore(&app);
        let entry = new_entry("image", "png", rect.width, rect.height);
        fs::write(
            app.state::<State>().library.join(&entry.name),
            out.get_ref(),
        )
        .map_err(err)?;
        save_entry(&app, entry)?;
        clipboard::copy_png(&app, out.get_ref())?;
    } else {
        s.rect = Some(rect.clone());
        s.image.clear();
        let mode = s.mode.clone();
        let scale = s.scale;
        let x = s.origin_x;
        let y = s.origin_y;
        let height = s.height;
        let width = s.width;
        drop(selection);
        // During recording the native overlay occupies only the selected region.
        // Outside that region clicks must reach the desktop and the controls.
        #[cfg(target_os = "macos")]
        window
            .set_position(tauri::LogicalPosition::new(
                x as f64 + rect.x as f64 / scale,
                y as f64 + rect.y as f64 / scale,
            ))
            .map_err(err)?;
        #[cfg(not(target_os = "macos"))]
        window
            .set_position(PhysicalPosition::new(x + rect.x as i32, y + rect.y as i32))
            .map_err(err)?;
        window
            .set_size(PhysicalSize::new(rect.width, rect.height))
            .map_err(err)?;
        window.set_focusable(false).map_err(err)?;
        window.emit("selection-ready", &rect).map_err(err)?;
        // Controls are placed in the larger free band; if no band fits, use the top edge.
        let toolbar_y = if rect.y >= 80 {
            rect.y - 76
        } else if height.saturating_sub(rect.y + rect.height) >= 80 {
            rect.y + rect.height + 8
        } else {
            0
        };
        let controls = tauri::WebviewWindowBuilder::new(
            &app,
            "controls",
            tauri::WebviewUrl::App(format!("index.html?view=controls&mode={mode}").into()),
        )
        .title("录制控制")
        .content_protected(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(620.0, 64.0)
        .build()
        .map_err(err)?;
        #[cfg(target_os = "macos")]
        controls
            .set_position(tauri::LogicalPosition::new(
                x as f64 + ((width as f64 / scale - 620.0) / 2.0).max(0.0),
                y as f64 + toolbar_y as f64 / scale,
            ))
            .map_err(err)?;
        #[cfg(not(target_os = "macos"))]
        controls
            .set_position(PhysicalPosition::new(
                x + ((width as f64 - 620.0 * scale) / 2.0).max(0.0) as i32,
                y + toolbar_y as i32,
            ))
            .map_err(err)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_overflow_and_zero() {
        assert!(Rect {
            x: u32::MAX,
            y: 0,
            width: 2,
            height: 2
        }
        .checked(1920, 1080)
        .is_err());
        assert!(Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 2
        }
        .checked(1920, 1080)
        .is_err());
        assert!(Rect {
            x: 1919,
            y: 0,
            width: 2,
            height: 2
        }
        .checked(1920, 1080)
        .is_err());
    }
    #[test]
    fn preserves_valid_hidpi_region() {
        let r = Rect {
            x: 200,
            y: 100,
            width: 800,
            height: 600,
        }
        .checked(3840, 2160)
        .unwrap();
        assert_eq!(r.width, 800);
    }
}
