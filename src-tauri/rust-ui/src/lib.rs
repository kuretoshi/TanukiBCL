//! Application UI is implemented in Rust. wasm-bindgen's generated JavaScript
//! and Tauri's official global API are interoperability glue only.
use events::App;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    rc::{Rc, Weak},
};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
mod avatar;
mod chrome;
mod events;
mod overlay;
#[cfg(test)]
mod parity_tests;
mod settings;
mod state;
mod transport;
mod views;
thread_local! {static ACTIVE:RefCell<Option<Weak<RefCell<state::State>>>>=const{RefCell::new(None)};}

pub fn show_error(message: &str) {
    ACTIVE.with(|active| {
        if let Some(app) = active.borrow().as_ref().and_then(Weak::upgrade) {
            if let Ok(mut state) = app.try_borrow_mut() {
                state.error = message.chars().take(8192).collect();
            }
        }
    });
    web_sys::console::error_1(&JsValue::from_str(message));
    let report = message.chars().take(8192).collect::<String>();
    wasm_bindgen_futures::spawn_local(async move {
        let _ = transport::invoke("frontend_log", json!({"message":report})).await;
    });
    if let Some(document) = web_sys::window().and_then(|w| w.document()) {
        if let Some(element) = document.get_element_by_id("status-message") {
            element.set_text_content(Some(message));
        }
    }
}

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    std::panic::set_hook(Box::new(|info| show_error(&format!("Rust UI: {info}"))));
    let document = web_sys::window()
        .ok_or("Window unavailable")?
        .document()
        .ok_or("Document unavailable")?;
    let style = document.create_element("style")?;
    style.set_text_content(Some(concat!(
        include_str!("../assets/fonts.css"),
        include_str!("../assets/app.css")
    )));
    document
        .document_element()
        .ok_or("Document root missing")?
        .append_child(&style)?;
    let state = Rc::new(RefCell::new(state::State::new()));
    ACTIVE.with(|active| *active.borrow_mut() = Some(Rc::downgrade(&state)));
    if state.borrow().view == "overlay" {
        let style = document.create_element("style")?;
        style.set_text_content(Some(include_str!("../../../src/renderer/css/overlay.css")));
        document.document_element().unwrap().append_child(&style)?;
    }
    events::bind_all(state.clone())?;
    render(&state, true);
    transport::dispatch(async move {
        let observed = state.clone();
        transport::listen(move |frame| {
            let mut state = observed.borrow_mut();
            let args = &frame["args"];
            match frame["channel"].as_str().unwrap_or("") {
                "NOTIFY_GAME_STATE_CHANGED" | "SETTINGS_NOTIFY_GAME_STATE_CHANGED" => {
                    state.game = args[0].clone();
                    if state.game.is_object() {
                        state.error.clear();
                    }
                }
                "NOTIFY_GAME_OPENED" if args[0] == false => state.game = Value::Null,
                "NOTIFY_PLAYERCOLORS_CHANGED" | "SETTINGS_NOTIFY_PLAYER_COLORS_CHANGED" => {
                    state.context["playerColors"] = args[0].clone()
                }
                "settings:changed" => {
                    state.settings = args[0].clone();
                    state.merge_preferences();
                }
                "ERROR" => state.error = state::text(&args[0]),
                "AUTO_UPDATER_STATE" => state.updater = args[0].clone(),
                "LOBBY_BROWSER_CHANGED" => state.result["lobbyBrowser"] = args[0].clone(),
                _ => {}
            }
            drop(state);
            render(&observed, false);
        })
        .await?;
        let settings = transport::ipc("settings:get", vec![]).await?;
        state.borrow_mut().settings = settings;
        let custom_platforms = state.borrow().settings["customPlatforms"].clone();
        let platforms =
            transport::ipc("REQUEST_PLATFORMS_AVAILABLE", vec![custom_platforms]).await?;
        state.borrow_mut().result["platforms"] = platforms;
        let updater = transport::ipc("updater:get-state", vec![]).await?;
        state.borrow_mut().updater = updater;
        let game = transport::ipc("GET_INITIAL_STATE", vec![]).await?;
        state.borrow_mut().game = game;
        let context = transport::ipc("native:context", vec![]).await?;
        state.borrow_mut().context = context;
        let devices = transport::native("devices", Value::Null).await?;
        state.borrow_mut().devices = devices;
        let voice = transport::native("status", Value::Null).await?;
        {
            let mut state = state.borrow_mut();
            state.voice = voice;
            state.merge_preferences();
        }
        transport::ipc("START_HOOK", vec![]).await?;
        render(&state, true);
        if state.borrow().view == "lobbies" {
            let result = transport::native("lobby-browser", json!({"action":"list"})).await?;
            state.borrow_mut().result["lobbyBrowser"] = result;
        }
        loop {
            let delay = if state.borrow().view == "app" || state.borrow().view == "overlay" {
                200
            } else {
                1000
            };
            wait(delay).await?;
            match transport::native("status", Value::Null).await {
                Ok(voice) => {
                    let mut state = state.borrow_mut();
                    state.voice = voice;
                    state.merge_preferences();
                }
                Err(error) => state.borrow_mut().error = error,
            }
            if state.borrow().view == "debug"
                && (state.borrow().form["debugTab"] == "logs"
                    || state.borrow().form["debugSections"]["logs"] == true)
            {
                if let Ok(logs) = transport::ipc("debug:get-logs", vec![]).await {
                    state.borrow_mut().result["logs"] = logs;
                }
            }
            render(&state, false);
        }
    });
    Ok(())
}
async fn wait(ms: i32) -> Result<(), String> {
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        if let Err(error) = web_sys::window()
            .unwrap()
            .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms)
        {
            let _ = reject.call1(&JsValue::NULL, &error);
        }
    });
    wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(transport::error)?;
    Ok(())
}
pub fn render(app: &App, force: bool) {
    refresh_catalog(app);
    let Some(document) = web_sys::window().and_then(|w| w.document()) else {
        return;
    };
    let mut state = app.borrow_mut();
    overlay::reconcile(&mut state);
    if let Some(window) = web_sys::window() {
        state.viewport = [
            window
                .inner_width()
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(280.0),
            window
                .inner_height()
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(390.0),
        ];
    }
    let settings_signature = if state.view == "settings" {
        json!({"settings":state.settings,"host":state.effective_game()["isHost"],"phase":state.effective_game()["gameState"],"catalog":state.snapshot()["tohRoleCatalog"],"activeRules":state.snapshot()["activeLobbySettings"],"players":if state.category=="players"{state.effective_game()["players"].clone()}else{Value::Null},"notice":state.notice()}).to_string()
    } else {
        String::new()
    };
    if !force && state.view == "settings" && settings_signature == state.settings_signature {
        if let Some(meter) = document
            .get_element_by_id("microphone-meter")
            .and_then(|m| m.first_element_child())
        {
            let _ = meter.set_attribute(
                "style",
                &format!("width:{}%", settings::microphone_meter_level(&state)),
            );
        }
        if let Some(status) = document.get_element_by_id("updater-status") {
            status.set_text_content(Some(&state::text(&state.updater["message"])));
        }
        for (id, enabled) in [
            ("download-update", state.updater["state"] == "available"),
            ("install-update", state.updater["state"] == "downloaded"),
        ] {
            if let Ok(Some(button)) = document.query_selector(&format!("[data-action={id}]")) {
                if enabled {
                    let _ = button.remove_attribute("disabled");
                } else {
                    let _ = button.set_attribute("disabled", "");
                }
            }
        }
        return;
    }
    if !force
        && state.view != "settings"
        && document
            .active_element()
            .is_some_and(|e| e.dyn_ref::<web_sys::HtmlInputElement>().is_some())
    {
        return;
    }
    let header = chrome::header(&state);
    let html = format!(
        "{header}<div id=view-body>{}{}</div>",
        views::body(&state),
        if state.view == "app" {
            settings::dialogs(&state)
        } else {
            String::new()
        }
    );
    if force || html != state.rendered {
        let focused = document.active_element().map(|element| {
            let input = element.dyn_ref::<web_sys::HtmlInputElement>();
            let area = element.dyn_ref::<web_sys::HtmlTextAreaElement>();
            let selection = input
                .and_then(|e| {
                    e.selection_start()
                        .ok()
                        .flatten()
                        .zip(e.selection_end().ok().flatten())
                })
                .or_else(|| {
                    area.and_then(|e| {
                        e.selection_start()
                            .ok()
                            .flatten()
                            .zip(e.selection_end().ok().flatten())
                    })
                });
            let draft = input
                .filter(|input| input.type_() == "text" && element.has_attribute("data-setting"))
                .map(|input| input.value());
            (
                element.id(),
                element.get_attribute("data-form"),
                selection,
                draft,
            )
        });
        let scroll = document
            .get_element_by_id("settings-content")
            .and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok())
            .map(|e| e.scroll_top());
        if let Some(root) = document.get_element_by_id("app") {
            root.set_inner_html(&html);
        }
        if let Some((id, form, selection, draft)) = focused {
            let element = if !id.is_empty() {
                document.get_element_by_id(&id)
            } else {
                form.filter(|s| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
                    .and_then(|key| {
                        document
                            .query_selector(&format!("[data-form={key}]"))
                            .ok()
                            .flatten()
                    })
            };
            if let Some(element) = element {
                if let (Some(draft), Some(input)) =
                    (draft, element.dyn_ref::<web_sys::HtmlInputElement>())
                {
                    input.set_value(&draft);
                }
                if let Some(element) = element.dyn_ref::<web_sys::HtmlElement>() {
                    let _ = element.focus();
                }
                if let Some((start, end)) = selection {
                    if let Some(input) = element.dyn_ref::<web_sys::HtmlInputElement>() {
                        let _ = input.set_selection_range(start, end);
                    } else if let Some(area) = element.dyn_ref::<web_sys::HtmlTextAreaElement>() {
                        let _ = area.set_selection_range(start, end);
                    }
                }
            }
        }
        if let Some(scroll) = scroll {
            if let Some(element) = document
                .get_element_by_id("settings-content")
                .and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok())
            {
                element.set_scroll_top(scroll);
            }
        }
        state.rendered = html;
    }
    state.settings_signature = settings_signature;
    if state.view == "app" {
        if let Some(grid) = document.get_element_by_id("other-players-grid") {
            let size = [grid.client_width() as f64, grid.client_height() as f64];
            if state.grid_size != Some(size) {
                state.grid_size = Some(size);
            }
        } else {
            state.grid_size = None;
        }
    }
}
fn refresh_catalog(app: &App) {
    let mode = {
        let mut state = app.borrow_mut();
        if !state.effective_game()["players"].is_array() || state.catalog_loading {
            return;
        }
        let mode = state.effective_game()["mod"]
            .as_str()
            .unwrap_or("NONE")
            .to_owned();
        if !state.needs_catalog(&mode, js_sys::Date::now()) {
            return;
        }
        state.catalog_loading = true;
        state.catalog_mode = mode.clone();
        mode
    };
    let app = app.clone();
    transport::dispatch(async move {
        let result = transport::ipc("native:cosmetics-catalog", vec![]).await;
        {
            let mut state = app.borrow_mut();
            state.finish_catalog(&mode, result, js_sys::Date::now());
        }
        render(&app, true);
        Ok(())
    });
}
