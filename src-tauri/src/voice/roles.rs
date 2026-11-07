//! Pure role predicates and listener-side effect presets from the pinned
//! release. These functions never infer an unknown Mod role from Vanilla's
//! substitute role or another player's faction.
use super::model::{flag, number};
use serde_json::Value;
pub fn impostor(state: &Value, p: &Value) -> bool {
    if state["mod"] != "TOH4E" {
        return flag(p, "isImpostor");
    }
    let vanilla = p["vanillaIsImpostor"]
        .as_bool()
        .unwrap_or_else(|| flag(p, "isImpostor"));
    vanilla
        && if p["tohRole"].is_object() {
            p["tohRole"]["customRoleType"] == "Impostor"
        } else {
            flag(p, "tohImpostor")
        }
}
pub fn jackal(p: &Value) -> bool {
    p["snrRole"]["role"]["name"]
        .as_str()
        .is_some_and(|s| ["Jackal", "WaveCannonJackal"].contains(&s))
}
pub fn sidekick(p: &Value) -> bool {
    p["snrRole"]["role"]["name"]
        .as_str()
        .is_some_and(|s| ["Sidekick", "SidekickWaveCannon"].contains(&s))
}
pub fn jackal_team(p: &Value) -> bool {
    jackal(p) || sidekick(p)
}
pub fn addon(state: &Value) -> bool {
    state["mod"] == "NoS"
        && state["nosAddonIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == "tanuki.bcl.roles"))
}
pub fn charging<'a>(state: &'a Value, p: &Value) -> Option<&'a Value> {
    if !addon(state)
        || state["gameState"] != 1
        || ["isDead", "disconnected", "isDummy", "bugged"]
            .iter()
            .any(|key| flag(p, key))
    {
        return None;
    }
    state["nosMegaphones"].as_array()?.iter().find(|e| {
        e["playerId"] == p["id"]
            && !match &e["phase"] {
                Value::Null => false,
                Value::Bool(v) => *v,
                Value::Number(n) => n.as_f64() != Some(0.0),
                Value::String(s) => !s.is_empty(),
                _ => true,
            }
    })
}
pub fn extra_range(state: &Value, p: &Value) -> f64 {
    if !addon(state)
        || state["gameState"] != 1
        || ["isDead", "disconnected", "isDummy", "bugged"]
            .iter()
            .any(|key| flag(p, key))
    {
        return 0.0;
    }
    state["nosPortableMegaphones"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["playerId"] == p["id"]))
        .and_then(|r| r["extraRange"].as_f64())
        .filter(|n| n.is_finite() && (0.0..=30.0).contains(n))
        .unwrap_or(0.0)
}
pub fn jamming<'a>(state: &'a Value, id: &Value) -> Option<&'a Value> {
    if !addon(state) || state["gameState"] != 2 {
        return None;
    }
    state["nosVoiceJamming"].as_array()?.iter().find(|e| {
        e["playerId"] == *id
            && e["muted"].is_boolean()
            && e["lowpass"].is_boolean()
            && e["pitch"]
                .as_f64()
                .is_some_and(|p| p.is_finite() && (0.5..=2.0).contains(&p))
    })
}
pub fn transformed(state: &Value, p: &Value) -> bool {
    addon(state)
        && state["gameState"] == 1
        && state["nosHeroTransforms"].as_array().is_some_and(|rs| {
            rs.iter().any(|r| {
                r["playerId"] == p["id"]
                    && r["kind"]
                        .as_str()
                        .is_some_and(|s| ["super", "evil"].contains(&s))
            })
        })
}
pub fn falling(state: &Value, p: &Value) -> bool {
    state["mod"] == "SUPER_NEW_ROLES"
        && state["gameState"] == 1
        && flag(p, "snrPushedFalling")
        && flag(p, "isDead")
        && !flag(p, "disconnected")
        && !flag(p, "isDummy")
}
pub fn follows_head(state: &Value, p: &Value) -> bool {
    state["mod"] == "NoS"
        && state["gameState"] == 1
        && !flag(p, "isDead")
        && !flag(p, "disconnected")
        && (p["nosRole"]["roleName"] == "rokurokubi" || p["nosPlayer"]["bodyType"] == 3)
}
pub fn ghosts(state: &Value, p: &Value, rules: &Value) -> bool {
    if state["mod"] == "TOH4E" {
        let role = &p["tohRole"];
        let Some(name) = role["roleName"]
            .as_str()
            .filter(|s| !s.is_empty() && *s != "NotAssigned")
        else {
            return false;
        };
        if role["customRoleType"] == "Impostor" {
            return impostor(state, p) && flag(rules, "haunting");
        }
        if !role["customRoleType"]
            .as_str()
            .is_some_and(|s| ["Neutral", "Animals"].contains(&s))
            || role["isKiller"] != true
        {
            return false;
        }
        return if rules.get("tohGhostRoles").is_some() {
            rules["tohGhostRoles"][name] == true
        } else {
            flag(rules, "tohNeutralKillerHaunting")
        };
    }
    let snr = state["mod"] == "SUPER_NEW_ROLES";
    let snr_haunt = snr
        && flag(rules, "jackalHaunting")
        && (jackal(p) || (p["snrRole"]["isNeutral"] == true && p["snrRole"]["canKill"] == true));
    if snr && jackal(p) {
        return snr_haunt;
    }
    if snr && sidekick(p) {
        return flag(rules, "sidekickHaunting");
    }
    (state["mod"] == "NoS"
        && flag(rules, "nosNeutralKillerHaunting")
        && p["nosPlayer"]["isNeutral"] == true
        && p["nosPlayer"]["isKiller"] == true
        && p["nosPlayer"]["isImpostor"] == false)
        || snr_haunt
        || (impostor(state, p) && flag(rules, "haunting"))
}
#[derive(Clone, Copy, Default)]
pub struct Tuning {
    pub pitch: f64,
    pub reverb: f64,
    pub echo: f64,
    pub grit: f64,
}
pub(super) fn configured(shared: &Value, id: &str) -> Tuning {
    let (key, sign, reverb, echo) = match id {
        "disguise" => ("voiceEffectStrength", -1.0, false, false),
        "snrJumbo" => ("snrJumboVoiceEffectStrength", -1.0, false, false),
        "snrPush" => ("snrPushReverbStrength", 0.0, true, false),
        "nosSize" => ("nosSizeVoiceEffectStrength", -1.0, false, false),
        "nosRokurokubi" => ("nosRokurokubiVoiceEffectStrength", 1.0, false, false),
        "nosBerserker" => ("nosBerserkerVoiceEffectStrength", 0.0, true, true),
        "nosCitrus" => ("nosCitrusVoiceEffectStrength", 1.0, false, false),
        "nosRainbowStar" => ("nosRainbowStarEchoStrength", 0.0, true, false),
        "nosVoiceJamming" => ("nosVoiceJammingEffectStrength", -1.0, false, false),
        "nosMegaphone" => ("nosMegaphoneEffectStrength", -1.0, false, false),
        "nosBibiri" => ("nosBibiriEchoStrength", 0.0, false, true),
        _ => return Tuning::default(),
    };
    let strength = number(shared, key, 100.0).clamp(0.0, 100.0);
    let value = &shared["voiceEffectTunings"][id];
    let mut t = Tuning {
        pitch: number(value, "pitch", strength * sign).clamp(-100.0, 100.0),
        reverb: number(value, "reverb", if reverb { strength } else { 0.0 }).clamp(0.0, 100.0),
        echo: number(value, "echo", if echo { strength } else { 0.0 }).clamp(0.0, 100.0),
        grit: 0.0,
    };
    if id == "nosBerserker" {
        t.grit = t.pitch.abs().max(t.reverb).max(t.echo);
    }
    t
}
pub fn tuning(
    state: &Value,
    me: &Value,
    other: &Value,
    rules: &Value,
    shared: &Value,
    radios: &[i64],
    meeting_fallback: bool,
    audible: bool,
) -> Tuning {
    if !audible {
        return Tuning::default();
    }
    let phase = state["gameState"].as_i64().unwrap_or(3);
    let nos = state["mod"] == "NoS";
    let selected = if jamming(state, &other["id"]).is_some_and(|j| number(j, "pitch", 1.0) != 1.0)
        && !["disconnected", "bugged", "isDummy"]
            .iter()
            .any(|k| flag(other, k))
    {
        Some("nosVoiceJamming")
    } else if ["isDead", "disconnected", "bugged", "isDummy"]
        .iter()
        .any(|k| flag(other, k))
    {
        None
    } else if charging(state, other).is_some_and(|e| e["voiceEffect"] != false) {
        Some("nosMegaphone")
    } else if transformed(state, other) {
        None
    } else if nos
        && rules["nosCitrusVoiceEffect"] != false
        && matches!(phase, 1 | 2)
        && other["nosPlayer"]["hat"]["name"].as_str().is_some_and(|s| {
            [
                "noshat_catudon_Citrus_Orange",
                "noshat_catudon_Citrus_Lemon",
            ]
            .contains(&s)
        })
    {
        Some("nosCitrus")
    } else if phase != 1 || meeting_fallback {
        None
    } else if nos
        && rules["nosBerserkerVoiceEffect"] != false
        && other["nosRole"]["roleName"] == "berserker"
        && if other["nosPlayer"].get("bodyType").is_some() {
            other["nosPlayer"]["bodyType"] == 2
        } else {
            other["nosRole"]["bodyType"] == 2 && other["nosRole"]["isBerserking"] == true
        }
    {
        Some("nosBerserker")
    } else if nos
        && rules["nosRokurokubiVoiceEffect"] != false
        && other["nosPlayer"]["bodyType"] == 3
        && number(&other["nosPlayer"], "neckLength", 0.0) > 0.0
    {
        Some("nosRokurokubi")
    } else if nos
        && rules["nosSizeVoiceEffect"] != false
        && other["nosPlayer"]["bodyRateX"]
            .as_f64()
            .zip(other["nosPlayer"]["bodyRateY"].as_f64())
            .is_some_and(|(x, y)| {
                x.is_finite()
                    && y.is_finite()
                    && x > 0.0
                    && y >= 0.0
                    && (!(0.98..=1.02).contains(&x) || !(0.98..=1.02).contains(&y))
            })
    {
        Some("nosSize")
    } else if state["mod"] == "SUPER_NEW_ROLES"
        && flag(rules, "snrJumboVoice")
        && other["snrRole"]["modifier"]["name"]
            .as_str()
            .is_some_and(|s| s.split(" | ").any(|v| v == "JumboModifier"))
    {
        let size = &other["snrRole"]["jumbo"];
        (number(size, "currentSize", 0.0) > 0.0 && number(size, "maxSize", 0.0) > 0.0)
            .then_some("snrJumbo")
    } else if rules["voiceEffectEnabled"] == false || flag(me, "isDead") {
        None
    } else if radios.contains(&other["clientId"].as_i64().unwrap_or(-1))
        && ((impostor(state, me)
            && impostor(state, other)
            && (flag(rules, "impostorRadioEnabled") || flag(rules, "impostorRadioOnlyMode")))
            || (state["mod"] == "SUPER_NEW_ROLES"
                && flag(rules, "jackalRadioEnabled")
                && !flag(rules, "impostorRadioOnlyMode")
                && jackal_team(me)
                && jackal_team(other)))
    {
        None
    } else if other["appearanceName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| other["name"].as_str())
        != other["name"].as_str()
    {
        Some("disguise")
    } else {
        None
    };
    let mut t = selected
        .map(|id| configured(shared, id))
        .unwrap_or_default();
    for id in [
        (nos && rules["nosRainbowStarEcho"] != false
            && matches!(phase, 1 | 2)
            && !["isDead", "disconnected", "bugged", "isDummy"]
                .iter()
                .any(|k| flag(other, k))
            && other["nosRole"]["isRainbowStar"] == true)
            .then_some("nosRainbowStar"),
        (falling(state, other) && !meeting_fallback && rules["snrPushReverb"] != false)
            .then_some("snrPush"),
    ]
    .into_iter()
    .flatten()
    {
        let extra = configured(shared, id);
        t.pitch += extra.pitch;
        t.reverb = t.reverb.max(extra.reverb);
        t.echo = t.echo.max(extra.echo);
    }
    t.pitch = t.pitch.clamp(-100.0, 100.0);
    t
}
