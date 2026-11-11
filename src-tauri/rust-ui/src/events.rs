use crate::{
    settings,
    state::{assign, text, State, PREFERENCES},
    transport as t,
};
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{
    Element, Event, HtmlInputElement, HtmlSelectElement, HtmlTextAreaElement, KeyboardEvent,
    MouseEvent,
};
pub type App = Rc<RefCell<State>>;
fn value(element: &Element) -> Value {
    if let Some(input) = element.dyn_ref::<HtmlInputElement>() {
        if input.type_() == "checkbox" {
            return json!(input.checked());
        }
        if ["range", "number"].contains(&input.type_().as_str()) {
            return json!(input.value_as_number());
        }
        return json!(input.value());
    }
    if let Some(input) = element.dyn_ref::<HtmlSelectElement>() {
        return json!(input.value());
    }
    if let Some(input) = element.dyn_ref::<HtmlTextAreaElement>() {
        return json!(input.value());
    }
    Value::Null
}
pub async fn set_setting(app: App, key: String, mut value: Value) -> Result<(), String> {
    let mut key = key;
    if let Some(name) = key.strip_prefix("myLobbySettings.tohGhostRoles.") {
        let next = {
            let state = app.borrow();
            crate::state::toh_ghost_roles(
                &state.settings["myLobbySettings"],
                &state.snapshot()["tohRoleCatalog"],
                name,
                false,
                value == true,
            )?
        };
        key = "myLobbySettings.tohGhostRoles".into();
        value = next;
    }
    if key == "serverURL" {
        value = json!(crate::state::server_url(
            value
                .as_str()
                .ok_or("通話サーバーのURLを入力してください")?
        )?);
    }
    if key == "obsOverlay"
        && value == true
        && app.borrow().settings["obsSecret"]
            .as_str()
            .is_none_or(|s| s.is_empty())
    {
        let secret = t::ipc("native:new-obs-secret", vec![]).await?;
        t::ipc(
            "settings:set",
            vec![json!("obsSecret"), secret.clone(), json!(true)],
        )
        .await?;
        app.borrow_mut().settings["obsSecret"] = secret;
    }
    if key == "hideCode" {
        value = json!(value != true);
    }
    if key == "micSensitivity" {
        value = json!(
            1.0 - value
                .as_f64()
                .ok_or("Numeric microphone sensitivity required")?
        );
    }
    if key == "pushToTalkMode" {
        value = json!(text(&value)
            .parse::<u8>()
            .map_err(|_| "Invalid voice mode")?);
    }
    let (key, value, prefs) = {
        let mut state = app.borrow_mut();
        if state.host_in_match() && key.starts_with("myLobbySettings.") {
            return Err(state.t("settings.lobbysettings.inlobbyonly"));
        }
        let mut effective_key = key.clone();
        let mut effective_value = value.clone();
        if key == "myLobbySettings.impostorRadioOnlyMode" {
            let forced = json!({"impostorRadioEnabled":true,"meetingGhostOnly":true,"deadOnly":false,"wallsBlockAudio":false,"visionHearing":false,"voiceEffectEnabled":false,"hearImpostorsInVents":false,"impostersHearImpostersInvent":false,"commsSabotage":false,"hearThroughCameras":false,"snrJumboVoice":false,"snrPushReverb":true,"jackalHearOutsideVents":false,"jackalTalkInVents":false,"jackalRadioEnabled":false,"sidekickHearOutsideVents":false,"sidekickTalkInVents":false,"nosVoicePositions":true});
            let mut lobby = state.settings["myLobbySettings"].clone();
            if value == true {
                let mut backup = json!({});
                for (key, forced_value) in forced.as_object().unwrap() {
                    backup[key] = lobby[key].clone();
                    lobby[key] = forced_value.clone();
                }
                if let Ok(Some(storage)) = web_sys::window().unwrap().local_storage() {
                    let _ =
                        storage.set_item("tanukibcl.impostorRadioOnlyBackup", &backup.to_string());
                }
            } else if let Ok(Some(storage)) = web_sys::window().unwrap().local_storage() {
                if let Ok(Some(backup)) = storage.get_item("tanukibcl.impostorRadioOnlyBackup") {
                    if let Ok(Value::Object(backup)) = serde_json::from_str::<Value>(&backup) {
                        for (key, value) in backup {
                            if forced.get(&key).is_some() {
                                lobby[&key] = value;
                            }
                        }
                    }
                }
                let _ = storage.remove_item("tanukibcl.impostorRadioOnlyBackup");
            }
            lobby["nosVoicePositions"] = json!(true);
            lobby["impostorRadioOnlyMode"] = value.clone();
            effective_key = "myLobbySettings".into();
            effective_value = lobby;
        } else if value == true
            && [
                "myLobbySettings.deadOnly",
                "myLobbySettings.meetingGhostOnly",
                "myLobbySettings.nosFixerJammingVoiceBlock",
                "myLobbySettings.nosFixerJammingLowpass",
            ]
            .contains(&key.as_str())
        {
            let other = match key.as_str() {
                "myLobbySettings.deadOnly" => "meetingGhostOnly",
                "myLobbySettings.meetingGhostOnly" => "deadOnly",
                "myLobbySettings.nosFixerJammingVoiceBlock" => "nosFixerJammingLowpass",
                _ => "nosFixerJammingVoiceBlock",
            };
            let mut lobby = state.settings["myLobbySettings"].clone();
            lobby[other] = json!(false);
            lobby[key.rsplit('.').next().unwrap()] = json!(true);
            effective_key = "myLobbySettings".into();
            effective_value = lobby;
        }
        assign(&mut state.settings, &effective_key, effective_value.clone())?;
        let mut prefs = state.voice["preferences"].clone();
        let mut update = false;
        for (setting, pref, scale) in PREFERENCES {
            if setting == key {
                prefs[pref] = if scale != 1.0 {
                    json!(value.as_f64().ok_or("Numeric voice setting required")? / scale)
                } else if ["microphone", "speaker"].contains(&setting)
                    && ["Default", "default"].contains(&value.as_str().unwrap_or(""))
                {
                    json!("")
                } else {
                    value.clone()
                };
                update = true;
            }
        }
        (effective_key, effective_value, update.then_some(prefs))
    };
    t::ipc("settings:set", vec![json!(key), value.clone(), json!(true)]).await?;
    if let Some(prefs) = prefs {
        let voice = t::native("configure", prefs).await?;
        app.borrow_mut().voice = voice;
    }
    match key.as_str() {
        "alwaysOnTop" => {
            t::ipc("setAlwaysOnTop", vec![value]).await?;
        }
        "enableOverlay" => {
            t::ipc("enableOverlay", vec![value]).await?;
        }
        "serverURL" => {
            let mut servers = app.borrow().settings["serverURLs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if !servers.contains(&value) {
                servers.push(value);
                t::ipc(
                    "settings:set",
                    vec![json!("serverURLs"), json!(servers), json!(true)],
                )
                .await?;
            }
        }
        "customPlatforms" => {
            let platforms = t::ipc("REQUEST_PLATFORMS_AVAILABLE", vec![value]).await?;
            app.borrow_mut().result["platforms"] = platforms;
        }
        _ => {}
    }
    if key == "myLobbySettings" {
        crate::render(&app, true);
    }
    Ok(())
}
async fn native_command(app: App, action: &str, value: Value) -> Result<(), String> {
    let response = t::native(action, value).await?;
    if response.is_object() {
        app.borrow_mut().voice = response;
    }
    crate::render(&app, false);
    Ok(())
}
pub async fn action(
    app: App,
    name: String,
    argument: String,
    element: Element,
) -> Result<(), String> {
    match name.as_str() {
        "toggle-support" | "toggle-launch" => {
            let key = if name == "toggle-support" {
                "supportMenu"
            } else {
                "launchMenu"
            };
            let active = app.borrow().form[key] != true;
            app.borrow_mut().form[key] = json!(active);
            crate::render(&app, true);
        }
        "select-launch" => {
            set_setting(app.clone(), "launchPlatform".into(), json!(argument)).await?;
            app.borrow_mut().form["launchMenu"] = json!(false);
            crate::render(&app, true);
        }
        "new-platform" => {
            {
                let mut state = app.borrow_mut();
                state.form["launchMenu"] = json!(false);
                state.form["platformDialog"] = json!(true);
                for key in [
                    "platformName",
                    "platformPath",
                    "platformArgs",
                    "platformEdit",
                ] {
                    state.form[key] = json!("");
                }
                state.form["platformType"] = json!("EXE");
                state.form["platformAdvanced"] = json!(false);
            }
            crate::render(&app, true);
        }
        "lobby-tab" => {
            app.borrow_mut().form["lobbyTab"] = json!(argument);
            crate::render(&app, true);
        }
        "toh-roles" => {
            let active = app.borrow().form["tohRolesOpen"] != true;
            app.borrow_mut().form["tohRolesOpen"] = json!(active);
            crate::render(&app, true);
        }
        "debug-dialog" | "edit-server" => {
            let key = if name == "debug-dialog" {
                "debugDialog"
            } else {
                "serverDialog"
            };
            app.borrow_mut().form[key] = json!(true);
            crate::render(&app, true);
        }
        "close-dialog" => {
            for key in ["debugDialog", "serverDialog", "platformDialog"] {
                app.borrow_mut().form[key] = json!(false);
            }
            crate::render(&app, true);
        }
        "save-server" => {
            let url = app.borrow().form["serverURL"].clone();
            let mut servers = app.borrow().settings["serverURLs"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let url = json!(crate::state::server_url(url.as_str().unwrap_or(""))?);
            if !servers.contains(&url) {
                servers.push(url.clone());
            }
            set_setting(app.clone(), "serverURLs".into(), json!(servers)).await?;
            set_setting(app.clone(), "serverURL".into(), url).await?;
            app.borrow_mut().form["serverDialog"] = json!(false);
            crate::render(&app, true);
        }
        "category" => {
            app.borrow_mut().category = argument;
            crate::render(&app, true);
        }
        "open-settings" => {
            t::ipc("OPEN_SETTINGS", vec![]).await?;
        }
        "open-lobbies" => {
            t::ipc("OPEN_LOBBYBROWSER", vec![]).await?;
        }
        "open-history" => {
            t::ipc("OPEN_PLAYER_HISTORY", vec![]).await?;
        }
        "open-link" => {
            t::invoke("open_external", json!({"url":argument})).await?;
        }
        "reload" => {
            t::ipc("reload", vec![]).await?;
        }
        "relaunch" => {
            t::ipc("relaunch", vec![]).await?;
        }
        "close" => {
            t::window_action("close").await?;
        }
        "minimize" => t::window_action("minimize").await?,
        "toh-group" => {
            let checked = value(&element) == true;
            let roles = {
                let state = app.borrow();
                crate::state::toh_ghost_roles(
                    &state.settings["myLobbySettings"],
                    &state.snapshot()["tohRoleCatalog"],
                    &argument,
                    true,
                    checked,
                )?
            };
            set_setting(app.clone(), "myLobbySettings.tohGhostRoles".into(), roles).await?;
            crate::render(&app, true);
        }
        "background" => {
            t::native("background", Value::Null).await?;
        }
        "quit" => {
            t::native("quit", Value::Null).await?;
        }
        "mute" => {
            let muted = app.borrow().voice["muted"] != true;
            native_command(app, "mute", json!(muted)).await?;
        }
        "deafen" => {
            let deafened = app.borrow().voice["deafened"] != true;
            native_command(app, "deafen", json!(deafened)).await?;
        }
        "radio" | "jackal-radio" => {}
        "launch-game" => {
            let platform = app.borrow().settings["launchPlatform"].clone();
            let custom = app.borrow().settings["customPlatforms"].clone();
            let available = t::ipc("REQUEST_PLATFORMS_AVAILABLE", vec![custom]).await?;
            let selected = available
                .get(
                    platform
                        .as_str()
                        .ok_or("ゲームの起動先を選択してください")?,
                )
                .filter(|v| v.is_object())
                .or_else(|| available.as_object().and_then(|m| m.values().next()))
                .cloned()
                .ok_or("選択したゲームの起動先が見つかりません。設定を確認してください")?;
            t::ipc("OPEN_AMONG_US_GAME", vec![selected]).await?;
        }
        "refresh-devices" => {
            let devices = t::native("devices", Value::Null).await?;
            app.borrow_mut().devices = devices;
            crate::render(&app, true);
        }
        "speaker-test" => {
            let active = app.borrow().form["speakerTest"] != true;
            let generation = app.borrow().form["speakerTestGeneration"]
                .as_u64()
                .unwrap_or(0)
                + 1;
            native_command(app.clone(), "speaker-test", json!(active)).await?;
            app.borrow_mut().form["speakerTest"] = json!(active);
            app.borrow_mut().form["speakerTestGeneration"] = json!(generation);
            crate::render(&app, true);
            if active {
                t::dispatch(async move {
                    crate::wait(4000).await?;
                    if app.borrow().form["speakerTestGeneration"] == generation {
                        app.borrow_mut().form["speakerTest"] = json!(false);
                        crate::render(&app, true);
                    }
                    Ok(())
                });
            }
        }
        "microphone-test" => {
            let active = app.borrow().form["microphoneTest"] != true;
            app.borrow_mut().form["microphoneTest"] = json!(active);
            native_command(
                app,
                "effect-preview",
                if active {
                    json!({"tuning":{"pitch":0,"reverb":0,"echo":0},"effectKind":"disguise"})
                } else {
                    json!(false)
                },
            )
            .await?;
        }
        "effect-test" => {
            let value = {
                let state = app.borrow();
                let id = settings::selected_effect(&state);
                json!({"tuning":settings::tuning(&state,id),"effectKind":id})
            };
            native_command(app, "effect-preview", value).await?;
        }
        "effect-stop" => {
            native_command(app, "effect-preview", json!(false)).await?;
        }
        "effect-reset" => {
            let mut tunings = app.borrow().settings["voiceEffectTunings"].clone();
            let id = settings::selected_effect(&app.borrow()).to_owned();
            if let Some(object) = tunings.as_object_mut() {
                object.remove(&id);
            }
            set_setting(app.clone(), "voiceEffectTunings".into(), tunings).await?;
            crate::render(&app, true);
        }
        "select-effect" => {
            app.borrow_mut().selected_effect = text(&value(&element));
            crate::render(&app, true);
        }
        "reset-settings" => {
            if app.borrow().host_in_match() {
                return Err("試合中は初期化できません".into());
            }
            if !confirm("設定を初期状態に戻しますか？") {
                return Ok(());
            }
            t::ipc("settings:clear", vec![]).await?;
            let settings = t::ipc("settings:get", vec![]).await?;
            let mut prefs = app.borrow().voice["preferences"].clone();
            for (setting, pref, scale) in PREFERENCES {
                let value = &settings[setting];
                prefs[pref] = if scale != 1.0 {
                    json!(value.as_f64().unwrap_or(0.0) / scale)
                } else if ["microphone", "speaker"].contains(&setting) && value == "default" {
                    json!("")
                } else {
                    value.clone()
                };
            }
            let voice = t::native("configure", prefs).await?;
            {
                let mut state = app.borrow_mut();
                state.settings = settings;
                state.voice = voice;
            }
            crate::render(&app, true);
        }
        "remote-enable" | "remote-disable" => {
            native_command(app, name.as_str(), Value::Null).await?;
        }
        "copy-code" => {
            let code = text(&app.borrow().effective_game()["lobbyCode"]);
            copy(&code).await?;
        }
        "copy-obs" => {
            let url = settings::obs_url(&app.borrow());
            copy(&url).await?;
        }
        "save-platform" => {
            let platform = {
                let s = app.borrow();
                let name = text(&s.form["platformName"]);
                let path = text(&s.form["platformPath"]);
                let kind = s.form["platformType"].as_str().unwrap_or("EXE");
                crate::state::custom_platform(&name, &path, kind, &text(&s.form["platformArgs"]))?
            };
            let mut platforms = app.borrow().settings["customPlatforms"].clone();
            if !platforms.is_object() {
                platforms = json!({});
            }
            let key = text(&platform["key"]);
            let renamed = app.borrow().form["platformEdit"]
                .as_str()
                .filter(|old| **old != key && app.borrow().settings["launchPlatform"] == **old)
                .map(str::to_owned);
            if let Some(previous) = app.borrow().form["platformEdit"].as_str() {
                if previous != key {
                    if let Some(map) = platforms.as_object_mut() {
                        map.remove(previous);
                    }
                }
            }
            platforms[&key] = platform;
            set_setting(app.clone(), "customPlatforms".into(), platforms).await?;
            if renamed.is_some() {
                set_setting(app.clone(), "launchPlatform".into(), json!(key)).await?;
            }
            {
                let mut s = app.borrow_mut();
                s.form["platformDialog"] = json!(false);
                for key in [
                    "platformName",
                    "platformPath",
                    "platformArgs",
                    "platformEdit",
                ] {
                    s.form[key] = json!("");
                }
            }
            crate::render(&app, true);
        }
        "edit-platform" => {
            let mut state = app.borrow_mut();
            let platform = state.settings["customPlatforms"][&argument].clone();
            let exe = platform["launchType"] == "EXE";
            let args = platform["execute"].as_array().cloned().unwrap_or_default();
            state.form["platformName"] = platform["name"].clone();
            state.form["platformType"] = platform["launchType"].clone();
            state.form["platformPath"] = if exe {
                json!(format!(
                    "{}\\{}",
                    text(&platform["runPath"]).trim_end_matches(['\\', '/']),
                    args.first().map(text).unwrap_or_default()
                ))
            } else {
                platform["runPath"].clone()
            };
            state.form["platformArgs"] =
                json!(args.iter().skip(1).map(text).collect::<Vec<_>>().join(" "));
            state.form["platformEdit"] = json!(argument);
            state.form["platformAdvanced"] = json!(!text(&state.form["platformArgs"]).is_empty());
            state.form["platformDialog"] = json!(true);
            state.form["launchMenu"] = json!(false);
            drop(state);
            crate::render(&app, true);
        }
        "player-popup" => {
            app.borrow_mut().form["playerPopup"] = json!(argument);
            crate::render(&app, true);
        }
        "close-player-popup" => {
            app.borrow_mut().form["playerPopup"] = Value::Null;
            crate::render(&app, true);
        }
        "remove-platform" => {
            let mut platforms = app.borrow().settings["customPlatforms"].clone();
            if let Some(object) = platforms.as_object_mut() {
                object.remove(&argument);
            }
            set_setting(app.clone(), "customPlatforms".into(), platforms).await?;
            if app.borrow().settings["launchPlatform"] == argument {
                set_setting(app.clone(), "launchPlatform".into(), json!("STEAM")).await?;
            }
            app.borrow_mut().form["platformDialog"] = json!(false);
            crate::render(&app, true);
        }
        "pick-platform" => {
            let path = t::invoke("pick_path", json!({"kind":"executable"})).await?;
            if !path.is_null() {
                app.borrow_mut().form["platformPath"] = path;
                crate::render(&app, true);
            }
        }
        "open-debug" => {
            let password = app.borrow_mut().form["debugPassword"].take();
            let result = t::ipc("OPEN_DEBUG", vec![password]).await?;
            if result == "authorized" {
                app.borrow_mut().form["debugDialog"] = json!(false);
            }
            app.borrow_mut().message = if result == "authorized" {
                "デバッグ情報を開きました".into()
            } else {
                text(&result)
            };
            crate::render(&app, true);
        }
        "debug-tab" => {
            app.borrow_mut().form["debugTab"] = json!(argument);
            crate::render(&app, true);
        }
        "refresh-logs" => {
            let logs = t::ipc("debug:get-logs", vec![]).await?;
            app.borrow_mut().result["logs"] = logs;
            crate::render(&app, true);
        }
        "save-logs" => {
            let destination = t::invoke("pick_path", json!({"kind":"log"})).await?;
            if !destination.is_null() {
                t::ipc("tauri:save-log", vec![destination]).await?;
            }
        }
        "inquiry-attachments" => {
            let paths = t::invoke("pick_path", json!({"kind":"attachments"})).await?;
            if paths.is_array() {
                let selected = t::ipc("tauri:attachments", vec![paths]).await?;
                let mut app = app.borrow_mut();
                let mut existing = app.form["attachments"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for item in selected.as_array().into_iter().flatten() {
                    if !existing.iter().any(|v| v["path"] == item["path"]) {
                        existing.push(item.clone());
                    }
                }
                app.form["attachments"] = json!(existing);
            }
            crate::render(&app, true);
        }
        "remove-attachment" => {
            if let Ok(index) = argument.parse::<usize>() {
                let mut state = app.borrow_mut();
                if let Some(items) = state.form["attachments"].as_array_mut() {
                    if index < items.len() {
                        items.remove(index);
                    }
                }
            }
            crate::render(&app, true);
        }
        "submit-inquiry" => {
            let payload = {
                let state = app.borrow();
                if state.form["publicIssueAcknowledged"] != true {
                    return Err("公開Issueへの掲載を確認してください".into());
                }
                json!({"subject":state.form["subject"],"body":state.form["body"],"tag":state.form["tag"].as_str().unwrap_or("question"),"attachmentPaths":state.form["attachments"].as_array().into_iter().flatten().map(|v|v["path"].clone()).collect::<Vec<_>>(),"publicIssueAcknowledged":true})
            };
            let result = t::ipc("SUBMIT_INQUIRY", vec![payload]).await?;
            {
                let mut state = app.borrow_mut();
                state.message = format!("送信しました。{}", text(&result));
                for key in ["subject", "body", "attachments", "publicIssueAcknowledged"] {
                    state.form[key] = Value::Null;
                }
            }
            crate::render(&app, true);
        }
        "ban-list" | "ban-add" | "ban-player" | "ban-name" | "ban-record" | "ban-remove-name"
        | "history-previous" | "history-next" => {
            ban_action(app, name.as_str(), &argument, &element).await?;
        }
        "close-lobby-code" => {
            app.borrow_mut().form["lobbyCode"] = Value::Null;
            crate::render(&app, true);
        }
        "refresh-lobbies" => {
            let result = t::native("lobby-browser", json!({"action":"list"})).await?;
            app.borrow_mut().result["lobbyBrowser"] = result;
            crate::render(&app, true);
        }
        "lobby-code" => {
            let result = t::native("lobby-browser", json!({"action":"code","id":argument})).await?;
            app.borrow_mut().form["lobbyCode"] = json!(result
                .as_str()
                .or_else(|| result["code"].as_str())
                .unwrap_or(""));
            crate::render(&app, true);
        }
        "check-updates" | "download-update" | "install-update" => {
            let channel = match name.as_str() {
                "check-updates" => "updater:check",
                "download-update" => "update-app",
                _ => "RESTART_AND_UPDATE",
            };
            let result = t::ipc(channel, vec![]).await?;
            app.borrow_mut().updater = result;
            crate::render(&app, true);
        }
        _ => {}
    }
    Ok(())
}
async fn ban_action(app: App, name: &str, argument: &str, element: &Element) -> Result<(), String> {
    let (payload, history) = {
        let state = app.borrow();
        let password = text(&state.form["banPassword"]);
        if password.is_empty() {
            return Err("BAN管理者パスワードを入力してください".into());
        }
        let history = state.view == "player-history"
            || element.get_attribute("data-history").as_deref() == Some("true");
        let ip = if name == "ban-record" && !history {
            element.get_attribute("data-ban-type").as_deref() == Some("ip")
        } else {
            state.form["banType"] == "ip"
        };
        if ip && state.result["bans"]["ipBansAvailable"] != true {
            return Err("IP BANは利用できません".into());
        }
        let player = if name == "ban-player" {
            let observed_uid = element.get_attribute("data-player-uid").unwrap_or_default();
            Some(
                state.effective_game()["players"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|p| {
                        text(&p["clientId"]) == argument
                            && !observed_uid.is_empty()
                            && p["playerUid"] == observed_uid
                    })
                    .ok_or(
                        "プレイヤーがロビーにいないか、接続が変わりました。一覧を確認してください",
                    )?,
            )
        } else {
            None
        };
        let operation = match name {
            "ban-add" | "ban-player" => {
                if ip {
                    "add-ip"
                } else {
                    "add"
                }
            }
            "ban-name" => "add-name",
            "ban-remove-name" => "remove-name",
            "ban-record" => {
                if history {
                    if ip {
                        "add-history-ip"
                    } else {
                        "add-history"
                    }
                } else if ip {
                    "remove-ip"
                } else {
                    "remove"
                }
            }
            _ => "list",
        };
        if operation != "list"
            && !confirm("選択したプレイヤーに対するBAN登録・解除を実行しますか？")
        {
            return Ok(());
        }
        let offset = state.form["historyOffset"].as_u64().unwrap_or(0);
        let offset = if name == "history-next" {
            offset + 50
        } else if name == "history-previous" {
            offset.saturating_sub(50)
        } else if name == "ban-list" {
            0
        } else {
            offset
        };
        let boundary = |key: &str, next: bool| -> Result<Value, String> {
            let value = text(&state.form[key]);
            if value.is_empty() {
                return Ok(Value::Null);
            }
            let date = js_sys::Date::new(&JsValue::from_str(&format!("{value}T00:00:00")));
            if next {
                date.set_date(date.get_date() + 1);
            }
            let time = date.get_time();
            if time.is_finite() {
                Ok(json!((time / 1000.0).floor()))
            } else {
                Err("履歴の日付を確認してください".into())
            }
        };
        let from = boundary("historyFrom", false)?;
        let to = boundary("historyTo", true)?;
        if from
            .as_f64()
            .zip(to.as_f64())
            .is_some_and(|(from, to)| from >= to)
        {
            return Err("開始日は終了日以前を指定してください".into());
        }
        let player_name = if name == "ban-remove-name" {
            argument
        } else {
            state.form["banName"].as_str().unwrap_or("")
        };
        (
            json!({"password":password,"action":operation,"reason":state.form["banReason"].as_str().unwrap_or(""),"playerName":player_name,"playerUid":player.map(|p|text(&p["playerUid"])).unwrap_or_default(),"displayName":player.map(|p|text(&p["name"])).unwrap_or_default(),"friendCode":player.map(|p|text(&p["friendCode"])).unwrap_or_default(),"uidDigest":argument,"publicIp":argument,"historyAll":!history,"historyName":state.form["banName"].as_str().unwrap_or(""),"historyFrom":from,"historyTo":to,"historyOffset":offset}),
            history,
        )
    };
    let result = t::ipc("debug:player-bans", vec![payload.clone()]).await?;
    {
        let mut state = app.borrow_mut();
        if history {
            state.form["historyOffset"] = payload["historyOffset"].clone();
        }
        state.message = result["error"]
            .as_str()
            .unwrap_or("一覧を更新しました")
            .into();
        state.result["bans"] = result;
        if state.result["bans"]["ipBansAvailable"] != true {
            state.form["banType"] = json!("uid");
        }
    }
    crate::render(&app, true);
    Ok(())
}
fn confirm(message: &str) -> bool {
    web_sys::window()
        .unwrap()
        .confirm_with_message(message)
        .unwrap_or(false)
}
async fn copy(text: &str) -> Result<(), String> {
    let promise = web_sys::window()
        .unwrap()
        .navigator()
        .clipboard()
        .write_text(text);
    wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(t::error)?;
    Ok(())
}
fn target(event: &Event) -> Option<Element> {
    event.target()?.dyn_into::<Element>().ok()
}
fn bind(
    document: &web_sys::Document,
    name: &str,
    callback: impl FnMut(Event) + 'static,
) -> Result<(), JsValue> {
    let listener = Closure::<dyn FnMut(Event)>::new(callback);
    document.add_event_listener_with_callback(name, listener.as_ref().unchecked_ref())?;
    listener.forget();
    Ok(())
}
pub fn bind_all(app: App) -> Result<(), JsValue> {
    let document = web_sys::window().unwrap().document().unwrap();
    let platforms = app.clone();
    bind(&document, "contextmenu", move |event| {
        let Some(element) =
            target(&event).and_then(|e| e.closest("[data-action=select-launch]").ok().flatten())
        else {
            return;
        };
        let id = element.get_attribute("data-value").unwrap_or_default();
        if !platforms.borrow().settings["customPlatforms"][&id].is_object() {
            return;
        }
        event.prevent_default();
        t::dispatch(action(
            platforms.clone(),
            "edit-platform".into(),
            id,
            element,
        ));
    })?;
    let hover = app.clone();
    bind(&document, "pointerover", move |event| {
        let Some(element) = target(&event) else {
            return;
        };
        if let Some(player) = element.closest("[data-action=player-popup]").ok().flatten() {
            let id = player.get_attribute("data-value").unwrap_or_default();
            if hover.borrow().form["playerPopup"] != id {
                let rect = player.get_bounding_client_rect();
                let width = hover.borrow().viewport[0];
                {
                    let mut state = hover.borrow_mut();
                    state.form["playerPopup"] = json!(id);
                    state.form["popupLeft"] = json!((rect.x() + rect.width() / 2.0 - 115.0)
                        .clamp(8.0, (width - 238.0).max(8.0)));
                    state.form["popupTop"] = json!((rect.y() - 108.0).max(24.0));
                }
                crate::render(&hover, true);
            }
        } else if !hover.borrow().form["playerPopup"].is_null()
            && element.closest(".player-popup").ok().flatten().is_none()
            && hover.borrow().form["popupClosing"] != true
        {
            hover.borrow_mut().form["popupClosing"] = json!(true);
            let state = hover.clone();
            t::dispatch(async move {
                crate::wait(300).await?;
                let active=web_sys::window().and_then(|w|w.document()).and_then(|d|d.query_selector(".player-popup:hover,.player-popup:focus-within,[data-action=player-popup]:hover").ok().flatten()).is_some();
                state.borrow_mut().form["popupClosing"] = json!(false);
                if !active {
                    state.borrow_mut().form["playerPopup"] = Value::Null;
                    crate::render(&state, true);
                }
                Ok(())
            });
        }
    })?;
    let state = app.clone();
    bind(&document, "click", move |event| {
        let Some(element) = target(&event).and_then(|v| v.closest("[data-action]").ok().flatten())
        else {
            return;
        };
        if element.has_attribute("disabled") {
            return;
        }
        let name = element.get_attribute("data-action").unwrap_or_default();
        state.borrow_mut().error.clear();
        if ["select-effect", "toh-group"].contains(&name.as_str()) {
            return;
        }
        let argument = element.get_attribute("data-value").unwrap_or_default();
        let guarded = [
            "submit-inquiry",
            "ban-list",
            "ban-add",
            "ban-player",
            "ban-name",
            "ban-record",
            "ban-remove-name",
            "history-previous",
            "history-next",
            "check-updates",
            "download-update",
            "install-update",
        ]
        .contains(&name.as_str());
        if guarded {
            if state.borrow().busy {
                return;
            }
            state.borrow_mut().busy = true;
            crate::render(&state, true);
        }
        let app = state.clone();
        t::dispatch(async move {
            let result = action(app.clone(), name, argument, element).await;
            if guarded {
                app.borrow_mut().busy = false;
                crate::render(&app, true);
            }
            result
        });
    })?;
    let state = app.clone();
    bind(&document, "input", move |event| {
        if let Some(element) = target(&event) {
            if let Some(key) = element.get_attribute("data-form") {
                state.borrow_mut().form[&key] = value(&element);
                if ["publicIssueAcknowledged", "subject", "body"].contains(&key.as_str()) {
                    let s = state.borrow();
                    let ready = s.form["publicIssueAcknowledged"] == true
                        && !text(&s.form["subject"]).trim().is_empty()
                        && !text(&s.form["body"]).trim().is_empty()
                        && !s.busy;
                    if let Ok(Some(button)) = web_sys::window()
                        .unwrap()
                        .document()
                        .unwrap()
                        .query_selector("[data-action=submit-inquiry]")
                    {
                        if ready {
                            let _ = button.remove_attribute("disabled");
                        } else {
                            let _ = button.set_attribute("disabled", "");
                        }
                    }
                }
                if key == "debugSearch" {
                    if let Some(list) = web_sys::window()
                        .unwrap()
                        .document()
                        .unwrap()
                        .get_element_by_id("debug-player-list")
                    {
                        list.set_inner_html(&crate::views::debug_players(&state.borrow()));
                    }
                }
            }
            if element.get_attribute("type").as_deref() == Some("range") {
                if let Some(output) = element.next_element_sibling() {
                    let unit = element.get_attribute("data-format").unwrap_or_default();
                    let number = value(&element).as_f64().unwrap_or(0.0);
                    let formatted =
                        if element.get_attribute("data-effect-axis").as_deref() == Some("pitch") {
                            if number > 0.0 {
                                format!("+{number}")
                            } else {
                                number.to_string()
                            }
                        } else {
                            settings::display_number(&unit, number)
                        };
                    output.set_text_content(Some(&formatted));
                }
            }
        }
    })?;
    let state = app.clone();
    bind(&document, "change", move |event| {
        let Some(element) = target(&event) else {
            return;
        };
        let next = value(&element);
        if let Some(key) = element.get_attribute("data-form") {
            state.borrow_mut().form[&key] = next;
            if key == "platformType" {
                state.borrow_mut().form["platformPath"] = json!("");
                state.borrow_mut().form["platformArgs"] = json!("");
            }
            if key == "platformAdvanced" && state.borrow().form[&key] != true {
                state.borrow_mut().form["platformArgs"] = json!("");
            }
            if ["platformType", "platformAdvanced", "banType", "lobbySearch"]
                .contains(&key.as_str())
            {
                crate::render(&state, true);
            }
            return;
        }
        if let Some(key) = element.get_attribute("data-setting") {
            t::dispatch(set_setting(state.clone(), key, next));
            return;
        }
        if let Some(axis) = element.get_attribute("data-effect-axis") {
            let (id, tuning) = {
                let s = state.borrow();
                (
                    settings::selected_effect(&s).to_owned(),
                    settings::tuning(&s, settings::selected_effect(&s)),
                )
            };
            let mut tuning = tuning;
            tuning[&axis] = next;
            t::dispatch(set_setting(
                state.clone(),
                format!("voiceEffectTunings.{id}"),
                tuning,
            ));
            return;
        }
        if let Some(client) = element
            .get_attribute("data-player-volume")
            .or_else(|| element.get_attribute("data-player-mute"))
        {
            let s = state.borrow();
            let id = client.parse::<i64>().unwrap_or(-1);
            let player = s.effective_game()["players"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["clientId"].as_i64() == Some(id));
            let config = player
                .map(|p| s.settings["playerConfigMap"][text(&p["playerConfigId"])].clone())
                .unwrap_or(Value::Null);
            let volume = if element.has_attribute("data-player-volume") {
                next.as_f64().unwrap_or(100.0) / 100.0
            } else {
                config["volume"].as_f64().unwrap_or(1.0)
            };
            let muted = if element.has_attribute("data-player-mute") {
                next == true
            } else {
                config["isMuted"] == true
            };
            drop(s);
            t::dispatch(native_command(
                state.clone(),
                "player",
                json!({"clientId":id,"volume":volume,"isMuted":muted}),
            ));
            return;
        }
        if let Some(name) = element.get_attribute("data-action") {
            let argument = element.get_attribute("data-value").unwrap_or_default();
            t::dispatch(action(state.clone(), name, argument, element));
        }
    })?;
    let state = app.clone();
    bind(&document, "keydown", move |event| {
        let Some(input) = target(&event).filter(|v| v.has_attribute("data-key-capture")) else {
            return;
        };
        let Some(key) = event.dyn_ref::<KeyboardEvent>() else {
            return;
        };
        if key.code() == "Tab" {
            return;
        }
        event.prevent_default();
        let name = match key.code().as_str() {
            "Escape" => "Disabled".into(),
            "ControlRight" => "RControl".into(),
            "ControlLeft" => "LControl".into(),
            "AltRight" => "RAlt".into(),
            "AltLeft" => "LAlt".into(),
            "ShiftRight" => "RShift".into(),
            "ShiftLeft" => "LShift".into(),
            "ArrowUp" => "Up".into(),
            "ArrowDown" => "Down".into(),
            "ArrowLeft" => "Left".into(),
            "ArrowRight" => "Right".into(),
            code => code
                .strip_prefix("Key")
                .or_else(|| code.strip_prefix("Digit"))
                .unwrap_or(code)
                .to_owned(),
        };
        if !crate::state::valid_shortcut(&name) {
            return;
        }
        if let Some(element) = input.dyn_ref::<HtmlInputElement>() {
            element.set_value(&name);
        }
        if let Some(setting) = input.get_attribute("data-setting") {
            t::dispatch(set_setting(state.clone(), setting, json!(name)));
        }
    })?;
    let state = app.clone();
    bind(&document, "mousedown", move |event| {
        let Some(element) = target(&event) else {
            return;
        };
        if element.has_attribute("data-key-capture") {
            if let Some(mouse) = event.dyn_ref::<MouseEvent>() {
                if mouse.button() > 2 {
                    event.prevent_default();
                    if let Some(setting) = element.get_attribute("data-setting") {
                        state.borrow_mut().form["capturingShortcut"] = Value::Null;
                        t::dispatch(set_setting(
                            state.clone(),
                            setting,
                            json!(format!("MouseButton{}", mouse.button() + 1)),
                        ));
                    }
                } else {
                    state.borrow_mut().form["capturingShortcut"] =
                        json!(element.get_attribute("data-setting").unwrap_or_default());
                }
            }
            return;
        }
        if element.closest("[data-drag]").ok().flatten().is_some()
            && element
                .closest("button,input,select,textarea")
                .ok()
                .flatten()
                .is_none()
        {
            t::dispatch(t::window_action("startDragging"));
        }
    })?;
    let state = app.clone();
    bind(&document, "pointerdown", move |event| {
        if let Some(element) =
            target(&event).and_then(|v| v.closest("[data-action]").ok().flatten())
        {
            let name = element.get_attribute("data-action").unwrap_or_default();
            if ["radio", "jackal-radio"].contains(&name.as_str()) {
                let app = state.clone();
                t::dispatch(async move { native_command(app, &name, json!(true)).await });
            }
        }
    })?;
    let release = app.clone();
    bind(&document, "pointerup", move |_| {
        let app = release.clone();
        t::dispatch(async move {
            native_command(app.clone(), "radio", json!(false)).await?;
            native_command(app, "jackal-radio", json!(false)).await
        })
    })?;
    let release = app.clone();
    let blur = Closure::<dyn FnMut(Event)>::new(move |_| {
        release_radios(release.clone());
    });
    web_sys::window()
        .unwrap()
        .add_event_listener_with_callback("blur", blur.as_ref().unchecked_ref())?;
    blur.forget();
    let release = app.clone();
    bind(&document, "visibilitychange", move |_| {
        if web_sys::window().unwrap().document().unwrap().hidden() {
            release_radios(release.clone());
        }
    })?;
    let release = app.clone();
    bind(&document, "pointercancel", move |_| {
        release_radios(release.clone())
    })?;
    bind_image_events(&document)?;
    let state = app.clone();
    let toggle = Closure::<dyn FnMut(Event)>::new(move |event: Event| {
        if let Some(element) = target(&event) {
            if let Some(id) = element.get_attribute("data-debug-section") {
                state.borrow_mut().form["debugSections"][&id] =
                    json!(element.has_attribute("open"));
            }
            if let Some(id) = element.get_attribute("data-debug-open") {
                state.borrow_mut().form["debugExpanded"][&id] =
                    json!(element.has_attribute("open"));
            }
        }
    });
    document.add_event_listener_with_callback_and_bool(
        "toggle",
        toggle.as_ref().unchecked_ref(),
        true,
    )?;
    toggle.forget();
    Ok(())
}
fn release_radios(app: App) {
    t::dispatch(async move {
        native_command(app.clone(), "radio", json!(false)).await?;
        native_command(app, "jackal-radio", json!(false)).await
    });
}
fn bind_image_events(document: &web_sys::Document) -> Result<(), JsValue> {
    let load = Closure::<dyn FnMut(Event)>::new(move |event: Event| {
        let Some(image) = event
            .target()
            .and_then(|v| v.dyn_into::<web_sys::HtmlImageElement>().ok())
        else {
            return;
        };
        if image.has_attribute("data-snr-scale") && image.natural_width() > 0 {
            let width = (image.natural_width() as f64 / (115.0 * (8.0 / 3.0)) * 140.0).min(140.0);
            let height = image.natural_height() as f64 / image.natural_width() as f64 * width;
            let _ = image.set_attribute(
                "style",
                &format!(
                    "width:{width}%;left:{}px;top:{}%",
                    56.0 - width / 2.0,
                    22.0 - height / 2.0
                ),
            );
        }
        if image.class_name() == "mask-loader" {
            let source = image.src();
            if source.starts_with("https://nos-cosmetic.localhost/")
                && !source
                    .chars()
                    .any(|c| c.is_control() || "'\"()<>\\".contains(c))
            {
                if let Some(parent) = image.parent_element() {
                    let _=parent.set_attribute("style",&format!("mask-image:url('{source}');mask-size:140% auto;mask-position:-24px -18px;mask-repeat:no-repeat"));
                }
            }
        }
    });
    document.add_event_listener_with_callback_and_bool(
        "load",
        load.as_ref().unchecked_ref(),
        true,
    )?;
    load.forget();
    let error = Closure::<dyn FnMut(Event)>::new(move |event: Event| {
        if let Some(image) = event
            .target()
            .and_then(|v| v.dyn_into::<web_sys::HtmlImageElement>().ok())
        {
            if image.class_name() == "base" && !image.has_attribute("data-fallback") {
                let _ = image.set_attribute("data-fallback", "true");
                image.set_src("https://static.localhost/generated/player/0.png");
            } else {
                let _ = image.set_attribute("style", "display:none");
            }
        }
    });
    document.add_event_listener_with_callback_and_bool(
        "error",
        error.as_ref().unchecked_ref(),
        true,
    )?;
    error.forget();
    Ok(())
}
