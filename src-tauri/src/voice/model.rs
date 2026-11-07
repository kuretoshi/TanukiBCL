use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};

pub const RATE: u32 = 48_000;
pub const FRAME: usize = 960;
pub const MAX_PEERS: usize = 29;
pub const QUEUE_FRAMES: usize = FRAME * 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub server_url: String,
    pub microphone: String,
    pub speaker: String,
    pub volume: f32,
    pub microphone_gain: f32,
    pub microphone_gain_enabled: bool,
    pub mic_sensitivity: f32,
    pub mic_sensitivity_enabled: bool,
    pub spatial_audio: bool,
    pub push_to_talk_mode: u8,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            server_url: "https://bettercrewl.ink".into(),
            microphone: String::new(),
            speaker: String::new(),
            volume: 1.0,
            microphone_gain: 1.0,
            microphone_gain_enabled: false,
            mic_sensitivity: 0.15,
            mic_sensitivity_enabled: false,
            spatial_audio: true,
            push_to_talk_mode: 0,
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain_control: true,
        }
    }
}
impl Preferences {
    pub fn requires_restart(&self, next: &Self) -> bool {
        self.server_url != next.server_url
            || self.microphone != next.microphone
            || self.speaker != next.speaker
            || self.echo_cancellation != next.echo_cancellation
            || self.noise_suppression != next.noise_suppression
            || self.auto_gain_control != next.auto_gain_control
            || self.push_to_talk_mode != next.push_to_talk_mode
    }
    pub fn validate(&self) -> Result<(), String> {
        let url = tauri::Url::parse(&self.server_url).map_err(|_| "通話サーバーのURLが不正です")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("通話サーバーは http(s)://ホスト[:ポート] を指定してください".into());
        }
        if self.server_url.len() > 2048
            || self.microphone.len() > 1024
            || self.speaker.len() > 1024
            || !self.volume.is_finite()
            || !(0.0..=2.0).contains(&self.volume)
            || !self.microphone_gain.is_finite()
            || !(0.0..=4.0).contains(&self.microphone_gain)
            || self.push_to_talk_mode > 2
            || !self.mic_sensitivity.is_finite()
            || !(0.0..=1.0).contains(&self.mic_sensitivity)
        {
            return Err("音声設定が範囲外です".into());
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Controls {
    pub microphone_rms: AtomicU32,
    pub muted: AtomicBool,
    pub deafened: AtomicBool,
    pub ptt: AtomicBool,
    pub joined: AtomicBool,
    pub peers_ready: AtomicBool,
    pub radio: AtomicBool,
    pub jackal_radio: AtomicBool,
    pub radio_kind: AtomicI32,
    pub radio_pending: AtomicBool,
    pub game_muted: AtomicBool,
    pub speaker_test: AtomicU64,
    pub radio_cue: AtomicU64,
    pub preview: std::sync::Mutex<super::preview::Preview>,
    pub remote: std::sync::Mutex<super::remote::Remote>,
    pub remote_input: AtomicBool,
}
impl Controls {
    pub fn transmitting(&self, mode: u8) -> bool {
        !self.muted.load(Ordering::Relaxed)
            && !self.remote_input.load(Ordering::Relaxed)
            && !self.radio_pending.load(Ordering::Relaxed)
            && !self.game_muted.load(Ordering::Relaxed)
            && !self.deafened.load(Ordering::Relaxed)
            && self.joined.load(Ordering::Relaxed)
            && match mode {
                1 => self.ptt.load(Ordering::Relaxed),
                2 => !self.ptt.load(Ordering::Relaxed),
                _ => true,
            }
    }
}

#[derive(Default)]
pub struct Metrics {
    pub captured: AtomicU64,
    pub sent: AtomicU64,
    pub received: AtomicU64,
    pub decoded: AtomicU64,
    pub rendered: AtomicU64,
    pub concealed: AtomicU64,
    pub dropped: AtomicU64,
    pub output_energy: AtomicU64,
    pub processed: AtomicU64,
    pub reference: AtomicU64,
    pub capture_overruns: AtomicU64,
    pub reference_overruns: AtomicU64,
    pub playback_underruns: AtomicU64,
    pub device_capture_xruns: AtomicU64,
    pub device_playback_xruns: AtomicU64,
    pub processing_nanos: AtomicU64,
    pub processing_blocks: AtomicU64,
}
impl Metrics {
    pub fn json(&self) -> Value {
        let get = |v: &AtomicU64| v.load(Ordering::Relaxed);
        json!({"capturedFrames":get(&self.captured),"sentPackets":get(&self.sent),"receivedPackets":get(&self.received),"decodedFrames":get(&self.decoded),"renderedFrames":get(&self.rendered),"concealedPackets":get(&self.concealed),"droppedFrames":get(&self.dropped),"outputEnergy":get(&self.output_energy),"processedFrames":get(&self.processed),"renderReferenceFrames":get(&self.reference),"captureOverruns":get(&self.capture_overruns),"referenceOverruns":get(&self.reference_overruns),"playbackUnderruns":get(&self.playback_underruns),"deviceCaptureXruns":get(&self.device_capture_xruns),"devicePlaybackXruns":get(&self.device_playback_xruns),"processingNanos":get(&self.processing_nanos),"processingBlocks":get(&self.processing_blocks)})
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub access_status: String,
    pub connected: bool,
    pub audio_ready: bool,
    pub game_open: bool,
    pub lobby: String,
    pub peers: usize,
    pub error: String,
    pub game_error: String,
    pub microphone_name: String,
    pub speaker_name: String,
    pub talking: bool,
    pub game_state: Option<i64>,
    pub radio_active: bool,
    pub radio_available: bool,
    pub jackal_radio_available: bool,
    pub radio_clients: Vec<i64>,
    pub vad_hidden: bool,
    pub voice_snapshot: Value,
    pub input_level: f32,
    pub effective_game: Value,
}

pub fn flag(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}
pub fn number(v: &Value, key: &str, default: f64) -> f64 {
    v[key].as_f64().filter(|n| n.is_finite()).unwrap_or(default)
}

pub fn local(state: &Value) -> Option<&Value> {
    state["players"]
        .as_array()?
        .iter()
        .find(|p| flag(p, "isLocal") && !flag(p, "disconnected"))
}
pub fn player_config<'a>(shared: &'a Value, player: &Value) -> &'a Value {
    let config =
        &shared["playerConfigMap"][player["playerConfigId"].as_i64().unwrap_or(0).to_string()];
    if config.is_null() {
        &shared["playerConfigMap"][player["nameHash"].as_i64().unwrap_or(0).to_string()]
    } else {
        config
    }
}
pub fn join_identity(state: &Value) -> Option<Value> {
    if ![0, 1, 2].contains(&state["gameState"].as_i64()?) {
        return None;
    }
    let me = local(state)?;
    let lobby = state["lobbyCode"].as_str()?;
    if lobby.is_empty() || lobby == "MENU" || lobby.len() > 32 {
        return None;
    }
    Some(
        json!({"lobby":lobby,"playerId":me["id"],"clientId":me["clientId"],"isHost":state["isHost"],"friendCode":me["friendCode"].as_str().unwrap_or(""),"playerUid":me["playerUid"].as_str().unwrap_or(""),"playerIdentifier":me["playerIdentifier"].as_str().unwrap_or("")}),
    )
}

/// Vanilla route gain. Effects and radio metadata are consumed by the mixer.
#[cfg(test)]
pub fn gains(
    state: &Value,
    other_client: i64,
    rules: &Value,
    prefs: &Preferences,
    shared: &Value,
) -> [f32; 2] {
    super::routing::route(state, other_client, rules, prefs, shared, &[]).gains
}
/// Same radius rule as voiceHearingDistance in the pinned release. Vision is
/// listener-specific: impostors retain the lobby radius, including during lights.
pub fn hearing_distance(state: &Value, rules: &Value, me: &Value) -> Option<f64> {
    let nos_neutral =
        state["mod"] == "NoS" && (me["nosPlayer"]["isNeutral"] == true || flag(me, "isThirdParty"));
    let max = if flag(rules, "visionHearing") && !nos_neutral && !super::roles::impostor(state, me)
    {
        state["lightRadius"].as_f64().filter(|v| v.is_finite())? + 0.5
    } else {
        number(rules, "maxDistance", 5.32)
    };
    Some(if max <= 0.6 { 1.0 } else { max })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_volume_and_gate_edits_keep_the_existing_audio_session() {
        let before = Preferences::default();
        let mut next = before.clone();
        next.volume = 0.3;
        next.microphone_gain = 0.5;
        next.mic_sensitivity = 0.2;
        next.spatial_audio = false;
        assert!(!before.requires_restart(&next));
        next.speaker = "another device".into();
        assert!(before.requires_restart(&next));
        next = before.clone();
        next.echo_cancellation = false;
        assert!(before.requires_restart(&next));
    }
    fn state() -> Value {
        json!({"mod":"NONE","gameState":1,"lobbyCode":"TEST","players":[{"id":0,"clientId":1,"isLocal":true,"x":0,"y":0},{"id":1,"clientId":2,"x":1,"y":0}]})
    }
    #[test]
    fn life_and_meeting_rules_fail_closed() {
        let mut s = state();
        let p = Preferences::default();
        let r = json!({"maxDistance":5.32});
        let shared = json!({});
        assert!(gains(&s, 2, &r, &p, &shared)[1] > 0.5);
        s["players"][1]["isDead"] = json!(true);
        assert_eq!(gains(&s, 2, &r, &p, &shared), [0.0; 2]);
        s["players"][0]["isDead"] = json!(true);
        assert!(gains(&s, 2, &r, &p, &shared)[1] > 0.5);
        s["gameState"] = json!(2);
        let centered = ((1.0 - 0.4 / (5.32 - 0.1)) * std::f64::consts::FRAC_1_SQRT_2) as f32;
        assert_eq!(gains(&s, 2, &r, &p, &shared), [centered; 2]);
        assert_eq!(
            gains(&s, 2, &json!({"hearThroughCameras":true}), &p, &shared),
            [centered; 2]
        );
        s["gameState"] = json!(3);
        assert!(join_identity(&s).is_none());
        assert_eq!(gains(&s, 2, &r, &p, &shared), [0.0; 2]);
    }
    #[test]
    fn range_vent_comms_and_ptt() {
        let mut s = state();
        let p = Preferences::default();
        let shared = json!({});
        assert_eq!(
            gains(&s, 2, &json!({"maxDistance":0.8}), &p, &shared),
            [0.0; 2]
        );
        s["players"][1]["inVent"] = json!(true);
        assert_eq!(gains(&s, 2, &json!({}), &p, &shared), [0.0; 2]);
        s["players"][1]["inVent"] = json!(false);
        s["comsSabotaged"] = json!(true);
        assert_eq!(
            gains(&s, 2, &json!({"commsSabotage":true}), &p, &shared),
            [0.0; 2]
        );
        let c = Controls::default();
        assert!(!c.transmitting(0));
        c.joined.store(true, Ordering::Relaxed);
        assert!(c.transmitting(0));
        assert!(!c.transmitting(1));
        c.ptt.store(true, Ordering::Relaxed);
        assert!(c.transmitting(1));
        assert!(!c.transmitting(2));
        c.deafened.store(true, Ordering::Relaxed);
        assert!(!c.transmitting(0));
    }
    #[test]
    fn validates_server_and_finite_values() {
        let mut p = Preferences::default();
        assert!(p.validate().is_ok());
        p.server_url = "file:///x".into();
        assert!(p.validate().is_err());
        p.server_url = "http://localhost:1234".into();
        p.volume = f32::NAN;
        assert!(p.validate().is_err());
    }
    #[test]
    fn vision_tracks_lights_but_impostors_keep_lobby_range() {
        let mut s = state();
        let p = Preferences::default();
        let r = json!({"visionHearing":true,"maxDistance":5.32});
        let shared = json!({});
        s["lightRadius"] = json!(2.0);
        s["players"][1]["x"] = json!(2.0);
        assert!(gains(&s, 2, &r, &p, &shared)[1] > 0.0);
        s["lightRadius"] = json!(0.3);
        assert_eq!(gains(&s, 2, &r, &p, &shared), [0.0; 2]);
        s["players"][0]["isImpostor"] = json!(true);
        assert!(gains(&s, 2, &r, &p, &shared)[1] > 0.0);
        s["players"][0]["isImpostor"] = json!(false);
        s["lightRadius"] = Value::Null;
        assert_eq!(gains(&s, 2, &r, &p, &shared), [0.0; 2]);
        s["lightRadius"] = json!(0.1);
        assert_eq!(hearing_distance(&s, &r, local(&s).unwrap()), Some(1.0));
    }
    #[test]
    fn walls_only_block_living_task_listeners() {
        let mut s = state();
        s["map"] = json!(1);
        s["players"][0]["x"] = json!(6.106);
        s["players"][0]["y"] = json!(2.7);
        s["players"][1]["x"] = json!(6.106);
        s["players"][1]["y"] = json!(3.1);
        s["closedDoors"] = json!([0]);
        let p = Preferences::default();
        let r = json!({"wallsBlockAudio":true});
        let shared = json!({});
        assert_eq!(gains(&s, 2, &r, &p, &shared), [0.0; 2]);
        assert!(gains(&s, 2, &json!({}), &p, &shared)[0] > 0.0);
        s["players"][0]["isDead"] = json!(true);
        assert!(gains(&s, 2, &r, &p, &shared)[0] > 0.0);
        s["players"][0]["isDead"] = json!(false);
        s["gameState"] = json!(2);
        let centered = ((1.0 - 0.4 / (5.32 - 0.1)) * std::f64::consts::FRAC_1_SQRT_2) as f32;
        assert_eq!(gains(&s, 2, &r, &p, &shared), [centered; 2]);
        s["gameState"] = json!(0);
        assert!(gains(&s, 2, &r, &p, &shared)[0] > 0.0);
    }
}
