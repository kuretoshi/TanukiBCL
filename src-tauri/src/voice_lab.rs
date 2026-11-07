//! Explicit, local-only live-game validation. Never injects game state or
//! persists preferences. Reports contain counters rather than audio/identities.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    server_url: String,
    output: PathBuf,
    duration_seconds: u64,
    close_after_seconds: Option<u64>,
    #[serde(default)]
    audio_processing: bool,
}
pub struct Lab {
    config: Config,
    game: Mutex<Value>,
    web: Mutex<Value>,
}
impl Lab {
    pub fn load() -> Result<Option<Arc<Self>>, String> {
        let Some(path) = crate::native::argument("--voice-lab-config") else {
            return Ok(None);
        };
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > 8192 {
            return Err("Lab configuration too large".into());
        }
        let config: Config = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate(&config)?;
        Ok(Some(Arc::new(Self {
            config,
            game: Mutex::new(Value::Null),
            web: Mutex::new(Value::Null),
        })))
    }
    pub fn server_url(&self) -> &str {
        &self.config.server_url
    }
    pub fn settings(&self, mut settings: Value) -> Value {
        for (key, value) in self.overrides().as_object().unwrap() {
            settings[key] = value.clone();
        }
        settings
    }
    pub fn overrides(&self) -> Value {
        json!({"serverURL":self.config.server_url,"microphone":"Default","speaker":"Default","masterVolume":0,"microphoneGain":100,"microphoneGainEnabled":false,"micSensitivityEnabled":false,"enableSpatialAudio":true,"pushToTalkMode":0,"echoCancellation":self.config.audio_processing,"noiseSuppression":self.config.audio_processing,"autoGainControl":self.config.audio_processing,"enableOverlay":false,"obsOverlay":false,"mobileHost":false,"myLobbySettings":{"maxDistance":5.32,"haunting":false,"commsSabotage":false,"voiceEffectEnabled":false,"deadOnly":false,"wallsBlockAudio":false,"hearThroughCameras":false,"visionHearing":false,"meetingGhostOnly":false,"impostorRadioEnabled":false,"impostorRadioOnlyMode":false}})
    }
    pub fn observe_game(&self, channel: &str, args: &[Value]) {
        match channel {
            "NOTIFY_GAME_STATE_CHANGED" => {
                let state = args.first().unwrap_or(&Value::Null);
                *self.game.lock().unwrap() = summarize_game(state);
            }
            "NOTIFY_GAME_OPENED" if args.first() == Some(&json!(false)) => {
                *self.game.lock().unwrap() = Value::Null;
            }
            _ => {}
        }
    }
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        let owned = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut progress = Vec::with_capacity(owned.config.duration_seconds as usize);
            for second in 1..=owned.config.duration_seconds {
                std::thread::sleep(Duration::from_secs(1));
                let native = app
                    .try_state::<Arc<crate::voice::Service>>()
                    .map(|v| v.snapshot());
                let voice = if let Some(native) = native {
                    json!({"engine":"native","connected":native["status"]["connected"],"audioReady":native["status"]["audioReady"],"peers":native["status"]["peers"],"hasError":native["status"]["error"].as_str().is_some_and(|s|!s.is_empty()),"muted":native["muted"],"deafened":native["deafened"],"metrics":native["metrics"]})
                } else {
                    owned.web.lock().unwrap().clone()
                };
                progress.push(json!({"second":second,"game":*owned.game.lock().unwrap(),"voice":voice,"openWebviews":app.webview_windows().len()}));
                if owned.config.close_after_seconds == Some(second) && crate::voice::enabled() {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        for window in handle.webview_windows().into_values() {
                            let _ = window.destroy();
                        }
                    });
                }
            }
            let report = json!({"version":env!("CARGO_PKG_VERSION"),"gameInjected":false,"hardwareAudio":true,"audioSaved":false,"publicServerUsed":false,"openWebviews":app.webview_windows().len(),"progress":progress});
            if let Err(error) = fs::write(
                &owned.config.output,
                serde_json::to_vec_pretty(&report).unwrap(),
            ) {
                eprintln!("Voice lab output: {error}");
            }
            app.exit(0);
        });
    }
}
fn validate(config: &Config) -> Result<(), String> {
    let url = tauri::Url::parse(&config.server_url).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || !matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]")
        )
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Live game validation only connects to a loopback HTTP server".into());
    }
    if !(5..=300).contains(&config.duration_seconds)
        || config
            .close_after_seconds
            .is_some_and(|s| s == 0 || s >= config.duration_seconds)
    {
        return Err("Invalid lab duration".into());
    }
    Ok(())
}
fn summarize_game(state: &Value) -> Value {
    json!({"gameState":state["gameState"],"players":state["players"].as_array().map(Vec::len).unwrap_or(0),"localPlayer":state["players"].as_array().is_some_and(|p|p.iter().any(|p|p["isLocal"]==true)),"mod":state["mod"],"map":state["map"]})
}

#[tauri::command]
pub fn voice_lab(app: AppHandle, action: String, value: Value) -> Result<Value, String> {
    let Some(lab) = app.try_state::<Arc<Lab>>() else {
        return Err("Live game validation is not active".into());
    };
    match action.as_str() {
        "config" => Ok(lab.overrides()),
        "report" => {
            let mut data = json!({"engine":"web","connected":value["connected"]==true,"audioReady":value["audioReady"]==true,"peers":value["peers"].as_u64().unwrap_or(0).min(29),"hasError":value["hasError"]==true,"muted":value["muted"]==true,"deafened":value["deafened"]==true,"metrics":{}});
            for key in [
                "sentPackets",
                "receivedPackets",
                "bytesSent",
                "bytesReceived",
                "totalSamplesReceived",
                "concealedSamples",
            ] {
                data["metrics"][key] = json!(value["metrics"][key].as_u64().unwrap_or(0));
            }
            *lab.web.lock().unwrap() = data;
            Ok(Value::Null)
        }
        _ => Err("Invalid live game validation action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lab_rejects_external_servers_and_unbounded_runs() {
        let mut c = Config {
            server_url: "http://127.0.0.1:4000".into(),
            output: "out.json".into(),
            duration_seconds: 100,
            close_after_seconds: Some(50),
            audio_processing: false,
        };
        assert!(validate(&c).is_ok());
        c.server_url = "https://example.com".into();
        assert!(validate(&c).is_err());
        c.server_url = "http://127.0.0.1:4000".into();
        c.duration_seconds = 301;
        assert!(validate(&c).is_err());
    }
    #[test]
    fn game_reports_do_not_contain_player_identity() {
        let summary = summarize_game(
            &json!({"gameState":1,"players":[{"isLocal":true,"name":"PRIVATE","friendCode":"SECRET"}],"lobbyCode":"PRIVATE","mod":"NONE","map":4}),
        );
        let text = summary.to_string();
        assert!(!text.contains("PRIVATE") && !text.contains("SECRET"));
        assert_eq!(summary["players"], 1);
    }
}
