//! Experimental Rust backend. The shared React/WebRTC frontend stays unchanged.
mod assets;
mod http;
mod keys;
mod memory;
mod mods;
mod reader;
mod services;
mod settings;
mod updater;

use base64::Engine;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub struct Backend {
    updater: updater::Updater,
    app: AppHandle,
    running: AtomicBool,
    hooked: AtomicBool,
    reconnect: AtomicBool,
    key_thread: AtomicU32,
    settings: Mutex<settings::Settings>,
    state: Mutex<Value>,
    info: Mutex<Value>,
    colors: Mutex<Vec<[String; 2]>>,
    shortcuts: Mutex<Vec<String>>,
    data: PathBuf,
    resources: PathBuf,
    client: Client,
    constants: Value,
    catalog: Mutex<Option<(String, Instant, Value)>>,
    windows: Mutex<HashSet<String>>,
    services: services::Services,
    cosmetics: Arc<Mutex<mods::cosmetics::Cosmetics>>,
    addon_link: Arc<Mutex<mods::link::Link>>,
}

pub fn argument(name: &str) -> Option<String> {
    let args: Vec<_> = std::env::args().collect();
    args.iter().enumerate().find_map(|(index, arg)| {
        arg.strip_prefix(&format!("{name}="))
            .map(str::to_owned)
            .or_else(|| {
                if arg == name {
                    args.get(index + 1).cloned()
                } else {
                    None
                }
            })
    })
}
fn target() -> (String, u32, usize) {
    let name = std::env::var("BETTERCREWLINK_TARGET_PROCESS")
        .ok()
        .or_else(|| argument("--target-exe"))
        .unwrap_or_else(|| "Among Us.exe".into());
    let pid = std::env::var("BETTERCREWLINK_TARGET_PID")
        .ok()
        .or_else(|| argument("--target-pid"))
        .or_else(|| argument("--game-process-id"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let index = std::env::var("BETTERCREWLINK_TARGET_INDEX")
        .ok()
        .or_else(|| argument("--target-index"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    (name, pid, index)
}
fn resources(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out/tauri-backend"))
    } else {
        Ok(app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("backend"))
    }
}
fn shortcuts(settings: &Value) -> Vec<String> {
    [
        ("pushToTalkShortcut", "V"),
        ("deafenShortcut", "RControl"),
        ("muteShortcut", "RAlt"),
        ("impostorRadioShortcut", "F"),
        ("jackalRadioShortcut", "G"),
    ]
    .into_iter()
    .map(|(name, default)| settings[name].as_str().unwrap_or(default).to_owned())
    .collect()
}
impl Backend {
    pub fn start(app: &AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let resources = resources(app)?;
        let data = app.path().app_config_dir()?;
        fs::create_dir_all(data.join("logs"))?;
        let settings = settings::Settings::load(&data, &resources)?;
        let shortcuts = shortcuts(&settings.current());
        let constants = serde_json::from_slice(&fs::read(resources.join("rust-constants.json"))?)?;
        let backend = Arc::new(Self {
            updater: updater::Updater::default(),
            app: app.clone(),
            running: AtomicBool::new(true),
            hooked: AtomicBool::new(false),
            reconnect: AtomicBool::new(false),
            key_thread: AtomicU32::new(0),
            settings: Mutex::new(settings),
            state: Mutex::new(Value::Null),
            info: Mutex::new(Value::Null),
            colors: Mutex::new(Vec::new()),
            shortcuts: Mutex::new(shortcuts),
            data,
            resources,
            client: http::client()?,
            constants,
            catalog: Mutex::new(None),
            windows: Mutex::new(HashSet::new()),
            services: services::Services::default(),
            cosmetics: Arc::new(Mutex::new(mods::cosmetics::Cosmetics::default())),
            addon_link: Arc::new(Mutex::new(mods::link::Link::default())),
        });
        let owned = backend.clone();
        std::thread::spawn(move || owned.poll());
        keys::start(backend.clone());
        Ok(backend)
    }
    fn emit(&self, target: &str, channel: &str, args: Vec<Value>) {
        if target == "main" {
            if let Some(lab) = self.app.try_state::<Arc<crate::voice_lab::Lab>>() {
                lab.observe_game(channel, &args);
            }
            if let Some(service) = self.app.try_state::<Arc<crate::voice::Service>>() {
                service.backend_event(channel, &args);
            }
        }
        if std::env::var_os("TANUKI_RUST_TRACE").is_some()
            && (channel == "TOGGLE_MUTE" || channel == "TOGGLE_DEAFEN")
        {
            eprintln!("rust event {channel}");
        }
        let _ = self.app.emit_to(
            target,
            "backend-ipc",
            json!({"channel":channel,"args":args}),
        );
    }
    fn control(&self, action: &str, target: &str, value: Value) -> Result<(), String> {
        let app = self.app.clone();
        let frame = json!({"action":action,"target":target,"value":value});
        self.app
            .run_on_main_thread(move || {
                if std::env::var_os("TANUKI_RUST_TRACE").is_some() {
                    eprintln!("rust control main-thread {}", frame["action"]);
                }
                crate::control(&app, &frame)
            })
            .map_err(|e| e.to_string())
    }
    fn window_presence(&self) {
        let windows = self.windows.lock().unwrap();
        let present = windows.contains("settings") || windows.contains("debug");
        self.emit(
            "main",
            "SETTINGS_NOTIFY_WINDOW_PRESENCE",
            vec![json!(present)],
        );
    }
    fn broadcast_settings(&self) {
        let settings = self.settings.lock().unwrap().current();
        *self.shortcuts.lock().unwrap() = shortcuts(&settings);
        for target in ["main", "settings", "overlay", "lobbies", "debug"] {
            self.emit(target, "settings:changed", vec![settings.clone()]);
        }
    }
    pub fn request(
        &self,
        target: &str,
        channel: &str,
        args: Vec<Value>,
        _mode: &str,
    ) -> Result<Value, String> {
        if let Some(result) =
            self.services
                .request(target, channel, &args, &self.data, &self.client)
        {
            let value = result?;
            if channel == "OPEN_DEBUG" && value == "authorized" {
                self.control("open", "debug", Value::Null)?;
            }
            if channel == "OPEN_PLAYER_HISTORY" && value == true {
                self.control("open", "player-history", Value::Null)?;
            }
            return Ok(value);
        }
        if std::env::var_os("TANUKI_RUST_TRACE").is_some() {
            eprintln!("rust request {channel}");
        }
        let get = |index| args.get(index).cloned().unwrap_or(Value::Null);
        let text = |index| args.get(index).and_then(Value::as_str).unwrap_or("");
        if [
            "updater:get-state",
            "updater:check",
            "update-app",
            "RESTART_AND_UPDATE",
        ]
        .contains(&channel)
        {
            if !["main", "settings"].contains(&target) {
                return Err("設定画面から更新してください".into());
            }
            return self.updater.request(channel, &self.data, &self.app);
        }
        match channel {
            "native:new-obs-secret" => {
                let mut bytes = [0u8; 9];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
                return Ok(json!(bytes
                    .iter()
                    .map(|b| b"abcdefghijklmnopqrstuvwxyz0123456789"[(*b as usize) % 36] as char)
                    .collect::<String>()));
            }
            "native:addon:sample" => {
                if target != "main" {
                    return Err("Voice sample requires main window".into());
                }
                let sample = get(0);
                let state = self.state.lock().unwrap().clone();
                return Ok(json!(self.addon_link.lock().unwrap().sample(
                    &state,
                    sample["playerId"].as_u64().unwrap_or(256),
                    sample["rms"].as_f64().unwrap_or(f64::NAN) as f32,
                    sample["active"] == true,
                    sample["host"] == true
                )));
            }
            "NOS_HERO_SPEECH_STATE" => return Ok(self.addon_link.lock().unwrap().speech_state()),
            "NOS_HERO_SPEECH_READY" | "NOS_HERO_SPEECH_WORD" => {
                if target != "main" {
                    return Err("Speech requires main window".into());
                }
                let state = self.state.lock().unwrap().clone();
                let mut link = self.addon_link.lock().unwrap();
                if channel == "NOS_HERO_SPEECH_READY" {
                    for p in get(1).as_array().into_iter().flatten().take(24) {
                        link.speech_command(
                            &state,
                            "ready",
                            text(0),
                            p.as_u64().unwrap_or(256),
                            0,
                            "",
                        );
                    }
                } else {
                    link.speech_command(
                        &state,
                        "word",
                        text(0),
                        get(1).as_u64().unwrap_or(256),
                        get(2).as_u64().unwrap_or(0),
                        text(3),
                    );
                }
                return Ok(Value::Null);
            }
            "tauri:ping" => {
                return Ok(
                    json!({"runtime":"rust","electron":false,"version":env!("CARGO_PKG_VERSION"),"pid":std::process::id(),"baseVersion":"3.2.62","nodeStarted":false,"scope":"windows-game-and-voice"}),
                )
            }
            "settings:get" => return Ok(self.settings.lock().unwrap().current()),
            "settings:set" => {
                self.settings.lock().unwrap().set(
                    text(0),
                    get(1),
                    args.get(2) != Some(&json!(false)),
                )?;
                self.broadcast_settings();
            }
            "settings:clear" => {
                self.settings.lock().unwrap().clear()?;
                self.broadcast_settings();
            }
            "START_HOOK" => {
                if self.hooked.swap(true, Ordering::SeqCst) && !crate::voice::enabled() {
                    self.reconnect.store(true, Ordering::SeqCst);
                }
                let state = self.state.lock().unwrap().clone();
                self.emit(target, "NOTIFY_GAME_OPENED", vec![json!(!state.is_null())]);
                self.emit(
                    target,
                    "NOTIFY_PLAYERCOLORS_CHANGED",
                    vec![json!(*self.colors.lock().unwrap())],
                );
            }
            "GET_INITIAL_STATE" => return Ok(self.state.lock().unwrap().clone()),
            "REQUEST_MOD" => {
                return Ok(self.state.lock().unwrap()["mod"]
                    .as_str()
                    .map(|s| json!(s))
                    .unwrap_or(json!("NONE")))
            }
            "REQUEST_GAME_INFO" => return Ok(self.info.lock().unwrap().clone()),
            "native:context" => {
                return Ok(
                    json!({"gameInfo":*self.info.lock().unwrap(),"playerColors":*self.colors.lock().unwrap()}),
                )
            }
            "native:cosmetics-catalog" => return self.cosmetics_catalog(),
            "getlocale" => return Ok(self.settings.lock().unwrap().current()["language"].clone()),
            "RESET_KEYHOOKS" => {
                *self.shortcuts.lock().unwrap() =
                    shortcuts(&self.settings.lock().unwrap().current())
            }
            "NOS_VOICE_ROLE_SAMPLE" => {}
            "setAlwaysOnTop" => self.control("alwaysOnTop", "main", get(0))?,
            "enableOverlay" => self.control("overlay", "overlay", get(0))?,
            "OPEN_SETTINGS" => self.control("open", "settings", Value::Null)?,
            "OPEN_LOBBYBROWSER" => self.control("open", "lobbies", Value::Null)?,
            "__window_state" => {
                if get(0) == true {
                    self.windows.lock().unwrap().insert(target.to_owned());
                } else {
                    self.windows.lock().unwrap().remove(target);
                }
                self.window_presence();
            }
            "REQUEST_SETTINGS_WINDOW_PRESENCE" => self.window_presence(),
            "QUIT_CREWLINK" => self.control("quit", "main", Value::Null)?,
            "RESTART_CREWLINK" | "relaunch" => self.control("relaunch", "main", Value::Null)?,
            "reload" | "minimize" => {
                let label = if text(0).is_empty() { target } else { text(0) };
                if ![
                    "main",
                    "settings",
                    "lobbies",
                    "debug",
                    "overlay",
                    "player-history",
                ]
                .contains(&label)
                {
                    return Err("Invalid window".into());
                }
                self.control(channel, label, Value::Null)?;
            }
            "SHOW_ERROR_DIALOG" => {
                self.control("error", "main", json!({"title":text(0),"message":text(1)}))?
            }
            "SEND_TO_OVERLAY" | "SEND_TO_SETTINGS" | "SEND_TO_MAINWINDOW" => {
                let destination = match channel {
                    "SEND_TO_OVERLAY" => "overlay",
                    "SEND_TO_SETTINGS" => "settings",
                    _ => "main",
                };
                let event = text(0);
                if event.len() > 128 || event.starts_with("__") {
                    return Err("Invalid forwarded event".into());
                }
                self.emit(destination, event, args.iter().skip(1).cloned().collect());
            }
            "REQUEST_PLATFORMS_AVAILABLE" => return self.platforms(&get(0)),
            "OPEN_AMONG_US_GAME" => self.launch(&get(0))?,
            "JOIN_LOBBY" => {
                self.emit(target, "JOIN_LOBBY_ERROR", args);
                return Ok(json!(false));
            }
            "player-bans:check" => {
                return Ok(json!(if target == "main" {
                    self.check_player(&args)
                } else {
                    "unavailable"
                }))
            }
            "__asset" => {
                let bytes = match text(0) {
                    "static" => assets::static_asset(&self.data, text(1))?,
                    "generate" => {
                        let colors = self.colors.lock().unwrap().clone();
                        assets::generated_hat(&self.client, &self.data, text(2), &colors)?
                    }
                    "nos-cosmetic" => {
                        if self.state.lock().unwrap()["mod"] != "NoS" {
                            return Err("No selected NoS game".into());
                        }
                        let key = text(1)
                            .trim_start_matches('/')
                            .strip_prefix("image/")
                            .ok_or("Invalid NoS asset")?;
                        let query = tauri::Url::parse(&format!(
                            "https://nos-cosmetic.localhost/?{}",
                            text(2)
                        ))
                        .map_err(|e| e.to_string())?;
                        let tint = query
                            .query_pairs()
                            .find(|(key, _)| key == "color")
                            .map(|(_, value)| value.into_owned())
                            .unwrap_or_default();
                        self.cosmetics.lock().unwrap().image(key, &tint)?
                    }
                    "snr-cosmetic" => {
                        if self.state.lock().unwrap()["mod"] != "SUPER_NEW_ROLES" {
                            return Err("No selected SNR game".into());
                        }
                        let path = text(1).trim_start_matches('/');
                        let (part, id) = path.split_once('/').ok_or("Invalid SNR asset")?;
                        let id = percent_encoding::percent_decode_str(id)
                            .decode_utf8()
                            .map_err(|e| e.to_string())?;
                        let bytes = self.cosmetics.lock().unwrap().snr.image(&id, part)?;
                        let query = tauri::Url::parse(&format!(
                            "https://snr-cosmetic.localhost/?{}",
                            text(2)
                        ))
                        .map_err(|e| e.to_string())?;
                        if query
                            .query_pairs()
                            .any(|(k, v)| k == "adaptive" && v == "1")
                        {
                            let color = query
                                .query_pairs()
                                .find(|(k, _)| k == "color")
                                .and_then(|(_, v)| v.parse::<usize>().ok())
                                .ok_or("Invalid SNR tint")?;
                            let palette = self.colors.lock().unwrap();
                            let colors = palette.get(color).ok_or("Invalid SNR tint")?;
                            assets::recolor(&bytes, &colors[0], &colors[1])?
                        } else {
                            bytes
                        }
                    }
                    _ => return Err("Unsupported cosmetic source".into()),
                };
                return Ok(json!(
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ));
            }
            _ => return Err(format!("Unsupported Rust request: {channel}")),
        }
        Ok(Value::Null)
    }
    fn platforms(&self, custom: &Value) -> Result<Value, String> {
        let mut available = serde_json::Map::new();
        for (name, scheme) in [("STEAM", "steam"), ("EPIC", "com.epicgames.launcher")] {
            if registered_scheme(scheme) {
                available.insert(
                    name.into(),
                    self.constants["DefaultGamePlatforms"][name].clone(),
                );
            }
        }
        if let Some(path) = microsoft_store_path() {
            let mut platform = self.constants["DefaultGamePlatforms"]["MICROSOFT"].clone();
            platform["runPath"] = json!(path);
            available.insert("MICROSOFT".into(), platform);
        }
        if let Some(custom) = custom.as_object() {
            for (key, platform) in custom {
                if key.encode_utf16().count() <= 80
                    && (platform["launchType"] == "URI" || platform["launchType"] == "EXE")
                {
                    available.insert(key.clone(), platform.clone());
                }
            }
        }
        Ok(Value::Object(available))
    }
    fn cosmetics_catalog(&self) -> Result<Value, String> {
        let mode = self.state.lock().unwrap()["mod"]
            .as_str()
            .unwrap_or("NONE")
            .to_owned();
        if let Some((key, at, value)) = &*self.catalog.lock().unwrap() {
            if *key == mode && at.elapsed() < Duration::from_secs(900) {
                return Ok(value.clone());
            }
        }
        let read = |url: &str| -> Result<Value, String> {
            serde_json::from_slice(&http::get(&self.client, url, 8 * 1024 * 1024)?)
                .map_err(|e| e.to_string())
        };
        let mut result = json!({"collection":read("https://cdn.jsdelivr.net/gh/OhMyGuus/BetterCrewLink-Hats@master/hats.json")?,"snrHats":[],"snrVisors":[]});
        if mode == "SUPER_NEW_ROLES" {
            result["snrHats"]=read("https://raw.githubusercontent.com/SuperNewRoles/SuperNewCosmetics/main/CustomHats.json").ok().and_then(|v|v["hats"].as_array().cloned()).map(|v|json!(v)).unwrap_or(json!([]));
            result["snrVisors"]=read("https://raw.githubusercontent.com/SuperNewRoles/SuperNewCosmetics/main/CustomVisors.json").ok().and_then(|v|v["Visors"].as_array().cloned()).map(|v|json!(v)).unwrap_or(json!([]));
        }
        *self.catalog.lock().unwrap() = Some((mode, Instant::now(), result.clone()));
        Ok(result)
    }
    fn launch(&self, platform: &Value) -> Result<(), String> {
        let path = platform["runPath"].as_str().ok_or("Missing game path")?;
        if platform["launchType"] == "URI" {
            let url = tauri::Url::parse(path).map_err(|e| e.to_string())?;
            if !matches!(url.scheme(), "http" | "https") && !registered_scheme(url.scheme()) {
                return Err("Unsupported launch protocol".into());
            }
            return open::that_detached(path).map_err(|e| e.to_string());
        }
        let directory = Path::new(path);
        let execute = platform["execute"].as_array().ok_or("Missing executable")?;
        let name = execute
            .first()
            .and_then(Value::as_str)
            .ok_or("Missing executable")?;
        let executable = directory.join(name);
        if executable
            .extension()
            .and_then(|e| e.to_str())
            .is_none_or(|e| !e.eq_ignore_ascii_case("exe"))
        {
            return Err("Invalid game executable".into());
        }
        std::process::Command::new(executable)
            .args(execute.iter().skip(1).filter_map(Value::as_str))
            .current_dir(directory)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn check_player(&self, args: &[Value]) -> &'static str {
        let valid = |value: Option<&Value>, limit: usize| required_string(value, limit);
        if !valid(args.first(), 256)
            || !valid(args.get(1), 80)
            || !args
                .get(2)
                .is_some_and(|s| s.as_str().is_some_and(|s| s.len() <= 80))
        {
            return "unavailable";
        }
        let observed=args.get(3).and_then(Value::as_array).into_iter().flatten().take(29).filter(|p|required_string(p.get("playerUid"),256)&&p["playerName"].as_str().is_some_and(|s|s.len()<=80)&&p.get("friendCode").is_none_or(|s|s.as_str().is_some_and(|s|s.len()<=80))).map(|p|json!({"playerUid":p["playerUid"],"playerName":p["playerName"],"friendCode":p["friendCode"].as_str().unwrap_or("")})).collect::<Vec<_>>();
        let payload = json!({"playerUid":args[0],"playerName":args[1],"friendCode":args[2],"observedPlayers":observed});
        let lab = self.app.try_state::<Arc<crate::voice_lab::Lab>>().is_some();
        let endpoint =
            ban_check_endpoint(lab, std::env::var("TANUKI_BAN_CHECK_URL").ok().as_deref());
        match http::post(&self.client, &endpoint, &payload)
            .ok()
            .and_then(|v| v["banned"].as_bool())
        {
            Some(true) => "banned",
            Some(false) => "clear",
            None => "unavailable",
        }
    }
    fn poll(&self) {
        let (name, pid, index) = target();
        let mut reader: Option<reader::Reader> = None;
        let mut mod_reader = mods::Live::new(
            self.resources.clone(),
            self.cosmetics.clone(),
            self.addon_link.clone(),
        );
        let mut opened = false;
        let mut last_error = String::new();
        let mut next_check = std::time::Instant::now();
        let mut failures = 0;
        while self.running.load(Ordering::Relaxed) {
            if !self.hooked.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            if self.reconnect.swap(false, Ordering::SeqCst)
                || reader.as_ref().is_some_and(|r| !r.process.alive())
            {
                reader = None;
                *self.state.lock().unwrap() = Value::Null;
                *self.info.lock().unwrap() = Value::Null;
                if opened {
                    self.emit("main", "NOTIFY_GAME_OPENED", vec![json!(false)]);
                    opened = false;
                }
                next_check = std::time::Instant::now();
            }
            if reader.is_none() && std::time::Instant::now() >= next_check {
                mod_reader.clear();
                next_check = std::time::Instant::now() + Duration::from_secs(2);
                match memory::find_process(&name, pid, index).and_then(|pid| {
                    pid.map(|pid| reader::Reader::attach(pid, &self.data, &self.client))
                        .transpose()
                }) {
                    Ok(Some(value)) => {
                        reader = Some(value);
                    }
                    Ok(None) => {
                        if opened {
                            self.emit("main", "NOTIFY_GAME_OPENED", vec![json!(false)]);
                            opened = false;
                        }
                    }
                    Err(error) => {
                        if error != last_error {
                            self.emit("main", "ERROR", vec![json!(&error)]);
                            last_error = error;
                        }
                    }
                }
            }
            if let Some(reader) = reader.as_mut() {
                match reader.read() {
                    Ok(mut state) => {
                        mod_reader.update(&reader.process, &mut state, &reader.colors);
                        if state["mod"] == "NoS" && self.windows.lock().unwrap().contains("debug") {
                            state["nosLoadedContents"] = self.cosmetics.lock().unwrap().status();
                        }
                        *self.info.lock().unwrap() = json!({"appVersion":env!("CARGO_PKG_VERSION"),"broadcastVersion":reader.broadcast_version,"offsetsVersion":reader.offsets_version,"is64bit":reader.process.x64,"platform":"win32","mod":state["mod"],"mods":mod_reader.detection().files});
                        failures = 0;
                        if !opened {
                            let generated =
                                assets::generate(&self.data, &self.resources, &reader.colors);
                            if let Err(error) = generated {
                                self.emit("main", "ERROR", vec![json!(error)]);
                                std::thread::sleep(Duration::from_secs(2));
                                continue;
                            }
                            *self.colors.lock().unwrap() = reader.colors.clone();
                            *self.info.lock().unwrap() = json!({"appVersion":env!("CARGO_PKG_VERSION"),"broadcastVersion":reader.broadcast_version,"offsetsVersion":reader.offsets_version,"is64bit":reader.process.x64,"platform":"win32","mod":state["mod"],"mods":mod_reader.detection().files});
                            self.emit("main", "NOTIFY_GAME_OPENED", vec![json!(true)]);
                            for target in ["main", "settings", "overlay"] {
                                self.emit(
                                    target,
                                    if target == "settings" {
                                        "SETTINGS_NOTIFY_PLAYER_COLORS_CHANGED"
                                    } else {
                                        "NOTIFY_PLAYERCOLORS_CHANGED"
                                    },
                                    vec![json!(reader.colors)],
                                );
                            }
                            opened = true;
                        }
                        if !last_error.is_empty() {
                            self.emit("main", "ERROR", vec![json!("")]);
                            last_error.clear();
                        }
                        let old = self.state.lock().unwrap()["gameState"].clone();
                        *self.state.lock().unwrap() = state.clone();
                        if state["gameState"] != 3 || old != 3 {
                            self.emit("main", "NOTIFY_GAME_STATE_CHANGED", vec![state]);
                        }
                    }
                    Err(error) => {
                        failures += 1;
                        if failures >= 3 && error != last_error {
                            self.emit("main", "ERROR", vec![json!(&error)]);
                            last_error = error;
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.addon_link.lock().unwrap().clear();
        keys::stop(self);
    }
}
fn required_string(value: Option<&Value>, limit: usize) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= limit)
}
fn ban_check_endpoint(lab: bool, override_url: Option<&str>) -> String {
    const OFFICIAL: &str = "https://debug-auth.kuretoshi.work/v1/player-bans/check";
    if lab {
        if let Some(raw) = override_url {
            if tauri::Url::parse(raw).is_ok_and(|url| {
                url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/v1/player-bans/check"
            }) {
                return raw.into();
            }
        }
    }
    OFFICIAL.into()
}
#[cfg(test)]
mod endpoint_tests {
    #[test]
    fn access_fixture_cannot_redirect_production_or_send_game_identity_to_an_external_host() {
        let official = super::ban_check_endpoint(false, None);
        assert_eq!(
            super::ban_check_endpoint(false, Some("http://127.0.0.1:1234/v1/player-bans/check")),
            official
        );
        assert_eq!(
            super::ban_check_endpoint(true, Some("http://example.test/v1/player-bans/check")),
            official
        );
        assert_eq!(
            super::ban_check_endpoint(
                true,
                Some("http://user@127.0.0.1:1234/v1/player-bans/check")
            ),
            official
        );
        assert_eq!(
            super::ban_check_endpoint(true, Some("http://127.0.0.1:1234/v1/player-bans/check")),
            "http://127.0.0.1:1234/v1/player-bans/check"
        );
    }
}
fn registered_scheme(scheme: &str) -> bool {
    use windows_sys::Win32::System::Registry::*;
    let key: Vec<_> = scheme.encode_utf16().chain(Some(0)).collect();
    let mut handle = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CLASSES_ROOT, key.as_ptr(), 0, KEY_READ, &mut handle) } != 0 {
        return false;
    }
    let name: Vec<u16> = "URL Protocol".encode_utf16().chain(Some(0)).collect();
    let registered = unsafe {
        RegQueryValueExW(
            handle,
            name.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
    };
    unsafe {
        RegCloseKey(handle);
    }
    registered
}
fn microsoft_store_path() -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_NO_MORE_ITEMS;
    use windows_sys::Win32::System::Registry::*;
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    let base="SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
    let path: Vec<u16> = base.encode_utf16().chain(Some(0)).collect();
    let mut key = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return None;
    }
    let key = Key(key);
    for index in 0..20000 {
        let mut name = [0u16; 512];
        let mut length = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result != 0 {
            continue;
        }
        let name = String::from_utf16(&name[..length as usize]).ok()?;
        if !name.starts_with("Innersloth.AmongUs") {
            continue;
        }
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut child = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(key.0, name.as_ptr(), 0, KEY_READ, &mut child) } != 0 {
            continue;
        }
        let child = Key(child);
        let value: Vec<u16> = "PackageRootFolder".encode_utf16().chain(Some(0)).collect();
        let mut kind = 0;
        let mut size = 0;
        if unsafe {
            RegQueryValueExW(
                child.0,
                value.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        } != 0
            || kind != REG_SZ
            || size > 65536
            || size % 2 != 0
        {
            continue;
        }
        let mut buffer = vec![0u16; size as usize / 2];
        if unsafe {
            RegQueryValueExW(
                child.0,
                value.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        } != 0
        {
            continue;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        let path = String::from_utf16(&buffer[..end]).ok()?;
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

/// A read-only integration probe, before creating any WebView. Used to compare
/// native snapshots with the release Node reader against the same live PID.
pub fn run_probe() -> bool {
    if let Some(input) = argument("--rust-cosmetic-probe") {
        let result = (|| -> Result<(), String> {
            let output = argument("--probe-output").ok_or("--probe-output is required")?;
            mods::cosmetics::probe(Path::new(&input), Path::new(&output))
        })();
        if let Err(e) = result {
            eprintln!("Cosmetic probe: {e}");
            std::process::exit(1)
        }
        return true;
    }
    if let Some(input) = argument("--rust-mod-reader-probe") {
        let result = argument("--probe-output")
            .ok_or("--probe-output required".to_string())
            .and_then(|output| mods::probe(Path::new(&input), Path::new(&output)));
        if let Err(error) = result {
            eprintln!("Mod reader probe: {error}");
            std::process::exit(1);
        }
        return true;
    }
    let Some(pid) = argument("--rust-reader-probe") else {
        return false;
    };
    let result = (|| -> Result<(), String> {
        let pid = pid.parse::<u32>().map_err(|_| "Invalid probe PID")?;
        if memory::find_process("Among Us.exe", pid, 0)? != Some(pid) {
            return Err("Probe target must be Among Us.exe".into());
        }
        let data = reader::data_directory();
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let resources = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out/tauri-backend")
        } else {
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .ok_or("Missing executable directory")?
                .join("backend")
        };
        let client = http::client()?;
        let mut reader = reader::Reader::attach(pid, &data, &client)?;
        let cosmetics = Arc::new(Mutex::new(mods::cosmetics::Cosmetics::default()));
        let link = Arc::new(Mutex::new(mods::link::Link::default()));
        let mut mod_reader = mods::Live::new(resources.clone(), cosmetics, link);
        let count = argument("--probe-samples")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(3)
            .clamp(1, 30);
        let mut states = Vec::new();
        for _ in 0..count {
            let mut state = reader.read()?;
            mod_reader.update(&reader.process, &mut state, &reader.colors);
            states.push(state);
            std::thread::sleep(Duration::from_millis(200));
        }
        assets::generate(&data, &resources, &reader.colors)?;
        let output = argument("--probe-output").ok_or("--probe-output is required")?;
        fs::write(output,serde_json::to_vec_pretty(&json!({"backend":"rust","nodeStarted":false,"pid":pid,"broadcastVersion":reader.broadcast_version,"offsetsVersion":reader.offsets_version,"colors":reader.colors,"states":states})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
    true
}
