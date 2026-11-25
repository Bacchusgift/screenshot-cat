//! Clipboard shelf never sends paste to an unverified foreground target.
#[cfg(target_os = "macos")]
pub fn current() -> i64 {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|a| a.processIdentifier() as i64)
        .filter(|pid| *pid != std::process::id() as i64)
        .unwrap_or(0)
}
#[cfg(target_os = "macos")]
pub fn can_paste() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightPostEventAccess() -> bool;
    }
    unsafe { CGPreflightPostEventAccess() }
}
#[cfg(target_os = "macos")]
pub fn restore(target: i64, marker: objc2_foundation::MainThreadMarker) -> Result<(), String> {
    use objc2::runtime::NSObjectProtocol;
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSRunningApplication};
    if current() == target && target > 0 {
        return Ok(());
    }
    let target_app = NSRunningApplication::runningApplicationWithProcessIdentifier(target as i32)
        .ok_or("已复制，原窗口已关闭")?;
    let app = NSApplication::sharedApplication(marker);
    if app.isActive() {
        if app.respondsToSelector(objc2::sel!(yieldActivationToApplication:)) {
            app.yieldActivationToApplication(&target_app);
            if target_app.activateFromApplication_options(
                &NSRunningApplication::currentApplication(),
                NSApplicationActivationOptions::empty(),
            ) {
                return Ok(());
            }
        }
    } else if current() != 0 {
        return Err("已复制；前台应用已切换，请在目标窗口按 ⌘V".into());
    }
    #[allow(deprecated)]
    target_app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
    Ok(())
}
#[cfg(target_os = "macos")]
pub fn wait_until_active(target: i64) -> Result<(), String> {
    if target > 0 {
        for _ in 0..50 {
            if current() == target {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    Err("已复制；请切换回原窗口后按 ⌘V".into())
}
#[cfg(target_os = "macos")]
pub fn paste(target: i64) -> Result<(), String> {
    use core_graphics::{
        event::{CGEvent, CGEventFlags, CGEventTapLocation},
        event_source::{CGEventSource, CGEventSourceStateID},
    };
    if target <= 0 || current() != target {
        return Err("已复制；请切换回原窗口后按 ⌘V".into());
    }
    let source =
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "无法创建粘贴事件")?;
    let cmd_down =
        CGEvent::new_keyboard_event(source.clone(), 55, true).map_err(|_| "无法创建粘贴事件")?;
    cmd_down.set_flags(CGEventFlags::CGEventFlagCommand);
    let v_down =
        CGEvent::new_keyboard_event(source.clone(), 9, true).map_err(|_| "无法创建粘贴事件")?;
    v_down.set_flags(CGEventFlags::CGEventFlagCommand);
    let v_up =
        CGEvent::new_keyboard_event(source.clone(), 9, false).map_err(|_| "无法创建粘贴事件")?;
    v_up.set_flags(CGEventFlags::CGEventFlagCommand);
    let cmd_up = CGEvent::new_keyboard_event(source, 55, false).map_err(|_| "无法创建粘贴事件")?;
    cmd_up.set_flags(CGEventFlags::CGEventFlagNull);
    cmd_down.post(CGEventTapLocation::HID);
    std::thread::sleep(std::time::Duration::from_millis(12));
    v_down.post(CGEventTapLocation::HID);
    std::thread::sleep(std::time::Duration::from_millis(12));
    v_up.post(CGEventTapLocation::HID);
    std::thread::sleep(std::time::Duration::from_millis(12));
    cmd_up.post(CGEventTapLocation::HID);
    Ok(())
}
#[cfg(target_os = "windows")]
pub fn current() -> i64 {
    unsafe {
        let window = windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow();
        let mut pid = 0;
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(window, &mut pid);
        if pid == std::process::id() {
            0
        } else {
            window as i64
        }
    }
}
#[cfg(target_os = "windows")]
pub fn paste(target: i64) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::SetForegroundWindow},
    };
    if target == 0 {
        return Err("已复制，请按 Ctrl+V 粘贴".into());
    }
    unsafe {
        SetForegroundWindow(target as HWND);
    }
    for _ in 0..30 {
        if current() == target {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if current() != target {
        return Err("已复制，请切换回原窗口后按 Ctrl+V".into());
    }
    let mut inputs: Vec<INPUT> = Vec::new();
    for (key, up) in [
        (VK_CONTROL, false),
        (0x56, false),
        (0x56, true),
        (VK_CONTROL, true),
    ] {
        let mut input: INPUT = unsafe { std::mem::zeroed() };
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT {
            wVk: key,
            wScan: 0,
            dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
            time: 0,
            dwExtraInfo: 0,
        };
        inputs.push(input);
    }
    if unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    } != 4
    {
        return Err("已复制；当前窗口不允许自动粘贴，请按 Ctrl+V".into());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
pub fn current() -> i64 {
    use x11rb::protocol::xproto::ConnectionExt;
    x11rb::connect(None)
        .ok()
        .and_then(|(c, _)| c.get_input_focus().ok()?.reply().ok())
        .map(|r| r.focus as i64)
        .unwrap_or(0)
}
#[cfg(target_os = "linux")]
pub fn paste(target: i64) -> Result<(), String> {
    use x11rb::{
        connection::Connection,
        protocol::{
            xproto::{ConnectionExt, InputFocus, KEY_PRESS_EVENT, KEY_RELEASE_EVENT},
            xtest::ConnectionExt as _,
        },
    };
    if target <= 1 || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
        return Err("已复制；请切换回原窗口后按 Ctrl+V（Wayland 不支持自动粘贴）".into());
    }
    let (c, _) = x11rb::connect(None).map_err(|e| e.to_string())?;
    c.set_input_focus(InputFocus::PARENT, target as u32, x11rb::CURRENT_TIME)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    if c.get_input_focus()
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .focus
        != target as u32
    {
        return Err("已复制；无法恢复原窗口，请按 Ctrl+V".into());
    }
    let setup = c.setup();
    let min = setup.min_keycode;
    let map = c
        .get_keyboard_mapping(min, setup.max_keycode - min + 1)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    let key = |sym| {
        map.keysyms
            .chunks(map.keysyms_per_keycode as usize)
            .position(|s| s.contains(&sym))
            .map(|i| min + i as u8)
            .ok_or("无法定位粘贴按键")
    };
    let ctrl = key(0xffe3)?;
    let v = key(0x76)?;
    for (event, k) in [
        (KEY_PRESS_EVENT, ctrl),
        (KEY_PRESS_EVENT, v),
        (KEY_RELEASE_EVENT, v),
        (KEY_RELEASE_EVENT, ctrl),
    ] {
        c.xtest_fake_input(event, k, x11rb::CURRENT_TIME, x11rb::NONE, 0, 0, 0)
            .map_err(|e| e.to_string())?;
    }
    c.flush().map_err(|e| e.to_string())?;
    Ok(())
}
