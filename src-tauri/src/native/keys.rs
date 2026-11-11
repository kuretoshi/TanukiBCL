use super::Backend;
use std::{
    cell::RefCell,
    collections::HashSet,
    sync::{atomic::Ordering, Arc},
};
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::*,
};

fn key(name: &str) -> Option<i32> {
    if name.len() == 1 {
        let c = name.as_bytes()[0].to_ascii_uppercase();
        if c.is_ascii_alphanumeric() {
            return Some(c as i32);
        }
    }
    if let Some(number) = name
        .strip_prefix('F')
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        return Some(0x70 + number - 1);
    }
    if let Some(number) = name
        .strip_prefix("Numpad")
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|n| (0..=9).contains(n))
    {
        return Some(0x60 + number);
    }
    Some(match name {
        "Space" => 0x20,
        "Backspace" => 8,
        "Delete" => 0x2e,
        "Enter" => 0x0d,
        "Up" => 0x26,
        "Down" => 0x28,
        "Left" => 0x25,
        "Right" => 0x27,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "Escape" => 0x1b,
        "Control" => 0x11,
        "LControl" => 0xa2,
        "RControl" => 0xa3,
        "Shift" => 0x10,
        "LShift" => 0xa0,
        "RShift" => 0xa1,
        "Alt" => 0x12,
        "LAlt" => 0xa4,
        "RAlt" => 0xa5,
        "Tab" => 9,
        "CapsLock" => 0x14,
        "Insert" => 0x2d,
        "Mouse0" => 1,
        "Mouse1" => 2,
        "Mouse2" => 4,
        "Mouse3" => 5,
        "Mouse4" => 6,
        "MouseButton4" => 5,
        "MouseButton5" => 6,
        _ => return None,
    })
}

