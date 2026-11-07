//! Bounded, PID-scoped addon state. Missing heartbeats cannot restore an
//! exhausted microphone; an authoritative empty publication or leaving clears it.
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= 255)
}
fn range(value: &Value, lo: f64, hi: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && (lo..=hi).contains(&v))
}
fn time(value: &Value, max: u64) -> bool {
    value
        .as_u64()
        .is_some_and(|v| v <= max && v <= 9_007_199_254_740_991)
}
fn optional_bool(value: &Value, key: &str) -> bool {
    value.get(key).is_none_or(Value::is_boolean)
}
pub fn row_valid(kind: &str, p: &Value, now: u64) -> bool {
    if !id(&p["playerId"]) {
        return false;
    }
    match kind {
        "heroes" => p["kind"]
            .as_str()
            .is_some_and(|s| ["super", "evil"].contains(&s)),
        "portable" => range(&p["extraRange"], 0.0, 30.0),
        "megaphones" => {
            range(&p["energy"], 0.0, 1.0)
                && range(&p["range"], 2.0, 40.0)
                && optional_bool(p, "voiceEffect")
                && p.get("phase").is_none_or(|v| {
                    v.as_str()
                        .is_some_and(|s| ["charging", "firing"].contains(&s))
                        && time(&p["shotId"], 9_007_199_254_740_991)
                        && p["shotId"].as_u64() != Some(0)
                })
        }
        "dying" => {
            time(&p["started"], now + 100)
                && p["started"].as_u64() != Some(0)
                && range(&p["seconds"], 1.0, 30.0)
                && range(&p["range"], 0.5, 10.0)
                && optional_bool(p, "loop")
                && range(&p["x"], -10000.0, 10000.0)
                && range(&p["y"], -10000.0, 10000.0)
        }
        "jamming" => {
            p["muted"].is_boolean() && p["lowpass"].is_boolean() && range(&p["pitch"], 0.5, 2.0)
        }
        "echoes" => range(&p["unixMs"], f64::NEG_INFINITY, now as f64 + 100.0),
        "interviews" => {
            let started = p["started"].as_u64().unwrap_or(0);
            let stopped = p["stopped"].as_u64().unwrap_or(u64::MAX);
            let play = p["playStarted"].as_u64().unwrap_or(u64::MAX);
            time(&p["started"], now + 100)
                && started > 0
                && range(&p["seconds"], 1.0, 30.0)
                && time(&p["stopped"], 9_007_199_254_740_991)
                && (stopped == 0
                    || (stopped >= started
                        && stopped as f64
                            <= started as f64 + p["seconds"].as_f64().unwrap_or(0.0) * 1000.0))
                && ids(&p["visible"], 255)
                && time(&p["playStarted"], now + 100)
                && (play == 0 || (stopped > started && play >= stopped))
        }
        "speech" => {
            p["kind"]
                .as_str()
                .is_some_and(|s| ["hero", "ng"].contains(&s))
                && p["request"].as_u64().is_some_and(|v| v <= 2147483647)
                && time(&p["expires"], now + 16000)
                && p["words"].as_array().is_some_and(|ws| {
                    ws.len() <= 3
                        && ws.iter().all(|w| {
                            w.as_str()
                                .is_some_and(|s| (2..=32).contains(&s.encode_utf16().count()))
                        })
                })
                && (p["kind"] != "ng"
                    || (p["request"].as_u64().is_some_and(|v| v > 0)
                        && p["words"].as_array().is_some_and(|ws| !ws.is_empty())))
        }
        _ => false,
    }
}
fn ids(value: &Value, max: usize) -> bool {
    let mut seen = HashSet::new();
    value.as_array().is_some_and(|rs| {
        rs.len() <= max && rs.iter().all(|v| id(v) && seen.insert(v.as_u64().unwrap()))
    })
}
fn rows(kind: &str, value: &Value, now: u64, max: usize) -> bool {
    let mut seen = HashSet::new();
    value.as_array().is_some_and(|rs| {
        rs.len() <= max
            && rs.iter().all(|r| {
                row_valid(kind, r, now)
                    && seen.insert(if kind == "speech" {
                        format!("{}:{}", r["playerId"], r["kind"])
                    } else {
                        r["playerId"].to_string()
                    })
            })
    })
}
pub fn channels(value: &Value, now: u64) -> bool {
    [
        "heroes",
        "portable",
        "megaphones",
        "dying",
        "interviews",
        "jamming",
        "echoes",
    ]
    .iter()
    .all(|kind| rows(kind, &value[*kind], now, 24))
        && value["echoes"]
            .as_array()
            .is_some_and(|rs| rs.iter().all(|r| time(&r["unixMs"], now + 100)))
        && ids(&value["muted"], 24)
        && rows("speech", &value["speech"], now, 48)
}
pub fn link_port(value: &Value) -> Option<u16> {
    let value = value.as_u64().filter(|v| *v <= 0x7fff_ffff)? as u32;
    ((value & 0xffff0000) == 0x54420000 && (value & 65535) > 0).then_some(value as u16)
}
pub fn scalars(snapshot: &Value) -> Option<Value> {
    let v2 = link_port(&snapshot["addonData"]).is_some();
    if !snapshot.is_object() || (!v2 && snapshot["addonData"] != 0x544b0001u32) {
        return None;
    }
    let players = snapshot["players"].as_array().filter(|ps| ps.len() <= 24)?;
    let mut seen = HashSet::new();
    let mut heroes = Vec::new();
    let mut portable = Vec::new();
    for p in players {
        let id = p["playerId"]
            .as_u64()
            .filter(|n| *n < 24 && seen.insert(*n))?;
        let data = p["addonData"].as_u64().filter(|n| *n <= 0x7fff_ffff)? as u32;
        if if v2 {
            data & 0xffff0000 != 0x544c0000
        } else {
            data & 0xfffffe00 != 0x544b0000
        } {
            return None;
        }
        let hero = data & 3;
        let range = (data >> 2) & 63;
        let active = data & 0x100 != 0;
        if hero == 3 || range > 60 || (!active && range != 0) {
            return None;
        }
        if hero != 0 {
            heroes.push(json!({"playerId":id,"kind":if hero==1{"super"}else{"evil"}}));
        }
        if active {
            portable.push(json!({"playerId":id,"extraRange":range as f64/2.0}));
        }
    }
    Some(json!({"heroes":heroes,"portable":portable}))
}
#[derive(Default)]
pub struct Reader {
    scope: String,
    muted: Value,
}
impl Reader {
    pub fn parse(
        &mut self,
        kind: &str,
        value: Option<&Value>,
        pid: u32,
        now: u64,
        active: bool,
    ) -> Value {
        if !active {
            if kind == "muted" {
                self.muted = json!([]);
            }
            return json!([]);
        }
        let Some(value) = value else {
            return if kind == "muted" {
                self.muted
                    .as_array()
                    .cloned()
                    .map(|v| json!(v))
                    .unwrap_or_else(|| json!([]))
            } else {
                json!([])
            };
        };
        let valid_identity = value["protocol"] == 1 && value["pid"].as_u64() == Some(pid as u64);
        let ttl = if matches!(kind, "portable" | "megaphones") {
            500.0
        } else {
            1000.0
        };
        let stamp = if matches!(kind, "portable" | "megaphones" | "muted") {
            value["unixMs"].as_f64().filter(|v| v.is_finite())
        } else {
            value["unixMs"]
                .as_u64()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .map(|v| v as f64)
        };
        let fresh = kind == "echoes"
            || stamp.is_some_and(|t| now as f64 - t <= ttl && t - now as f64 <= 100.0);
        let valid = valid_identity
            && fresh
            && if kind == "muted" {
                ids(&value["players"], 255)
            } else {
                rows(
                    kind,
                    &value["players"],
                    now,
                    match kind {
                        "heroes" => 24,
                        "interviews" => 32,
                        _ => 255,
                    },
                )
            };
        if !valid {
            return self.parse(kind, None, pid, now, active);
        }
        let result = if kind == "echoes" {
            json!(value["players"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| now as f64 - p["unixMs"].as_f64().unwrap() <= 3000.0)
                .cloned()
                .collect::<Vec<_>>())
        } else {
            value["players"].clone()
        };
        if kind == "muted" {
            self.muted = result.clone();
        }
        result
    }
    pub fn update(
        &mut self,
        pid: u32,
        state: &Value,
        snapshot: Option<&Value>,
        linked: Option<&Value>,
    ) -> Value {
        let enabled = state["mod"] == "NoS"
            && state["nosAddonIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == "tanuki.bcl.roles"));
        let phase = state["gameState"].as_i64().unwrap_or(3);
        let active = matches!(phase, 1 | 2);
        let scope = format!("{pid}:{}:{enabled}", state["lobbyCode"]);
        if scope != self.scope {
            self.scope = scope;
            self.muted = json!([]);
        }
        if !enabled || !active {
            self.muted = json!([]);
            return json!({});
        }
        if let Some(c) = linked {
            self.muted = c["muted"].clone();
            let mut output = json!({"nosBibiriEchoes":c["echoes"].as_array().into_iter().flatten().filter(|e|now().saturating_sub(e["unixMs"].as_u64().unwrap_or(0))<=3000).collect::<Vec<_>>(),"nosInterviews":c["interviews"],"nosDyingVoices":c["dying"],"nosLimitSpeechMuted":c["muted"]});
            if phase == 1 {
                for (key, channel) in [
                    ("nosMegaphones", "megaphones"),
                    ("nosHeroTransforms", "heroes"),
                    ("nosPortableMegaphones", "portable"),
                ] {
                    output[key] = c[channel].clone();
                }
            } else {
                output["nosVoiceJamming"] = c["jamming"].clone();
            }
            return output;
        }
        let Some(root) =
            std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("TanukiBCL/NoS"))
        else {
            return json!({});
        };
        let mut output = Map::new();
        let now = now();
        for (kind, key, file, limit, allow) in [
            (
                "muted",
                "nosLimitSpeechMuted",
                format!("limit-speech-{pid}.json"),
                16384,
                true,
            ),
            (
                "echoes",
                "nosBibiriEchoes",
                "bibiri-echo.json".into(),
                16384,
                true,
            ),
            (
                "megaphones",
                "nosMegaphones",
                format!("megaphone-state-{pid}.json"),
                16384,
                phase == 1,
            ),
            (
                "interviews",
                "nosInterviews",
                format!("interviews-{pid}.json"),
                65536,
                true,
            ),
            (
                "jamming",
                "nosVoiceJamming",
                format!("voice-jamming-{pid}.json"),
                65536,
                phase == 2,
            ),
            (
                "heroes",
                "nosHeroTransforms",
                format!("hero-transforms-{pid}.json"),
                8192,
                phase == 1,
            ),
            (
                "dying",
                "nosDyingVoices",
                format!("dying-voice-{pid}.json"),
                32768,
                true,
            ),
            (
                "portable",
                "nosPortableMegaphones",
                "portable-megaphone.json".into(),
                16384,
                phase == 1,
            ),
        ] {
            if !allow {
                continue;
            }
            let path = root.join(file);
            let path = if kind == "megaphones" && !path.exists() {
                root.join("megaphone-state.json")
            } else {
                path
            };
            let value = read_json(&path, limit).ok();
            output.insert(key.into(), self.parse(kind, value.as_ref(), pid, now, true));
        }
        if phase == 1 {
            if let Some(scalar) = snapshot.and_then(scalars) {
                output.insert("nosHeroTransforms".into(), scalar["heroes"].clone());
                output.insert("nosPortableMegaphones".into(), scalar["portable"].clone());
            }
        }
        Value::Object(output)
    }
}
pub fn read_json(path: &Path, limit: usize) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Invalid role-state file".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("Role-state file exceeds its limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_limit_speech_heartbeat_does_not_unmute_a_player() {
        let mut r = Reader::default();
        let data = json!({"protocol":1,"pid":42,"unixMs":10000,"players":[1]});
        assert_eq!(r.parse("muted", Some(&data), 42, 10000, true), json!([1]));
        assert_eq!(r.parse("muted", None, 42, 20000, true), json!([1]));
        let clear = json!({"protocol":1,"pid":42,"unixMs":20000,"players":[]});
        assert_eq!(r.parse("muted", Some(&clear), 42, 20000, true), json!([]));
    }
    #[test]
    fn role_messages_do_not_cross_processes_or_outlive_their_heartbeat() {
        let mut r = Reader::default();
        let data =
            json!({"protocol":1,"pid":42,"unixMs":10000,"players":[{"playerId":1,"kind":"super"}]});
        assert_eq!(
            r.parse("heroes", Some(&data), 42, 10000, true)
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(r.parse("heroes", Some(&data), 43, 10000, true), json!([]));
        assert_eq!(r.parse("heroes", Some(&data), 42, 11001, true), json!([]));
    }
    #[test]
    fn scalar_addon_state_decodes_only_supported_pid_snapshot_publications() {
        let snapshot = json!({"addonData":0x544b0001u32,"players":[{"playerId":1,"addonData":0x544b0101u32|80}]});
        let value = scalars(&snapshot).unwrap();
        assert_eq!(value["heroes"][0]["kind"], "super");
        assert_eq!(value["portable"][0]["extraRange"], 10.0);
    }
}
