use super::*;
use crate::capture::Selection;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
pub struct Recording {
    child: Child,
    entry: Entry,
    started: Instant,
    log: PathBuf,
    drawing: bool,
}
pub fn ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(format!("ffmpeg{suffix}")));
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(format!("ffmpeg{suffix}")));
    }
    #[cfg(debug_assertions)]
    {
        let triple = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else if cfg!(target_os = "windows") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-pc-windows-msvc"
            } else {
                "x86_64-pc-windows-msvc"
            }
        } else if cfg!(target_arch = "aarch64") {
            "aarch64-unknown-linux-gnu"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("binaries/ffmpeg-{triple}{suffix}")),
        );
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("内置 FFmpeg 缺失，请运行 pnpm prepare:ffmpeg 后重新构建".into())
}
fn command(binary: &PathBuf) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(binary);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
fn input_args(s: &Selection, fps: u32) -> Result<Vec<String>, String> {
    let r = s.rect.as_ref().ok_or("请先选择录制区域")?;
    let args: Vec<String>;
    #[cfg(target_os = "macos")]
    {
        // AVFoundation's "Capture screen N" follows CGGetActiveDisplayList order.
        let ids = core_graphics::display::CGDisplay::active_displays()
            .map_err(|e| format!("无法枚举屏幕：{e}"))?;
        let index = ids
            .iter()
            .position(|id| *id == s.monitor_id)
            .ok_or("显示器已断开")?;
        args = vec![
            "-f".into(),
            "avfoundation".into(),
            "-framerate".into(),
            fps.to_string(),
            "-capture_cursor".into(),
            "1".into(),
            "-pixel_format".into(),
            "nv12".into(),
            "-i".into(),
            format!("Capture screen {index}:none"),
            "-vf".into(),
            format!(
                "crop={}:{}:{}:{},pad=ceil(iw/2)*2:ceil(ih/2)*2",
                r.width, r.height, r.x, r.y
            ),
        ];
    }
    #[cfg(target_os = "windows")]
    {
        args = vec![
            "-f".into(),
            "gdigrab".into(),
            "-framerate".into(),
            fps.to_string(),
            "-offset_x".into(),
            (s.origin_x + r.x as i32).to_string(),
            "-offset_y".into(),
            (s.origin_y + r.y as i32).to_string(),
            "-video_size".into(),
            format!("{}x{}", r.width, r.height),
            "-i".into(),
            "desktop".into(),
            "-vf".into(),
            "pad=ceil(iw/2)*2:ceil(ih/2)*2".into(),
        ];
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
            return Err(
                "当前版本录屏支持 Linux X11；Wayland 的 PipeWire 录制尚未实现，请切换到 X11 会话"
                    .into(),
            );
        }
        let display = std::env::var("DISPLAY").map_err(|_| "缺少 X11 DISPLAY 环境变量")?;
        args = vec![
            "-f".into(),
            "x11grab".into(),
            "-framerate".into(),
            fps.to_string(),
            "-video_size".into(),
            format!("{}x{}", r.width, r.height),
            "-i".into(),
            format!(
                "{display}+{},{}",
                s.origin_x + r.x as i32,
                s.origin_y + r.y as i32
            ),
            "-vf".into(),
            "pad=ceil(iw/2)*2:ceil(ih/2)*2".into(),
        ];
    }
    Ok(args)
}
fn encoding_args(hardware: bool) -> Vec<&'static str> {
    if hardware {
        #[cfg(target_os = "macos")]
        {
            return vec![
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                "6000k",
                "-pix_fmt",
                "yuv420p",
            ];
        }
        #[cfg(target_os = "windows")]
        {
            return vec!["-c:v", "h264_mf", "-b:v", "6000k", "-pix_fmt", "nv12"];
        }
    }
    vec!["-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p"]
}
#[tauri::command]
pub async fn start_recording(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if window.label() != "controls" {
        return Err("无效录制窗口".into());
    }
    let a = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || start_internal(&a))
        .await
        .map_err(err)?;
    if let Err(ref message) = result {
        restore(&app);
        show_notice(&app, message);
    }
    result
}
fn start_internal(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let mut guard = state.recording.lock().map_err(err)?;
    if guard.is_some() {
        return Err("录制正在进行".into());
    }
    let s = state
        .selection
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("选区已失效")?;
    let r = s.rect.as_ref().ok_or("请先选择区域")?;
    let settings = state.settings.lock().map_err(err)?.clone();
    let binary = ffmpeg_path(app)?;
    let entry = new_entry(&s.mode, "mp4", r.width, r.height);
    let output = state.library.join(&entry.name);
    let log = state.library.join(format!("{}.log", entry.id));
    let args = input_args(&s, if s.mode == "gif" { 15 } else { settings.fps })?;
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_ignore_cursor_events(true).map_err(err)?;
        w.emit("recording-started", ()).map_err(err)?;
    }
    // A failed hardware encoder falls back before the session is exposed as recording.
    let attempts =
        if settings.encoder == "auto" && cfg!(any(target_os = "macos", target_os = "windows")) {
            vec![true, false]
        } else {
            vec![false]
        };
    let mut active = None;
    let mut last_error = String::new();
    for hardware in attempts {
        let log_file = fs::File::create(&log).map_err(err)?;
        let mut cmd = command(&binary);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.25",
        ])
        .args(&args)
        .args(encoding_args(hardware))
        .args([
            "-an",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
        ]);
        if s.mode == "gif" {
            cmd.args(["-t", "15"]);
        }
        let mut child = cmd
            .arg(&output)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log_file)
            .spawn()
            .map_err(err)?;
        // A living child is not proof of recording: permission prompts can stall
        // capture indefinitely. Only acknowledge a session after the first frame.
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if line
                        .strip_prefix("frame=")
                        .and_then(|n| n.trim().parse::<u64>().ok())
                        .unwrap_or(0)
                        > 0
                    {
                        let _ = ready_tx.try_send(());
                    }
                }
            });
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut ready = false;
        loop {
            if ready_rx.recv_timeout(Duration::from_millis(200)).is_ok() {
                ready = true;
                break;
            }
            if child.try_wait().map_err(err)?.is_some() {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                last_error =
                    "12 秒内未收到画面，请授予应用及内置 FFmpeg 屏幕录制权限后重启应用".into();
                break;
            }
        }
        if ready {
            active = Some(child);
            break;
        }
        if last_error.starts_with("12 秒") {
            break;
        }
        last_error = fs::read_to_string(&log).unwrap_or_default();
    }
    let child = match active {
        Some(c) => c,
        None => {
            drop(guard);
            let _ = fs::remove_file(&output);
            restore(app);
            return Err(format!(
                "录制启动失败，请检查屏幕权限和编码器：{last_error}"
            ));
        }
    };
    let id = entry.id.clone();
    *guard = Some(Recording {
        child,
        entry,
        started: Instant::now(),
        log,
        drawing: false,
    });
    drop(guard);
    app.emit_to("controls", "recording-started", ())
        .map_err(err)?;
    let a = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let state = a.state::<State>();
        let mut guard = match state.recording.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        let session = match guard.as_mut() {
            Some(r) if r.entry.id == id => r,
            _ => break,
        };
        match session.child.try_wait() {
            Ok(Some(status)) => {
                drop(guard);
                if let Err(e) = finish(&a, !status.success()) {
                    show_notice(&a, &e);
                }
                break;
            }
            Err(e) => {
                drop(guard);
                show_notice(&a, &e.to_string());
                let _ = stop_internal(&a);
                break;
            }
            _ => {}
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn stop_recording(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !["main", "controls"].contains(&window.label()) {
        return Err("无效窗口".into());
    }
    tauri::async_runtime::spawn_blocking(move || stop_internal(&app))
        .await
        .map_err(err)?
}
pub fn stop_internal(app: &tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<State>();
        let mut guard = state.recording.lock().map_err(err)?;
        let r = match guard.as_mut() {
            Some(r) => r,
            None => return Ok(()),
        };
        if let Some(stdin) = r.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            if r.child.try_wait().map_err(err)?.is_some() {
                break;
            }
            if Instant::now() > end {
                let _ = r.child.kill();
                let _ = r.child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    finish(app, false)
}
fn finish(app: &tauri::AppHandle, failed: bool) -> Result<(), String> {
    let state = app.state::<State>();
    let mut session = {
        let mut g = state.recording.lock().map_err(err)?;
        match g.take() {
            Some(r) => r,
            None => return Ok(()),
        }
    };
    *state.busy.lock().map_err(err)? = true;
    restore(app);
    let _ = app.emit_to("main", "processing", true);
    let result = (|| {
        let input = state.library.join(&session.entry.name);
        let error = fs::read_to_string(&session.log).unwrap_or_default();
        if fs::metadata(&input).map(|m| m.len()).unwrap_or(0) < 1024 {
            let _ = fs::remove_file(input);
            return Err(format!("未生成有效视频，请检查屏幕录制权限：{error}"));
        }
        session.entry.duration =
            session
                .started
                .elapsed()
                .as_secs_f64()
                .min(if session.entry.kind == "gif" {
                    15.0
                } else {
                    f64::MAX
                });
        if session.entry.kind == "gif" && !failed {
            let output = input.with_extension("gif");
            let status=command(&ffmpeg_path(app)?).args(["-hide_banner","-loglevel","error","-y","-i"]).arg(&input).args(["-t","15","-filter_complex","fps=12,scale=min(960\\,iw):-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse","-loop","0"]).arg(&output).output().map_err(err)?;
            if status.status.success() {
                session.entry.name = output.file_name().unwrap().to_string_lossy().into();
                let _ = fs::remove_file(&input);
            } else {
                session.entry.kind = "video".into();
                save_entry(app, session.entry.clone())?;
                return Err(format!(
                    "GIF 转换失败，原始 MP4 已保存：{}",
                    String::from_utf8_lossy(&status.stderr)
                ));
            }
        }
        if failed {
            session.entry.kind = "video".into();
        }
        save_entry(app, session.entry.clone())?;
        if failed {
            return Err(format!("录制进程异常结束，已保留可恢复视频：{error}"));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&session.log);
    *state.busy.lock().map_err(err)? = false;
    let _ = app.emit_to("main", "processing", false);
    let _ = app.emit_to("main", "recording-finished", ());
    if result.is_ok() {
        show_notice(app, "录制已保存，可从托盘菜单打开截图与视频记录");
    }
    result
}
pub fn toggle_internal(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<State>();
    let mut guard = state.recording.lock().map_err(err)?;
    let r = guard.as_mut().ok_or("尚未开始录制")?;
    r.drawing = !r.drawing;
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_ignore_cursor_events(!r.drawing).map_err(err)?;
        w.emit("drawing-mode", r.drawing).map_err(err)?;
    }
    app.emit_to("controls", "drawing-mode", r.drawing)
        .map_err(err)?;
    Ok(r.drawing)
}
#[tauri::command]
pub fn toggle_drawing(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool, String> {
    if window.label() != "controls" {
        return Err("无效窗口".into());
    }
    toggle_internal(&app)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn software_encoder_is_always_available_in_minimal_build() {
        assert_eq!(encoding_args(false)[1], "mpeg4");
    }
    #[test]
    fn invalid_recording_without_rect_is_rejected() {
        let s = Selection {
            mode: "video".into(),
            monitor_id: 0,
            monitor_index: 0,
            image: String::new(),
            width: 1920,
            height: 1080,
            scale: 1.0,
            origin_x: 0,
            origin_y: 0,
            rect: None,
        };
        assert!(input_args(&s, 30).is_err());
    }
}

#[tauri::command]
pub fn recording_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
) -> Result<Settings, String> {
    if window.label() != "controls" {
        return Err("无效窗口".into());
    }
    Ok(state.settings.lock().map_err(err)?.clone())
}
#[tauri::command]
pub fn cancel_recording(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "controls" {
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