#[derive(Default)]
struct Held {
    down: HashSet<i32>,
    ptt: bool,
    radio: bool,
    jackal: bool,
}
fn matches(config: i32, actual: i32) -> bool {
    config == actual
        || matches!(
            (config, actual),
            (0x11, 0xa2 | 0xa3) | (0x10, 0xa0 | 0xa1) | (0x12, 0xa4 | 0xa5)
        )
}
impl Held {
    #[cfg(test)]
    fn event(
        &mut self,
        shortcuts: &[String],
        radio_available: bool,
        code: i32,
        down: bool,
    ) -> Vec<(&'static str, Vec<serde_json::Value>)> {
        self.channels(shortcuts, radio_available, false, code, down)
    }
    fn channels(
        &mut self,
        shortcuts: &[String],
        radio_available: bool,
        jackal_available: bool,
        code: i32,
        down: bool,
    ) -> Vec<(&'static str, Vec<serde_json::Value>)> {
        let keys: Vec<_> = shortcuts.iter().map(|s| key(s)).collect();
        let selected = keys.iter().flatten().any(|key| matches(*key, code));
        let was_down = self.down.contains(&code);
        if down && selected {
            self.down.insert(code);
        } else if !down {
            self.down.remove(&code);
        }
        let pressed = |index: usize| {
            keys[index].is_some_and(|key| self.down.iter().any(|code| matches(key, *code)))
        };
        let mut events = Vec::new();
        if !down && was_down {
            if keys[1].is_some_and(|key| matches(key, code)) {
                events.push(("TOGGLE_DEAFEN", vec![]));
            }
            if keys[2].is_some_and(|key| matches(key, code)) {
                events.push(("TOGGLE_MUTE", vec![]));
            }
        }
        let radio = pressed(3) && radio_available;
        if radio != self.radio {
            events.push(("IMPOSTOR_RADIO", vec![serde_json::json!(radio)]));
            self.radio = radio;
        }
        let jackal = pressed(4) && jackal_available;
        if jackal != self.jackal {
            events.push(("JACKAL_RADIO", vec![serde_json::json!(jackal)]));
            self.jackal = jackal;
        }
        let ptt = pressed(0) || radio || jackal;
        if ptt != self.ptt {
            events.push(("PUSH_TO_TALK", vec![serde_json::json!(ptt)]));
            self.ptt = ptt;
        }
        events
    }
}
struct Context {
    backend: Arc<Backend>,
    held: Held,
}
thread_local! {static CONTEXT:RefCell<Option<Context>>=const{RefCell::new(None)};}
fn dispatch(code: i32, down: bool) {
    if std::env::var_os("TANUKI_RUST_TRACE").is_some()
        && matches!(code,0x10..=0x12|0xa0..=0xa5|0x77)
    {
        eprintln!("rust modifier code={code} down={down}");
    }
    CONTEXT.with(|cell| {
        let mut context = cell.borrow_mut();
        let Some(context) = context.as_mut() else {
            return;
        };
        if !context.backend.hooked.load(Ordering::Relaxed) {
            return;
        }
        let shortcuts = context.backend.shortcuts.lock().unwrap().clone();
        let (available, jackal_available) = {
            let state = context.backend.state.lock().unwrap();
            let me = state["players"].as_array().and_then(|ps| {
                ps.iter()
                    .find(|p| p["isLocal"] == true && p["isDead"] != true)
            });
            let alive = matches!(state["gameState"].as_i64(), Some(1 | 2)) && me.is_some();
            let nos = state["mod"] == "NoS";
            (
                alive
                    && (nos
                        || me.is_some_and(|p| {
                            p["isImpostor"] == true
                                || (state["mod"] == "SUPER_NEW_ROLES"
                                    && crate::voice::jackal_radio_player(p))
                        })),
                alive && nos,
            )
        };
        for (channel, args) in
            context
                .held
                .channels(&shortcuts, available, jackal_available, code, down)
        {
            context.backend.emit("main", channel, args);
        }
    });
}
unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0
        && matches!(
            message as u32,
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP
        )
    {
        let event = &*(data as *const KBDLLHOOKSTRUCT);
        dispatch(
            event.vkCode as i32,
            matches!(message as u32, WM_KEYDOWN | WM_SYSKEYDOWN),
        );
    }
    CallNextHookEx(std::ptr::null_mut(), code, message, data)
}
unsafe extern "system" fn mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && matches!(message as u32, WM_XBUTTONDOWN | WM_XBUTTONUP) {
        let event = &*(data as *const MSLLHOOKSTRUCT);
        let button = (event.mouseData >> 16) & 0xffff;
        if button == 1 || button == 2 {
            dispatch(
                if button == 1 { 5 } else { 6 },
                message as u32 == WM_XBUTTONDOWN,
            );
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, message, data)
}
pub fn start(backend: Arc<Backend>) {
    std::thread::spawn(move || unsafe {
        let mut message: MSG = std::mem::zeroed();
        // Establish this thread's queue before publishing the ID used by stop.
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        backend
            .key_thread
            .store(GetCurrentThreadId(), Ordering::SeqCst);
        CONTEXT.with(|context| {
            *context.borrow_mut() = Some(Context {
                backend: backend.clone(),
                held: Held::default(),
            })
        });
        let module = GetModuleHandleW(std::ptr::null());
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), module, 0);
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), module, 0);
        if keyboard.is_null() || mouse.is_null() {
            backend.emit(
                "main",
                "ERROR",
                vec![serde_json::json!(
                    "ショートカットの監視を開始できませんでした。Tauri版を再起動してください。"
                )],
            );
        }
        while backend.running.load(Ordering::Relaxed)
            && GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if !keyboard.is_null() {
            UnhookWindowsHookEx(keyboard);
        }
        if !mouse.is_null() {
            UnhookWindowsHookEx(mouse);
        }
        backend.key_thread.store(0, Ordering::SeqCst);
        CONTEXT.with(|context| *context.borrow_mut() = None);
    });
}
pub fn stop(backend: &Backend) {
    let id = backend.key_thread.load(Ordering::SeqCst);
    if id != 0 {
        unsafe {
            PostThreadMessageW(id, WM_QUIT, 0, 0);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_cover_default_shortcuts_without_confusing_left_with_home() {
        assert_eq!(key("V"), Some(0x56));
        assert_eq!(key("RAlt"), Some(0xa5));
        assert_eq!(key("RControl"), Some(0xa3));
        assert_eq!(key("Left"), Some(0x25));
        assert_eq!(key("F24"), Some(0x87));
        assert_eq!(key("unknown"), None);
    }
    #[test]
    fn short_presses_repeat_and_overlapping_push_to_talk_do_not_lose_release() {
        let shortcuts = ["V", "RControl", "RAlt", "F", "G"].map(str::to_owned);
        let mut held = Held::default();
        assert!(held.event(&shortcuts, false, 0xa5, true).is_empty());
        assert!(held.event(&shortcuts, false, 0xa5, true).is_empty());
        assert_eq!(
            held.event(&shortcuts, false, 0xa5, false)[0].0,
            "TOGGLE_MUTE"
        );
        assert!(held.event(&shortcuts, false, 0xa5, false).is_empty());
        assert_eq!(
            held.event(&shortcuts, true, 0x56, true)[0],
            ("PUSH_TO_TALK", vec![serde_json::json!(true)])
        );
        assert_eq!(
            held.event(&shortcuts, true, 0x46, true)[0].0,
            "IMPOSTOR_RADIO"
        );
        assert!(held.event(&shortcuts, true, 0x56, false).is_empty());
        let released = held.event(&shortcuts, true, 0x46, false);
        assert_eq!(
            released[1],
            ("PUSH_TO_TALK", vec![serde_json::json!(false)])
        );
        assert!(held.down.is_empty());
    }
}
