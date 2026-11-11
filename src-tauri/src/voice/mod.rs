//! Native voice engine. Audio and networking outlive every WebView.
mod access;
mod audio;
mod bridge;
mod control;
mod cosmetics;
mod effects;
mod gate;
mod geometry;
mod lobby_browser;
mod model;
mod peer;
mod pitch;
mod preview;
mod processing;
mod quality;
mod radio;
mod recordings;
mod remote;
mod rokuro;
mod roles;
mod routing;
mod routing_probe;
mod settings;
mod signaling;
pub(crate) mod speech;

use model::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

pub fn enabled() -> bool {
    let args: Vec<_> = std::env::args().collect();
    args.iter().any(|arg| arg == "--native-voice")
        || !args.iter().any(|arg| arg == "--web-voice")
            && args
                .iter()
                .find_map(|arg| arg.strip_prefix("--backend="))
                .unwrap_or("rust")
                == "rust"
}
pub(crate) fn jackal_radio_player(player: &Value) -> bool {
    roles::jackal_team(player)
}
pub fn headless() -> bool {
    enabled() && std::env::args().any(|arg| arg == "--headless")
}

pub fn open_browser_fixture(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(address) = crate::native::argument("--voice-browser-fixture") else {
        return Ok(());
    };
    if test_config()?.is_none() {
        return Err("Browser fixture requires a synthetic local test".into());
    }
    let url = tauri::Url::parse(&address)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("Browser fixture must use loopback HTTP".into());
    }
    tauri::WebviewWindowBuilder::new(app,"voice-fixture",tauri::WebviewUrl::External(url)).title("Native voice integration fixture").visible(false)
        .additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows").build()?;
    Ok(())
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeConfig {
    server_url: String,
    game: Value,
    #[serde(default = "default_frequency")]
    frequency: f32,
    #[serde(default)]
    hardware_audio: bool,
    #[serde(default)]
    audio_processing: bool,
    #[serde(default)]
    lobby_settings: Option<Value>,
    #[serde(default)]
    steps: Vec<ProbeStep>,
    #[serde(default)]
    shared_settings: Option<Value>,
    #[serde(default)]
    context: Value,
    #[serde(default)]
    ready_before_timeline: bool,
    #[serde(default)]
    timestamp_epoch: Option<u64>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeStep {
    second: u64,
    game: Option<Value>,
    radio: Option<bool>,
    jackal_radio: Option<bool>,
}
fn default_frequency() -> f32 {
    440.0
}
fn test_config() -> Result<Option<ProbeConfig>, String> {
    let Some(path) = crate::native::argument("--voice-test-config") else {
        return Ok(None);
    };
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("Test configuration too large".into());
    }
    let config: ProbeConfig = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if config.steps.len() > 32 || config.steps.iter().any(|s| s.second > 300) {
        return Err("Too many or unbounded synthetic game steps".into());
    }
    let url = tauri::Url::parse(&config.server_url).map_err(|e| e.to_string())?;
    if !matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    ) || !config.frequency.is_finite()
        || !(100.0..=3000.0).contains(&config.frequency)
    {
        return Err("Synthetic voice tests only use a loopback signaling server".into());
    }
    Ok(Some(config))
}

