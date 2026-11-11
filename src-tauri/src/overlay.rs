use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;

/// A transparent, click-through window follows the game only while it is active.
/// Exclusive fullscreen is deliberately not hooked by this beta.
pub fn start(app: AppHandle, enabled: Arc<AtomicBool>) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        use tauri::Manager;
        use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
        let title: Vec<u16> = std::env::var("BETTERCREWLINK_TARGET_NAME")
            .unwrap_or_else(|_| "Among Us".into())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if !enabled.load(Ordering::Relaxed) {
                continue;
            }
            let Some(overlay) = app.get_webview_window("overlay") else {
                continue;
            };
            unsafe {
                let game = FindWindowW(std::ptr::null(), title.as_ptr());
                if game.is_null() || IsIconic(game) != 0 || GetForegroundWindow() != game {
                    let _ = overlay.hide();
                    continue;
                }
                let mut bounds: RECT = std::mem::zeroed();
                if GetWindowRect(game, &mut bounds) == 0 {
                    continue;
                }
                let width = bounds.right - bounds.left;
                let height = bounds.bottom - bounds.top;
                if width > 0 && height > 0 {
                    let _ =
                        overlay.set_position(tauri::PhysicalPosition::new(bounds.left, bounds.top));
                    let _ = overlay.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
                    let _ = overlay.show();
                }
            }
        }
    });
    #[cfg(not(windows))]
    let _ = (app, enabled);
}
