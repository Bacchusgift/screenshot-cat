//! Bounded local clipboard history. macOS/Windows read only after a native change counter advances.
use super::*;
use arboard::{Clipboard, ImageData};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    time::Duration,
};
const MAX_ITEMS: usize = 100;
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TEXT: usize = 1024 * 1024;
const MAX_PIXELS: usize = 16_000_000;
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub kind: String,
    pub text: Option<String>,
    pub created_at: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}
pub struct History {
    pub notice: Mutex<Option<String>>,
    pub root: PathBuf,
    pub items: Mutex<Vec<Clip>>,
    board: Mutex<Option<Clipboard>>,
    image_write: Mutex<()>,
    pub paused: AtomicBool,
    pub target: AtomicI64,
    restored_sequence: Mutex<Option<i64>>,
    epoch: AtomicU64,
    opening: AtomicBool,
}
impl History {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(err)?;
        let mut items: Vec<Clip> = fs::read(root.join("index.json"))
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default();
        items.retain(|i| {
            valid_id(&i.id)
                && ((i.kind == "text" && i.text.as_ref().is_some_and(|t| t.len() <= MAX_TEXT))
                    || (i.kind == "image" && root.join(format!("{}.png", i.id)).is_file()))
        });
        items.truncate(MAX_ITEMS);
        Ok(Self {
            notice: Mutex::new(None),
            root,
            items: Mutex::new(items),
            board: Mutex::new(None),
            image_write: Mutex::new(()),
            paused: AtomicBool::new(false),
            target: AtomicI64::new(0),
            restored_sequence: Mutex::new(None),
            epoch: AtomicU64::new(0),
            opening: AtomicBool::new(false),
        })
    }
    fn board<T>(
        &self,
        f: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
    ) -> Result<T, String> {
        let mut g = self.board.lock().map_err(err)?;
        if g.is_none() {
            *g = Some(Clipboard::new().map_err(err)?);
        }
        f(g.as_mut().unwrap()).map_err(err)
    }
    fn persist(&self, items: &[Clip]) -> Result<(), String> {
        let tmp = self.root.join("index.tmp");
        fs::write(&tmp, serde_json::to_vec(items).map_err(err)?).map_err(err)?;
        fs::rename(tmp, self.root.join("index.json")).map_err(err)
    }
    fn remember(&self, clip: Clip) -> Result<bool, String> {
        let mut items = self.items.lock().map_err(err)?;
        if items.first().is_some_and(|i| i.id == clip.id) {
            return Ok(false);
        }
        items.retain(|i| i.id != clip.id);
        items.insert(0, clip);
        let mut total: u64 = items.iter().map(|i| i.bytes).sum();
        while items.len() > MAX_ITEMS || total > MAX_BYTES {
            let old = items.pop().unwrap();
            total = total.saturating_sub(old.bytes);
            if old.kind == "image" {
                let _ = fs::remove_file(self.root.join(format!("{}.png", old.id)));
                let _ = fs::remove_file(self.root.join(format!("{}-thumb.png", old.id)));
            }
        }
        self.persist(&items)?;
        Ok(true)
    }
    pub fn text(&self, text: String) -> Result<bool, String> {
        if text.is_empty() || text.len() > MAX_TEXT {
            return Ok(false);
        }
        let id = fingerprint("text", text.as_bytes());
        self.remember(Clip {
            id,
            kind: "text".into(),
            bytes: text.len() as u64,
            text: Some(text),
            created_at: now(),
            width: 0,
            height: 0,
        })
    }
    pub fn image(&self, image: image::RgbaImage) -> Result<bool, String> {
        let _write = self.image_write.lock().map_err(err)?;
        if image.width() as usize * image.height() as usize > MAX_PIXELS {
            return Ok(false);
        }
        let mut hash = Sha256::new();
        hash.update(image.width().to_le_bytes());
        hash.update(image.height().to_le_bytes());
        hash.update(image.as_raw());
        let id = format!("image-{:x}", hash.finalize());
        let full = self.root.join(format!("{id}.png"));
        if !full.is_file() {
            image.save(&full).map_err(err)?;
            image::imageops::thumbnail(&image, 420, 220)
                .save(self.root.join(format!("{id}-thumb.png")))
                .map_err(err)?;
        }
        let bytes = fs::metadata(full).map_err(err)?.len();
        self.remember(Clip {
            id,
            kind: "image".into(),
            text: None,
            created_at: now(),
            width: image.width(),
            height: image.height(),
            bytes,
        })
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn fingerprint(kind: &str, data: &[u8]) -> String {
    format!("{kind}-{:x}", Sha256::digest(data))
}
fn valid_id(id: &str) -> bool {
    ["text-", "image-"].iter().any(|p| {
        id.strip_prefix(p)
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
    })
}
#[cfg(target_os = "macos")]
fn sequence() -> Option<i64> {
    Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as i64)
}
#[cfg(target_os = "windows")]
fn sequence() -> Option<i64> {
    Some(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() } as i64)
}
#[cfg(target_os = "linux")]
fn sequence() -> Option<i64> {
    None
}
#[cfg(target_os = "macos")]
fn concealed() -> bool {
    objc2_app_kit::NSPasteboard::generalPasteboard()
        .types()
        .is_some_and(|types| {
            types.iter().any(|t| {
                matches!(
                    t.to_string().as_str(),
                    "org.nspasteboard.ConcealedType"
                        | "org.nspasteboard.TransientType"
                        | "org.nspasteboard.AutoGeneratedType"
                )
            })
        })
}
#[cfg(not(target_os = "macos"))]
fn concealed() -> bool {
    false
}
pub fn watch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = None;
        let mut first_pass = true;
        loop {
            let initial = std::mem::replace(&mut first_pass, false);
            std::thread::sleep(Duration::from_millis(if cfg!(target_os = "linux") {
                1200
            } else {
                450
            }));
            let h = app.state::<History>();
            if app
                .get_webview_window("clipboard")
                .is_none_or(|w| !w.is_visible().unwrap_or(false))
                && app
                    .state::<State>()
                    .selection
                    .lock()
                    .map(|s| s.is_none())
                    .unwrap_or(false)
            {
                let target = crate::focus::current();
                if target != 0 {
                    h.target.store(target, Ordering::Relaxed);
                }
            }
            let (seq, restored) = match h.restored_sequence.lock() {
                Ok(restored) => (sequence(), *restored),
                Err(_) => continue,
            };
            if h.paused.load(Ordering::Relaxed) {
                last = seq;
                continue;
            }
            if seq.is_some() && (last == seq || restored == seq) {
                last = seq;
                continue;
            }
            if concealed() {
                last = seq;
                continue;
            }
            // Prefer images when applications provide both image and text representations.
            let image = h.board(|b| b.get_image());
            if let Ok(image) = image {
                if image
                    .width
                    .checked_mul(image.height)
                    .is_some_and(|n| n <= MAX_PIXELS)
                    && sequence() == seq
                {
                    if let Some(rgba) = image::RgbaImage::from_raw(
                        image.width as u32,
                        image.height as u32,
                        image.bytes.into_owned(),
                    ) {
                        if h.image(rgba).unwrap_or(false) {
                            let _ = app.emit_to("clipboard", "clipboard-changed", ());
                            if !initial
                                && app
                                    .state::<State>()
                                    .selection
                                    .lock()
                                    .map(|s| s.is_none())
                                    .unwrap_or(false)
                            {
                                request_shelf(&app, false);
                            }
                        }
                    }
                }
                last = seq;
                continue;
            }
            if let Ok(text) = h.board(|b| b.get_text()) {
                if sequence() == seq {
                    if h.text(text).unwrap_or(false) {
                        let _ = app.emit_to("clipboard", "clipboard-changed", ());
                    }
                    last = seq;
                }
            }
            // A locked clipboard is retried; a valid unsupported format is inexpensive on the next tick.
        }
    });
}
pub fn copy_png(app: &tauri::AppHandle, bytes: &[u8]) -> Result<(), String> {
    let image = image::load_from_memory(bytes).map_err(err)?.into_rgba8();
    let h = app.state::<History>();
    h.board(|b| {
        b.set_image(ImageData {
            width: image.width() as usize,
            height: image.height() as usize,
            bytes: Cow::Borrowed(image.as_raw()),
        })
    })?;
    h.image(image)?;
    let _ = app.emit_to("clipboard", "clipboard-changed", ());
    request_shelf(app, false);
    Ok(())
}
pub fn request_shelf(app: &tauri::AppHandle, manual: bool) {
    let target = crate::focus::current();
    if target != 0 {
        app.state::<History>()
            .target
            .store(target, Ordering::Relaxed);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = show_shelf(&app, manual) {
            if let Ok(mut note) = app.state::<History>().notice.lock() {
                *note = Some(e);
            }
            if let Some(tray) = app.tray_by_id("main-tray") {
                let _ = tray.set_tooltip(Some("截图猫 · 剪贴板窗口暂不可用"));
            }
        }
    });
}
fn show_shelf(app: &tauri::AppHandle, manual: bool) -> Result<(), String> {
    let h = app.state::<History>();
    if manual {
        *h.notice.lock().map_err(err)? = None;
    }
    let existing = app.get_webview_window("clipboard");
    if !manual
        && existing
            .as_ref()
            .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
    {
        let _ = app.emit_to("clipboard", "clipboard-changed", ());
        return Ok(());
    }
    let w = if let Some(w) = existing {
        w
    } else {
        if h.opening.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let result = tauri::WebviewWindowBuilder::new(
            app,
            "clipboard",
            tauri::WebviewUrl::App("index.html?view=clipboard".into()),
        )
        .title("截图猫 · 剪贴板")
        .inner_size(1040.0, 270.0)
        .min_inner_size(320.0, 200.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .build();
        h.opening.store(false, Ordering::SeqCst);
        result.map_err(err)?
    };
    let cursor = app.cursor_position().map_err(err)?;
    let m = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(err)?
        .or(app.primary_monitor().map_err(err)?)
        .ok_or("没有可用显示器")?;
    let scale = m.scale_factor();
    let work = m.work_area();
    let width = (work.size.width as f64 / scale - 32.0).clamp(320.0, 1120.0);
    let height = (work.size.height as f64 / scale - 24.0).clamp(190.0, 270.0);
    w.set_size(tauri::LogicalSize::new(width, height))
        .map_err(err)?;
    w.set_position(tauri::PhysicalPosition::new(
        work.position.x + ((work.size.width as f64 - width * scale) / 2.0) as i32,
        work.position.y + work.size.height as i32 - (height * scale) as i32 - (12.0 * scale) as i32,
    ))
    .map_err(err)?;
    w.set_focusable(manual).map_err(err)?;
    w.show().map_err(err)?;
    if manual {
        w.set_focus().map_err(err)?;
    }
    let epoch = h.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to("clipboard", "shelf-shown", manual);
    if !manual {
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(6));
            let h = a.state::<History>();
            if h.epoch.load(Ordering::SeqCst) == epoch {
                if let Some(w) = a.get_webview_window("clipboard") {
                    let _ = w.hide();
                }
            }
        });
    }
    Ok(())
}
fn allow(w: &tauri::WebviewWindow) -> Result<(), String> {
    if ["clipboard", "main"].contains(&w.label()) {
        Ok(())
    } else {
        Err("此窗口无权访问剪贴板记录".into())
    }
}
#[tauri::command]
pub fn clipboard_items(
    window: tauri::WebviewWindow,
    state: tauri::State<History>,
) -> Result<serde_json::Value, String> {
    allow(&window)?;
    Ok(
        serde_json::json!({"items":*state.items.lock().map_err(err)?,"root":state.root,"paused":state.paused.load(Ordering::Relaxed),"notice":*state.notice.lock().map_err(err)?,"shortcut":if cfg!(target_os="macos"){"⌘ Control V"}else{"Ctrl Alt V"}}),
    )
}
#[tauri::command]
pub fn hide_clipboard(
    window: tauri::WebviewWindow,
    state: tauri::State<History>,
) -> Result<(), String> {
    if window.label() != "clipboard" {
        return Err("无效窗口".into());
    }
    state.epoch.fetch_add(1, Ordering::SeqCst);
    window.hide().map_err(err)
}
#[tauri::command]
pub async fn use_clipboard(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    paste: bool,
) -> Result<serde_json::Value, String> {
    allow(&window)?;
    let h = app.state::<History>();
    let target = h.target.load(Ordering::Relaxed);
    let clip = h
        .items
        .lock()
        .map_err(err)?
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or("记录已被清理")?;
    {
        let mut restored = h.restored_sequence.lock().map_err(err)?;
        if clip.kind == "text" {
            h.board(|b| b.set_text(clip.text.as_deref().unwrap_or_default()))?;
        } else {
            let path = h.root.join(format!("{}.png", clip.id));
            #[cfg(target_os = "macos")]
            copy_pasteboard_image(
                &objc2_app_kit::NSPasteboard::generalPasteboard(),
                &fs::read(path).map_err(err)?,
            )?;
            #[cfg(not(target_os = "macos"))]
            {
                let image = image::open(path).map_err(err)?.into_rgba8();
                h.board(|b| {
                    b.set_image(ImageData {
                        width: image.width() as usize,
                        height: image.height() as usize,
                        bytes: Cow::Borrowed(image.as_raw()),
                    })
                })?;
            }
        }
        *restored = sequence();
    }
    if !paste {
        return Ok(serde_json::json!({"pasted":false,"message":"已复制"}));
    }
    h.epoch.fetch_add(1, Ordering::SeqCst);
    let result = paste_in_target(&app, target).await;
    match result {
        Ok(()) => Ok(serde_json::json!({"pasted":true,"message":"已粘贴到原窗口"})),
        Err(message) => {
            if let Ok(mut notice) = h.notice.lock() {
                *notice = Some(message.clone());
            }
            if app
                .get_webview_window("clipboard")
                .is_some_and(|w| !w.is_visible().unwrap_or(false))
            {
                show_shelf(&app, false)?;
            }
            Ok(serde_json::json!({"pasted":false,"message":message}))
        }
    }
}
#[cfg(target_os = "macos")]
fn copy_pasteboard_image(board: &objc2_app_kit::NSPasteboard, bytes: &[u8]) -> Result<(), String> {
    use objc2::{rc::Retained, runtime::ProtocolObject, AnyThread};
    use objc2_app_kit::{
        NSBitmapImageRep, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
        NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData};

    let png = NSData::with_bytes(bytes);
    let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &png)
        .ok_or("无法读取剪贴板图片")?;
    let item = NSPasteboardItem::new();
    unsafe {
        if !item.setData_forType(&png, NSPasteboardTypePNG) {
            return Err("无法复制图片".into());
        }
        if let Some(tiff) = bitmap.TIFFRepresentation() {
            item.setData_forType(&tiff, NSPasteboardTypeTIFF);
        }
        let item: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
            ProtocolObject::from_retained(item);
        board.clearContents();
        if !board.writeObjects(&NSArray::from_retained_slice(&[item])) {
            return Err("无法复制图片".into());
        }
    }
    Ok(())
}
#[cfg(all(test, target_os = "macos"))]
#[test]
fn clipboard_image_exposes_png_and_tiff_to_target_apps() {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    let pasteboard = NSPasteboard::pasteboardWithUniqueName();
    let png = include_bytes!("../icons/32x32.png");
    copy_pasteboard_image(&pasteboard, png).unwrap();
    unsafe {
        assert_eq!(
            pasteboard
                .dataForType(NSPasteboardTypePNG)
                .unwrap()
                .to_vec(),
            png
        );
        assert!(!pasteboard
            .dataForType(NSPasteboardTypeTIFF)
            .unwrap()
            .is_empty());
    }
}
async fn paste_in_target(app: &tauri::AppHandle, target: i64) -> Result<(), String> {
    let shelf = app.get_webview_window("clipboard");
    #[cfg(target_os = "macos")]
    {
        if !crate::focus::can_paste() {
            return Err(
                "已复制。请在系统设置 → 隐私与安全性 → 辅助功能中允许截图猫，或按 ⌘V 手动粘贴。"
                    .into(),
            );
        }
        if target <= 0 {
            return Err("已复制；请在目标应用中呼出剪贴板，或按 ⌘V 手动粘贴。".into());
        }
        let (send, receive) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let result = objc2_foundation::MainThreadMarker::new()
                .ok_or_else(|| "无法切换到原窗口".to_string())
                .and_then(|marker| crate::focus::restore(target, marker));
            let _ = send.try_send(result);
        })
        .map_err(err)?;
        let mut receive = receive;
        receive.recv().await.ok_or("无法切换到原窗口")??;
        tauri::async_runtime::spawn_blocking(move || crate::focus::wait_until_active(target))
            .await
            .map_err(err)??;
    }
    if let Some(shelf) = shelf {
        shelf.hide().map_err(err)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(100));
        crate::focus::paste(target)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub fn clear_clipboard_history(
    window: tauri::WebviewWindow,
    state: tauri::State<History>,
) -> Result<(), String> {
    allow(&window)?;
    let mut items = state.items.lock().map_err(err)?;
    for clip in items.iter().filter(|i| i.kind == "image") {
        let _ = fs::remove_file(state.root.join(format!("{}.png", clip.id)));
        let _ = fs::remove_file(state.root.join(format!("{}-thumb.png", clip.id)));
    }
    items.clear();
    state.persist(&items)
}
#[tauri::command]
pub fn clipboard_image_data(
    window: tauri::WebviewWindow,
    state: tauri::State<History>,
    id: String,
) -> Result<String, String> {
    require_main(&window)?;
    if !state
        .items
        .lock()
        .map_err(err)?
        .iter()
        .any(|i| i.id == id && i.kind == "image")
    {
        return Err("图片不存在".into());
    }
    use base64::Engine;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD
            .encode(fs::read(state.root.join(format!("{id}.png"))).map_err(err)?)
    ))
}
#[tauri::command]
pub fn edit_clipboard(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    allow(&window)?;
    if !app
        .state::<History>()
        .items
        .lock()
        .map_err(err)?
        .iter()
        .any(|i| i.id == id && i.kind == "image")
    {
        return Err("图片不存在".into());
    }
    if let Some(w) = app.get_webview_window("clipboard") {
        let _ = w.hide();
    }
    open_panel(&app, &format!("edit:{id}"));
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn history() -> History {
        History::load(std::env::temp_dir().join(format!("clipboard-test-{}", uuid::Uuid::new_v4())))
            .unwrap()
    }
    #[test]
    fn recopy_moves_existing_content_without_duplicates() {
        let h = history();
        h.text("a".into()).unwrap();
        h.text("b".into()).unwrap();
        h.text("a".into()).unwrap();
        let items = h.items.lock().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text.as_deref(), Some("a"));
        drop(items);
        fs::remove_dir_all(h.root).unwrap();
    }
    #[test]
    fn bounds_history_and_reloads_after_restart() {
        let h = history();
        for n in 0..110 {
            h.text(format!("item-{n}")).unwrap();
        }
        let loaded = History::load(h.root.clone()).unwrap();
        assert_eq!(loaded.items.lock().unwrap().len(), MAX_ITEMS);
        assert_eq!(
            loaded.items.lock().unwrap()[0].text.as_deref(),
            Some("item-109")
        );
        fs::remove_dir_all(h.root).unwrap();
    }
    #[test]
    fn refuses_oversize_text_and_path_traversal() {
        let h = history();
        assert!(!h.text("a".repeat(MAX_TEXT + 1)).unwrap());
        assert!(!valid_id("../../outside"));
        assert!(h.items.lock().unwrap().is_empty());
        fs::remove_dir_all(h.root).unwrap();
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;
    #[test]
    fn image_content_deduplicates_and_eviction_removes_both_files() {
        let h = History::load(
            std::env::temp_dir().join(format!("cat-image-test-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([17, 124, 102, 255]));
        assert!(h.image(image.clone()).unwrap());
        assert!(!h.image(image).unwrap());
        let id = h.items.lock().unwrap()[0].id.clone();
        assert_eq!(
            image::open(h.root.join(format!("{id}.png")))
                .unwrap()
                .width(),
            8
        );
        assert!(h.root.join(format!("{id}-thumb.png")).is_file());
        for i in 0..MAX_ITEMS {
            h.text(format!("new-{i}")).unwrap();
        }
        assert!(!h.root.join(format!("{id}.png")).exists());
        assert!(!h.root.join(format!("{id}-thumb.png")).exists());
        fs::remove_dir_all(h.root).unwrap();
    }
}