pub struct Service {
    lobbies: lobby_browser::Browser,
    prefs: watch::Sender<Preferences>,
    game: watch::Sender<Value>,
    stop: watch::Sender<bool>,
    controls: Arc<Controls>,
    status: Arc<Mutex<Status>>,
    metrics: Arc<Metrics>,
    path: Option<PathBuf>,
    synthetic: bool,
    shared: watch::Sender<Value>,
}
impl Service {
    pub fn start(app: &AppHandle, mut shared: Value) -> Result<Arc<Self>, String> {
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("native-voice.json");
        let config = test_config()?;
        let mut prefs = settings::preferences(&shared);
        if path.exists() && config.is_none() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            prefs =
                settings::load(&prefs, &bytes).map_err(|e| format!("native-voice.json: {e}"))?;
        }
        if let Some(config) = &config {
            prefs = settings::preferences(config.shared_settings.as_ref().unwrap_or(&Value::Null));
            prefs.server_url = config.server_url.clone();
            prefs.echo_cancellation = config.audio_processing;
            prefs.noise_suppression = config.audio_processing;
            prefs.auto_gain_control = config.audio_processing;
            if config.hardware_audio {
                prefs.volume = 0.0;
            }
        }
        prefs.validate()?;
        let lab = app.try_state::<Arc<crate::voice_lab::Lab>>();
        if let Some(lab) = &lab {
            if config.is_some() {
                return Err("Live and synthetic game inputs cannot be combined".into());
            }
            shared = lab.settings(shared);
            prefs = Preferences {
                server_url: lab.server_url().into(),
                volume: 0.0,
                echo_cancellation: shared["echoCancellation"] == true,
                noise_suppression: shared["noiseSuppression"] == true,
                auto_gain_control: shared["autoGainControl"] == true,
                ..Default::default()
            };
        }
        let service = Self::spawn(
            prefs,
            shared,
            config.clone(),
            if config.is_none() && lab.is_none() {
                Some(path)
            } else {
                None
            },
            Some(app.clone()),
        )?;
        if config.is_some() {
            if let Some(seconds) = crate::native::argument("--voice-test-seconds")
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| (5..=300).contains(n))
            {
                let app = app.clone();
                let owned = service.clone();
                let config = config.clone().unwrap();
                let close_after = crate::native::argument("--voice-test-close-after")
                    .and_then(|s| s.parse::<u64>().ok());
                std::thread::spawn(move || {
                    let mut progress = Vec::new();
                    for second in 0..seconds {
                        owned.apply_probe_steps(second, &config);
                        std::thread::sleep(Duration::from_secs(1));
                        progress.push(json!({"second":second+1,"openWebviews":app.webview_windows().len(),"metrics":owned.metrics.json()}));
                        if close_after == Some(second + 1) {
                            let handle = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                for window in handle.webview_windows().into_values() {
                                    let _ = window.destroy();
                                }
                            });
                        }
                    }
                    if let Some(path) = crate::native::argument("--voice-test-output") {
                        let mut report = owned.snapshot();
                        report["openWebviews"] = json!(app.webview_windows().len());
                        report["progress"] = json!(progress);
                        let _ = fs::write(path, serde_json::to_vec_pretty(&report).unwrap());
                    }
                    app.exit(0);
                });
            }
        }
        Ok(service)
    }
    fn spawn(
        prefs: Preferences,
        mut shared: Value,
        config: Option<ProbeConfig>,
        path: Option<PathBuf>,
        app: Option<AppHandle>,
    ) -> Result<Arc<Self>, String> {
        if config.is_some() {
            shared = config
                .as_ref()
                .and_then(|c| c.shared_settings.clone())
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            shared["myLobbySettings"] = config
                .as_ref()
                .and_then(|c| c.lobby_settings.clone())
                .unwrap_or_else(|| json!({"maxDistance":5.32}));
        }
        let (prefs, prefs_rx) = watch::channel(prefs);
        let (game, game_rx) = watch::channel(
            config
                .as_ref()
                .map(|c| c.game.clone())
                .unwrap_or(Value::Null),
        );
        let (stop, stop_rx) = watch::channel(false);
        let (shared, shared_rx) = watch::channel(shared);
        let service = Arc::new(Self {
            lobbies: lobby_browser::Browser::start(app.clone(), prefs_rx.clone()),
            prefs,
            game,
            stop,
            controls: Arc::new(Controls::default()),
            status: Arc::new(Mutex::new(Status::default())),
            metrics: Arc::new(Metrics::default()),
            path,
            synthetic: config.is_some(),
            shared,
        });
        let engine = signaling::Engine {
            prefs: prefs_rx,
            game: game_rx,
            stop: stop_rx,
            controls: service.controls.clone(),
            metrics: service.metrics.clone(),
            status: service.status.clone(),
            shared: shared_rx,
            synthetic: config.as_ref().is_some_and(|config| !config.hardware_audio),
            frequency: config.as_ref().map(|c| c.frequency).unwrap_or(440.0),
            app,
            initial_context: config
                .as_ref()
                .map(|c| c.context.clone())
                .unwrap_or(Value::Null),
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("native-voice".into())
            .spawn(move || {
                runtime.block_on(engine.run());
                runtime.shutdown_timeout(Duration::from_secs(2));
            })
            .map_err(|e| e.to_string())?;
        Ok(service)
    }
    pub fn backend_event(&self, channel: &str, args: &[Value]) {
        match channel {
            "NOTIFY_GAME_STATE_CHANGED" if !self.synthetic => {
                self.game
                    .send_replace(args.first().cloned().unwrap_or(Value::Null));
            }
            "NOTIFY_GAME_OPENED" => {
                let opened = args.first() == Some(&json!(true));
                self.status.lock().unwrap().game_open = opened;
                if !opened && !self.synthetic {
                    self.game.send_replace(Value::Null);
                }
            }
            "ERROR" => {
                let error = args.first().and_then(Value::as_str).unwrap_or("");
                self.status.lock().unwrap().game_error = error.into();
                if !error.is_empty() && !self.synthetic {
                    self.game.send_replace(Value::Null);
                }
            }
            "TOGGLE_MUTE" => {
                if self.controls.deafened.swap(false, Ordering::Relaxed) {
                    self.controls.muted.store(false, Ordering::Relaxed);
                } else {
                    self.controls.muted.fetch_xor(true, Ordering::Relaxed);
                }
            }
            "TOGGLE_DEAFEN" => {
                self.controls.deafened.fetch_xor(true, Ordering::Relaxed);
            }
            "PUSH_TO_TALK" => {
                self.controls
                    .ptt
                    .store(args.first() == Some(&json!(true)), Ordering::Relaxed);
            }
            "IMPOSTOR_RADIO" | "JACKAL_RADIO" => {
                let pressed = args.first() == Some(&json!(true));
                let kind = if channel == "JACKAL_RADIO" { 1 } else { 0 };
                let (current, other) = if kind == 0 {
                    (&self.controls.radio, &self.controls.jackal_radio)
                } else {
                    (&self.controls.jackal_radio, &self.controls.radio)
                };
                current.store(pressed, Ordering::Relaxed);
                if pressed {
                    self.controls.radio_kind.store(kind, Ordering::Relaxed);
                } else if self.controls.radio_kind.load(Ordering::Relaxed) == kind
                    && other.load(Ordering::Relaxed)
                {
                    self.controls.radio_kind.store(1 - kind, Ordering::Relaxed);
                }
            }
            "settings:changed" if !self.synthetic => {
                if let Some(next) = args.first().filter(|v| v.is_object()) {
                    let before = self.shared.borrow().clone();
                    let previous_prefs = self.prefs.borrow().clone();
                    match settings::changed(&previous_prefs, &before, next) {
                        Ok(prefs) => {
                            self.shared.send_replace(next.clone());
                            if previous_prefs != prefs {
                                if let Err(error) = self.persist(&prefs) {
                                    self.status.lock().unwrap().error = error;
                                }
                                self.prefs.send_replace(prefs);
                            }
                        }
                        Err(error) => self.status.lock().unwrap().error = error,
                    }
                }
            }
            _ => {}
        }
    }
    fn apply_probe_steps(&self, second: u64, config: &ProbeConfig) {
        for step in config.steps.iter().filter(|s| s.second == second) {
            if let Some(game) = &step.game {
                self.game.send_replace(game.clone());
            }
            if let Some(radio) = step.radio {
                self.controls.radio.store(radio, Ordering::Relaxed);
                if radio {
                    self.controls.radio_kind.store(0, Ordering::Relaxed);
                } else if self.controls.jackal_radio.load(Ordering::Relaxed) {
                    self.controls.radio_kind.store(1, Ordering::Relaxed);
                }
            }
            if let Some(radio) = step.jackal_radio {
                self.controls.jackal_radio.store(radio, Ordering::Relaxed);
                if radio {
                    self.controls.radio_kind.store(1, Ordering::Relaxed);
                } else if self.controls.radio.load(Ordering::Relaxed) {
                    self.controls.radio_kind.store(0, Ordering::Relaxed);
                }
            }
        }
    }
    pub fn stop(&self) {
        self.lobbies.stop();
        self.stop.send_replace(true);
        self.controls.joined.store(false, Ordering::Relaxed);
    }
    pub fn snapshot(&self) -> Value {
        let state = self.game.borrow();
        let shared = self.shared.borrow();
        let players: Vec<_> = state["players"].as_array().into_iter().flatten().filter(|p| !flag(p,"isLocal") && !flag(p,"disconnected") && !flag(p,"isDummy")).map(|p| {
            let config = player_config(&shared,p);
            let dead=p["clientId"].as_i64().is_some_and(|id|self.status.lock().unwrap().voice_snapshot["otherDead"][id.to_string()]==true);
            json!({"clientId":p["clientId"],"name":p["name"].as_str().unwrap_or("Player"),"isDead":dead,"volume":number(config,"volume",1.0),"isMuted":flag(config,"isMuted")})
        }).collect();
        json!({"nativeVoice":true,"synthetic":self.synthetic,"status":*self.status.lock().unwrap(),"preferences":*self.prefs.borrow(),"players":players,"hideCode":flag(&shared,"hideCode"),"isHost":state["isHost"],"muted":self.controls.muted.load(Ordering::Relaxed),"deafened":self.controls.deafened.load(Ordering::Relaxed),"transmitting":self.controls.transmitting(self.prefs.borrow().push_to_talk_mode),"microphoneRms":f32::from_bits(self.controls.microphone_rms.load(Ordering::Relaxed)),"metrics":self.metrics.json()})
    }
    fn persist(&self, prefs: &Preferences) -> Result<(), String> {
        if let Some(path) = &self.path {
            let temporary = path.with_extension("json.tmp");
            fs::write(
                &temporary,
                serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(temporary, path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn request(&self, action: &str, value: Value) -> Result<Value, String> {
        match action {
            "status" => Ok(self.snapshot()),
            "devices" => audio::devices(),
            "remote-enable" => {
                self.controls
                    .remote
                    .lock()
                    .unwrap()
                    .enable(&self.game.borrow())?;
                self.controls.remote_input.store(true, Ordering::Relaxed);
                Ok(Value::Null)
            }
            "remote-disable" => {
                self.controls.remote.lock().unwrap().disable();
                self.controls.remote_input.store(false, Ordering::Relaxed);
                Ok(Value::Null)
            }
            "effect-preview" => {
                self.controls.preview.lock().unwrap().configure(&value)?;
                Ok(Value::Null)
            }
            "radio" | "jackal-radio" => {
                (if action == "radio" {
                    &self.controls.radio
                } else {
                    &self.controls.jackal_radio
                })
                .store(
                    value.as_bool().ok_or("Invalid radio state")?,
                    Ordering::Relaxed,
                );
                if value == true {
                    self.controls
                        .radio_kind
                        .store(if action == "radio" { 0 } else { 1 }, Ordering::Relaxed);
                }
                Ok(self.snapshot())
            }
            "speaker-test" => {
                self.controls.speaker_test.store(
                    if value.as_bool().ok_or("Invalid test state")? {
                        audio::CHIME_FRAMES as u64
                    } else {
                        0
                    },
                    Ordering::Relaxed,
                );
                Ok(Value::Null)
            }
            "mute" => {
                let muted = value.as_bool().ok_or("Invalid mute state")?;
                self.controls.muted.store(muted, Ordering::Relaxed);
                if !muted {
                    self.controls.deafened.store(false, Ordering::Relaxed);
                }
                Ok(self.snapshot())
            }
            "deafen" => {
                self.controls.deafened.store(
                    value.as_bool().ok_or("Invalid deafen state")?,
                    Ordering::Relaxed,
                );
                Ok(self.snapshot())
            }
            "configure" => {
                let prefs: Preferences =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                prefs.validate()?;
                if self.synthetic {
                    return Err("Synthetic tests do not modify voice settings".into());
                }
                self.persist(&prefs)?;
                if self.prefs.borrow().requires_restart(&prefs) {
                    self.controls.joined.store(false, Ordering::Relaxed);
                }
                self.prefs.send_replace(prefs);
                Ok(self.snapshot())
            }
            _ => Err("Unknown native voice action".into()),
        }
    }
}

#[tauri::command]
pub async fn native_voice(app: AppHandle, action: String, value: Value) -> Result<Value, String> {
    if !enabled() {
        return Err("Native voice mode is not active".into());
    }
    if action == "background" {
        let keep_overlay = app
            .try_state::<Arc<Service>>()
            .is_some_and(|service| flag(&service.shared.borrow(), "enableOverlay"));
        for window in app.webview_windows().into_values() {
            if keep_overlay && window.label() == "overlay" {
                continue;
            }
            window.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(Value::Null);
    }
    if action == "quit" {
        app.exit(0);
        return Ok(Value::Null);
    }
    let service = app.state::<Arc<Service>>().inner().clone();
    if action == "lobby-browser" {
        let game = service.game.borrow().clone();
        return service.lobbies.request(&value, &game).await;
    }
    if action == "open-settings" {
        app.state::<Arc<crate::Backend>>()
            .inner()
            .clone()
            .request("main", "OPEN_SETTINGS", vec![], "invoke")
            .await?;
        return Ok(service.snapshot());
    }
    if action == "player" {
        if service.synthetic {
            return Err("Synthetic tests do not modify player settings".into());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct PlayerSetting {
            client_id: i64,
            volume: f64,
            is_muted: bool,
        }
        let setting: PlayerSetting = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if !setting.volume.is_finite() || !(0.0..=2.0).contains(&setting.volume) {
            return Err("Invalid player volume".into());
        }
        let key = {
            let state = service.game.borrow();
            let player = state["players"]
                .as_array()
                .and_then(|ps| {
                    ps.iter().find(|p| {
                        p["clientId"].as_i64() == Some(setting.client_id) && !flag(p, "isLocal")
                    })
                })
                .ok_or("Player is no longer present")?;
            player["playerConfigId"]
                .as_i64()
                .ok_or("Player configuration is not ready")?
        };
        app.state::<Arc<crate::Backend>>()
            .inner()
            .clone()
            .request(
                "main",
                "settings:set",
                vec![
                    json!(format!("playerConfigMap.{key}")),
                    json!({"volume":setting.volume,"isMuted":setting.is_muted}),
                ],
                "invoke",
            )
            .await?;
        return Ok(service.snapshot());
    }
    tauri::async_runtime::spawn_blocking(move || service.request(&action, value))
        .await
        .map_err(|e| e.to_string())?
}

/// A deterministic local integration harness. No game input, microphone,
/// speaker, public signaling service, or WebView is involved in this mode.
pub fn run_probe() -> bool {
    if std::env::args().any(|a| a == "--voice-speech-probe") {
        let result = (|| -> Result<(), String> {
            let root = crate::native::argument("--speech-resources")
                .ok_or("--speech-resources is required")?;
            let output = crate::native::argument("--voice-test-output")
                .ok_or("--voice-test-output is required")?;
            let pcm = crate::native::argument("--speech-pcm");
            let report = speech::probe(
                std::path::Path::new(&root),
                pcm.as_deref().map(std::path::Path::new),
            )?;
            fs::write(output, serde_json::to_vec_pretty(&report).unwrap())
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result {
            eprintln!("Native speech probe: {e}");
            std::process::exit(1)
        }
        return true;
    }
    if std::env::args().any(|a| a == "--voice-effect-probe") {
        let result = (|| -> Result<(), String> {
            let input = crate::native::argument("--voice-test-config")
                .ok_or("--voice-test-config is required")?;
            let output = crate::native::argument("--voice-test-output")
                .ok_or("--voice-test-output is required")?;
            effects::probe(std::path::Path::new(&input), std::path::Path::new(&output))
        })();
        if let Err(error) = result {
            eprintln!("Voice effect probe: {error}");
            std::process::exit(1);
        }
        return true;
    }
    if std::env::args().any(|a| a == "--voice-routing-probe") {
        let result = (|| -> Result<(), String> {
            let input = crate::native::argument("--voice-test-config")
                .ok_or("--voice-test-config is required")?;
            let output = crate::native::argument("--voice-test-output")
                .ok_or("--voice-test-output is required")?;
            routing_probe::run(std::path::Path::new(&input), std::path::Path::new(&output))
        })();
        if let Err(error) = result {
            eprintln!("Native routing probe: {error}");
            std::process::exit(1);
        }
        return true;
    }
    if std::env::args().any(|a| a == "--voice-processing-probe") {
        let result = processing::diagnostics().and_then(|report| {
            let path = crate::native::argument("--voice-test-output")
                .ok_or("--voice-test-output is required")?;
            fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())
        });
        if let Err(error) = result {
            eprintln!("Native speech processing probe: {error}");
            std::process::exit(1);
        }
        return true;
    }
    if std::env::args().any(|a| a == "--voice-device-probe") {
        let result = (|| -> Result<(), String> {
            let prefs = Preferences::default();
            let mixer = Arc::new(Mutex::new(audio::Mixer::default()));
            let controls = Arc::new(Controls::default());
            let metrics = Arc::new(Metrics::default());
            let (tx, mut rx) = tokio::sync::mpsc::channel(8);
            let (errors, mut error_rx) = tokio::sync::mpsc::channel(4);
            let audio =
                audio::Audio::start(&prefs, mixer, controls, metrics.clone(), tx, errors, false)?;
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                while rx.try_recv().is_ok() {}
                if let Ok(error) = error_rx.try_recv() {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let report = json!({"passed":metrics.captured.load(Ordering::Relaxed)>RATE as u64&&metrics.rendered.load(Ordering::Relaxed)>RATE as u64,"microphone":audio.input_name,"speaker":audio.output_name,"metrics":metrics.json(),"networkUsed":false,"audioSaved":false});
            let path = crate::native::argument("--voice-test-output")
                .ok_or("--voice-test-output is required")?;
            fs::write(path, serde_json::to_vec_pretty(&report).unwrap())
                .map_err(|e| e.to_string())?;
            if report["passed"] != true {
                return Err("Native device callbacks were not received".into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Native audio device probe: {error}");
            std::process::exit(1);
        }
        return true;
    }
    if !std::env::args().any(|a| a == "--native-voice-probe") {
        return false;
    }
    let result = (|| -> Result<(), String> {
        let mut config = test_config()?.ok_or("--voice-test-config is required")?;
        let seconds = crate::native::argument("--voice-test-seconds")
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| (5..=300).contains(s))
            .unwrap_or(20);
        let prefs = Preferences {
            server_url: config.server_url.clone(),
            echo_cancellation: config.audio_processing,
            noise_suppression: config.audio_processing,
            auto_gain_control: config.audio_processing,
            volume: if config.hardware_audio { 0.0 } else { 1.0 },
            ..settings::preferences(config.shared_settings.as_ref().unwrap_or(&Value::Null))
        };
        prefs.validate()?;
        let service = Service::spawn(
            prefs,
            json!({"myLobbySettings":{"maxDistance":5.32}}),
            Some(config.clone()),
            None,
            None,
        )?;
        if config.ready_before_timeline {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            while service.status.lock().unwrap().peers < 1 {
                if std::time::Instant::now() >= deadline {
                    return Err("Fixture peers did not connect before the timeline".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if let Some(epoch) = config.timestamp_epoch {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let delta = now as i64 - epoch as i64;
                let shift = |state: &mut Value| {
                    for channel in [
                        "nosDyingVoices",
                        "nosMegaphones",
                        "nosInterviews",
                        "nosParrots",
                        "nosBibiriEchoes",
                    ] {
                        for row in state[channel].as_array_mut().into_iter().flatten() {
                            for key in ["started", "stopped", "playStarted", "unixMs"] {
                                if let Some(stamp) = row[key].as_u64().filter(|n| *n > 0) {
                                    row[key] = json!(stamp.saturating_add_signed(delta));
                                }
                            }
                        }
                    }
                };
                shift(&mut config.game);
                for step in &mut config.steps {
                    if let Some(game) = &mut step.game {
                        shift(game);
                    }
                }
                service.game.send_replace(config.game.clone());
            }
        }
        let mut progress = Vec::new();
        for second in 0..seconds {
            service.apply_probe_steps(second, &config);
            std::thread::sleep(Duration::from_secs(1));
            let status = service.status.lock().unwrap().clone();
            progress.push(json!({"second":second+1,"metrics":service.metrics.json(),"radioActive":status.radio_active,"radioClients":status.radio_clients}));
        }
        service.stop();
        let output = crate::native::argument("--voice-test-output")
            .ok_or("--voice-test-output is required")?;
        let mut report = service.snapshot();
        report["progress"] = json!(progress);
        fs::write(
            output,
            serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Native voice probe: {error}");
        std::process::exit(1);
    }
    true
}
