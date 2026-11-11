//! Vanilla routing port of the pinned release's spatialAudio.ts.
use super::model::{flag, hearing_distance, local, number, player_config, Preferences};
use super::roles;
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn wall_ear<'a>(state: &'a Value, me: &Value) -> Option<&'a Value> {
    if state["mod"] != "NoS"
        || state["gameState"] != 1
        || ["isDead", "disconnected", "inVent"]
            .iter()
            .any(|k| flag(me, k))
    {
        return None;
    }
    let rows = state["nosWallEars"]
        .as_array()
        .filter(|rs| rs.len() <= 24)?;
    if !rows
        .iter()
        .all(|r| crate::native::mods::addon::row_valid("ears", r, 0))
    {
        return None;
    }
    let mut matching = rows.iter().filter(|r| r["playerId"] == me["id"]);
    let ear = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    let x = me["x"].as_f64().filter(|v| v.is_finite())?;
    let y = me["y"].as_f64().filter(|v| v.is_finite())?;
    // JSON float parsing and platform hypot can differ by a few ULPs.
    // Accommodate that representation error at the installed-station boundary.
    ((number(ear, "x", 1e9) - x).hypot(number(ear, "y", 1e9) - y) <= 1.6 + 1e-10).then_some(ear)
}

#[cfg(test)]
mod wall_ear_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn installed_boundary_survives_json_rounding_but_rejects_a_distant_station() {
        let mut state = json!({"mod":"NoS","gameState":1,"nosWallEars":[{"playerId":0,"x":7.706,"y":2.7,"range":4.}]});
        let me = json!({"id":0,"x":6.106,"y":2.7});
        assert!(wall_ear(&state, &me).is_some());
        state["nosWallEars"][0]["x"] = json!(7.70600001);
        assert!(wall_ear(&state, &me).is_none());
    }
    #[test]
    fn missing_coordinates_or_duplicate_stations_cannot_enable_remote_listening() {
        let mut state = json!({"mod":"NoS","gameState":1,"nosWallEars":[{"playerId":0,"x":0.,"y":0.,"range":4.}]});
        assert!(wall_ear(&state, &json!({"id":0})).is_none());
        let me = json!({"id":0,"x":0.,"y":0.});
        state["nosWallEars"] = json!([state["nosWallEars"][0], state["nosWallEars"][0]]);
        assert!(wall_ear(&state, &me).is_none());
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Effects {
    pub pitch: Option<super::pitch::Parameters>,
    pub echo: f64,
    pub filter: Option<Filter>,
    pub reverb: bool,
    pub reverb_wet: f64,
    pub radio_echo: bool,
    #[serde(skip_serializing_if = "zero")]
    pub berserker: f64,
}
fn zero(value: &f64) -> bool {
    *value == 0.0
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub highpass: bool,
    pub frequency: f64,
    pub q: f64,
}
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub gains: [f32; 2],
    pub stereo: [[f32; 2]; 2],
    pub effects: Effects,
}

#[cfg(test)]
mod gluttony_tests {
    use super::*;
    use serde_json::json;

    fn sample(addon: i32, x: f64) -> Value {
        json!({"mod":"NoS","gameState":1,"map":1,"currentCamera":7,"closedDoors":[],
            "nosAddonIds":["UchuAddon"],"nosLocalMicPosition":{"x":0.0,"y":0.0},
            "players":[{"id":0,"clientId":1,"isLocal":true,"x":0.0,"y":0.0},
                {"id":1,"clientId":2,"x":1.0,"y":0.0,"nativeNosRadioHearable0":true,
                    "nosPlayer":{"speakerPositionX":x,"speakerPositionY":0.0,"addonData":addon}}]})
    }

    #[test]
    fn nos_gluttony_recipient_and_radio() {
        for positions in [false, true] {
            let rules = json!({"maxDistance":5.32,"nosVoicePositions":positions,
                "nosGluttonySwallowVoice":"mute","impostorRadioEnabled":true});
            for radios in [vec![], vec![2]] {
                let own = route(
                    &sample(100, 1.0),
                    2,
                    &rules,
                    &Preferences::default(),
                    &json!({}),
                    &radios,
                );
                assert!(
                    own.gains.iter().any(|g| *g > 0.0),
                    "swallower must hear its own victim"
                );
                let hidden = route(
                    &sample(100, 20.0),
                    2,
                    &rules,
                    &Preferences::default(),
                    &json!({}),
                    &radios,
                );
                assert_eq!(
                    hidden.gains, [0.0; 2],
                    "bystander must not hear a hidden victim"
                );
            }
            let unrelated = route(
                &sample(0, 1000.0),
                2,
                &rules,
                &Preferences::default(),
                &json!({}),
                &[2],
            );
            assert!(
                unrelated.gains.iter().any(|g| *g > 0.0),
                "coordinates never classify swallowing"
            );
        }
    }
}
pub fn can_use_radio(state: &Value, player: &Value, rules: &Value) -> bool {
    matches!(state["gameState"].as_i64(), Some(1 | 2))
        && !flag(player, "isDead")
        && !flag(player, "disconnected")
        && !flag(player, "bugged")
        && if state["mod"] == "NoS" {
            let radios = if flag(player, "isLocal") {
                &state["nosRadios"]
            } else {
                &player["nativeNosRadios"]
            };
            radios.as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|r| radio_enabled(r["kind"].as_i64().unwrap_or(-1), rules))
            })
        } else if state["mod"] == "SUPER_NEW_ROLES" && roles::jackal_team(player) {
            flag(rules, "jackalRadioEnabled") && !flag(rules, "impostorRadioOnlyMode")
        } else {
            roles::impostor(state, player)
                && (flag(rules, "impostorRadioEnabled") || flag(rules, "impostorRadioOnlyMode"))
        }
}
pub fn radio_enabled(kind: i64, rules: &Value) -> bool {
    match kind {
        0 => flag(rules, "impostorRadioEnabled") || flag(rules, "impostorRadioOnlyMode"),
        1 => flag(rules, "jackalRadioEnabled") && !flag(rules, "impostorRadioOnlyMode"),
        _ => false,
    }
}

fn camera_position(map: i64, camera: i64) -> Option<[f64; 2]> {
    let positions: &[[f64; 2]] = match map {
        0 => &[
            [13.2417, -4.348],
            [0.6216, -6.5642],
            [-7.1503, 1.6709],
            [-17.8098, -4.8983],
        ],
        2 => &[
            [29.0, -15.7],
            [15.4, -15.4],
            [24.4, -8.5],
            [17.0, -20.6],
            [4.7, -22.73],
            [11.6, -8.2],
        ],
        4 => &[
            [-8.2872, 0.0527],
            [-4.0477, 9.1447],
            [23.5616, 9.8882],
            [4.881, -11.1688],
            [30.3702, -0.874],
            [3.3018, 16.2631],
        ],
        _ => return None,
    };
    usize::try_from(camera)
        .ok()
        .and_then(|id| positions.get(id).copied())
}
fn camera_offset(state: &Value, other: [f64; 2]) -> Option<[f64; 2]> {
    let camera = state["currentCamera"].as_i64().unwrap_or(7);
    let map = state["map"].as_i64().unwrap_or(6);
    let position = if camera == 6 {
        (0..6)
            .filter_map(|c| camera_position(map, c))
            .min_by(|a, b| {
                (other[0] - a[0])
                    .hypot(other[1] - a[1])
                    .total_cmp(&(other[0] - b[0]).hypot(other[1] - b[1]))
            })
    } else {
        camera_position(map, camera)
    }?;
    Some([other[0] - position[0], other[1] - position[1]])
}

pub fn route(
    state: &Value,
    other_client: i64,
    rules: &Value,
    prefs: &Preferences,
    shared: &Value,
    radios: &[i64],
) -> Route {
    route_at(state, other_client, rules, prefs, shared, radios, false)
}
pub(super) fn route_at(
    state: &Value,
    other_client: i64,
    rules: &Value,
    prefs: &Preferences,
    shared: &Value,
    radios: &[i64],
    body: bool,
) -> Route {
    let silent = Route::default();
    let Some(original_me) = local(state) else {
        return silent;
    };
    let Some(original_other) = state["players"].as_array().and_then(|ps| {
        ps.iter()
            .find(|p| p["clientId"].as_i64() == Some(other_client))
    }) else {
        return silent;
    };
    let mut me = original_me.clone();
    let mut other = original_other.clone();
    me["isImpostor"] = serde_json::json!(roles::impostor(state, original_me));
    other["isImpostor"] = serde_json::json!(roles::impostor(state, original_other));
    for p in [&mut me, &mut other] {
        if roles::falling(state, p) {
            if let Some(origin) = p["snrPushOrigin"].as_object().cloned() {
                for (key, value) in origin {
                    if key == "x" || key == "y" {
                        p[&key] = value;
                    }
                }
            }
            p["isDead"] = serde_json::json!(false);
        }
    }
    let ear = wall_ear(state, original_me);
    let use_positions = state["mod"] == "NoS";
    if let Some(ear) = ear {
        me["x"] = ear["x"].clone();
        me["y"] = ear["y"].clone();
    } else if use_positions || roles::follows_head(state, &me) {
        let position = &state["nosLocalMicPosition"];
        if position["x"]
            .as_f64()
            .zip(position["y"].as_f64())
            .is_some_and(|(x, y)| x.is_finite() && y.is_finite())
        {
            me["x"] = position["x"].clone();
            me["y"] = position["y"].clone();
        }
    }
    if !body && (use_positions || roles::follows_head(state, &other)) {
        let p = &other["nosPlayer"];
        if p["speakerPositionX"]
            .as_f64()
            .zip(p["speakerPositionY"].as_f64())
            .is_some_and(|(x, y)| x.is_finite() && y.is_finite())
        {
            let x = p["speakerPositionX"].clone();
            let y = p["speakerPositionY"].clone();
            other["x"] = x;
            other["y"] = y;
        }
    }
    let me = &me;
    let other = &other;
    if flag(other, "isLocal")
        || flag(other, "disconnected")
        || flag(other, "isDummy")
        || flag(other, "bugged")
    {
        return silent;
    }
    let Some(phase @ 0..=2) = state["gameState"].as_i64() else {
        return silent;
    };
    let position = |p: &Value| -> Option<[f64; 2]> {
        Some([
            p["x"].as_f64().filter(|v| v.is_finite())?,
            p["y"].as_f64().filter(|v| v.is_finite())?,
        ])
    };
    let Some(from) = position(me) else {
        return silent;
    };
    let Some(to) = position(other) else {
        return silent;
    };
    let Some(base_max) = hearing_distance(state, rules, me) else {
        return silent;
    };
    let (dead, other_dead) = (flag(me, "isDead"), flag(other, "isDead"));
    let mut max = ear.map_or(
        base_max
            + if dead {
                0.0
            } else {
                roles::extra_range(state, other)
            },
        |ear| number(ear, "range", 0.),
    );
    let nos = state["mod"] == "NoS";
    let snr = state["mod"] == "SUPER_NEW_ROLES";
    let jammed = flag(&me["nosPlayer"], "isJammed") || flag(&other["nosPlayer"], "isJammed");
    if nos && rules["nosFixerJammingVoiceBlock"] != false && jammed {
        return silent;
    }
    let swallowed = nos
        && state["gameState"] == 1
        && state["nosAddonIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == "UchuAddon"))
        && !flag(original_other, "isDead")
        && other["nosPlayer"]["addonData"].as_i64() == Some(100);
    let swallow_mode = if swallowed {
        rules["nosGluttonySwallowVoice"].as_str().unwrap_or("mute")
    } else {
        "normal"
    };
    // NoS supplies a listener-specific endpoint; preserve it before radio bypasses.
    if swallow_mode == "mute" && (to[0] - from[0]).hypot(to[1] - from[1]) > max {
        return silent;
    }
    if phase == 1
        && flag(me, "isImpostor")
        && ((snr
            && flag(rules, "snrBuskerReviveHideVoice")
            && other["snrRole"]["role"]["name"] == "Busker"
            && other["snrRole"]["buskerPseudocideActive"] == true)
            || (nos
                && flag(rules, "nosBuskerReviveHideVoice")
                && other["nosRole"]["roleName"] == "busker"
                && flag(other, "nosIsPseudocide")))
    {
        return silent;
    }
    let mut pan = [to[0] - from[0], to[1] - from[1]];
    let using_radio = radios.contains(&other_client);
    let radio_enabled = flag(rules, "impostorRadioEnabled") || flag(rules, "impostorRadioOnlyMode");
    let me_jackal = snr && roles::jackal(me);
    let me_sidekick = snr && roles::sidekick(me);
    let me_team = me_jackal || me_sidekick;
    let other_team = snr && roles::jackal_team(other);
    let jackal_enabled = flag(rules, "jackalRadioEnabled") && !flag(rules, "impostorRadioOnlyMode");
    let hear_radio = using_radio
        && ((!nos
            && !dead
            && flag(me, "isImpostor")
            && flag(other, "isImpostor")
            && radio_enabled)
            || (!nos
                && dead
                && !other_dead
                && if flag(other, "isImpostor") {
                    radio_enabled
                } else {
                    jackal_enabled
                })
            || (!dead && me_team && other_team && jackal_enabled)
            || (nos && jackal_enabled && flag(other, "nativeNosRadioHearable1"))
            || (nos && radio_enabled && flag(other, "nativeNosRadioHearable0")));
    let haunting = roles::ghosts(state, me, rules);
    let debug = &state["debug"];
    let meeting_fallback = state["map"] == 4
        && phase == 1
        && (flag(state, "airshipMeetingByOutfit")
            || flag(debug, "airshipMeetingByOutfit")
            || (debug.is_object()
                && debug["meetingHudCachePtr"].as_u64().is_some_and(|p| p != 0)
                && debug["meetingHudState"]
                    .as_i64()
                    .is_some_and(|s| (0..4).contains(&s))));
    let spawn_fallback =
        phase == 1 && state["map"] == 4 && flag(state, "nativeAirshipSpawnFallback");
    let mut skip_distance = false;
    let mut wall_check = false;
    let mut gain = 1.0;
    let mut effects = Effects::default();
    let charge = roles::charging(state, other)
        .filter(|_| ear.is_none() && !dead && !flag(rules, "deadOnly"));
    if let Some(charge) = charge {
        max = number(charge, "range", 0.0);
        if max <= 0.0 {
            return silent;
        }
        gain = ((max - pan[0].hypot(pan[1])) / max.min(2.0)).clamp(0.0, 1.0);
        if flag(rules, "commsSabotage") && flag(state, "comsSabotaged") && !flag(me, "isImpostor") {
            gain = 0.0;
        }
    } else if phase == 1 {
        if meeting_fallback || (!dead && spawn_fallback) {
            skip_distance = true;
            pan = [0.0; 2];
        }
        if flag(rules, "meetingGhostOnly") || (flag(rules, "impostorRadioOnlyMode") && !dead) {
            gain = 0.0;
        }
        if !dead
            && flag(rules, "commsSabotage")
            && flag(state, "comsSabotaged")
            && !flag(me, "isImpostor")
        {
            gain = 0.0;
        }
        if flag(other, "inVent")
            && !if (me_team || other_team) && flag(me, "inVent") {
                me_team
                    && other_team
                    && if me_sidekick || (snr && roles::sidekick(other)) {
                        flag(rules, "sidekickTalkInVents")
                    } else {
                        flag(rules, "jackalTalkInVents")
                    }
            } else {
                flag(rules, "hearImpostorsInVents")
                    || (flag(rules, "impostersHearImpostersInvent") && flag(me, "inVent"))
            }
        {
            gain = 0.0;
        }
        wall_check = flag(rules, "wallsBlockAudio") && !dead && ear.is_none();
        if using_radio && !hear_radio {
            gain = 0.0;
        } else if hear_radio {
            gain = 1.0;
            skip_distance = true;
            effects.radio_echo = true;
            effects.filter = Some(Filter {
                highpass: true,
                frequency: 1000.0,
                q: 10.0,
            });
        }
        if !dead && other_dead && haunting {
            effects.reverb = true;
            effects.reverb_wet = 1.0;
            wall_check = false;
            if flag(rules, "impostorRadioOnlyMode") {
                gain = 1.0;
            }
            gain *= number(shared, "ghostVolumeAsImpostor", 100.0) / 100.0;
        } else if other_dead && !dead {
            gain = 0.0;
        }
        if meeting_fallback && !dead && other_dead {
            gain = 0.0;
        }
        if !dead
            && me_team
            && flag(me, "inVent")
            && !flag(other, "inVent")
            && !flag(
                rules,
                if me_jackal {
                    "jackalHearOutsideVents"
                } else {
                    "sidekickHearOutsideVents"
                },
            )
        {
            gain = 0.0;
        }
    } else if phase == 2 {
        pan = [0.0; 2];
        if !dead && other_dead {
            gain = 0.0;
        }
        if using_radio {
            gain = if hear_radio { 1.0 } else { 0.0 };
        }
        if using_radio && hear_radio {
            effects.radio_echo = true;
            effects.filter = Some(Filter {
                highpass: true,
                frequency: 1000.0,
                q: 10.0,
            });
        }
    }
    if flag(rules, "deadOnly") {
        pan = [0.0; 2];
        if !dead || !other_dead {
            gain = 0.0;
        }
    }
    let blocks = || {
        super::geometry::blocks(
            state["map"].as_i64().unwrap_or(6),
            from,
            to,
            &state["closedDoors"],
        )
    };
    if charge.is_none() && spawn_fallback && wall_check && blocks() {
        return silent;
    }
    let mut on_camera = state["currentCamera"].as_i64().unwrap_or(7) != 7;
    if charge.is_some() {
        on_camera = false;
    } else if !skip_distance && pan[0].hypot(pan[1]) > max {
        if ear.is_some() || phase != 1 || !flag(rules, "hearThroughCameras") {
            return silent;
        }
        pan = camera_offset(state, to).unwrap_or(pan);
        if pan[0].hypot(pan[1]) > max {
            return silent;
        }
    } else {
        if !skip_distance && wall_check && blocks() {
            return silent;
        }
        on_camera = false;
    }
    let in_vent = (flag(me, "inVent") && !dead) || (flag(other, "inVent") && !other_dead);
    if charge.is_none() && phase == 1 && (in_vent || on_camera) {
        effects.filter = Some(Filter {
            highpass: false,
            frequency: if on_camera { 2300.0 } else { 2000.0 },
            q: if on_camera { -15.0 } else { 20.0 },
        });
        if gain == 1.0 {
            gain = if on_camera { 0.8 } else { 0.5 };
        }
    }
    if nos
        && flag(rules, "nosFixerJammingLowpass")
        && rules["nosFixerJammingVoiceBlock"] == false
        && jammed
    {
        effects.filter = Some(Filter {
            highpass: false,
            frequency: 1200.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
        });
    }
    if swallow_mode == "quiet" && gain > 0.0 {
        gain *= 0.1;
        effects.filter = Some(Filter {
            highpass: false,
            frequency: 450.0,
            q: std::f64::consts::FRAC_1_SQRT_2,
        });
    }
    if let Some(jamming) = roles::jamming(state, &other["id"]) {
        if flag(jamming, "muted") {
            gain = 0.0;
        }
        if flag(jamming, "lowpass") {
            effects.filter = Some(Filter {
                highpass: false,
                frequency: 1200.0,
                q: std::f64::consts::FRAC_1_SQRT_2,
            });
        }
    }
    if nos
        && matches!(phase, 1 | 2)
        && state["nosLimitSpeechMuted"]
            .as_array()
            .is_some_and(|ids| ids.contains(&other["id"]))
    {
        gain = 0.0;
    }
    let tuning = roles::tuning(
        state,
        original_me,
        original_other,
        rules,
        shared,
        radios,
        meeting_fallback,
        gain > 0.0,
    );
    effects.pitch = (tuning.pitch != 0.0).then_some(super::pitch::Parameters {
        pitch: 2.0_f64.powf(tuning.pitch / 100.0),
        formant: 1.0,
        squash: 0.0,
    });
    effects.echo = tuning.echo / 100.0;
    effects.berserker = tuning.grit / 100.0;
    if tuning.reverb > 0.0 {
        effects.reverb = true;
        effects.reverb_wet = effects.reverb_wet.max(tuning.reverb / 100.0);
    }
    if !prefs.spatial_audio || skip_distance {
        pan = [0.0; 2];
    }
    // The release fixes PannerNode.positionZ at -0.5. Elevation does not
    // affect equal-power azimuth, but all three axes affect distance gain.
    let distance = pan[0].hypot(pan[1]).hypot(0.5);
    gain *= (1.0 - (distance - 0.1).max(0.0) / (max - 0.1)).max(0.0);
    if dead && !other_dead {
        gain *= number(shared, "crewVolumeAsGhost", 100.0) / 100.0;
    }
    let config = player_config(shared, other);
    if flag(config, "isMuted") {
        return silent;
    }
    gain *= number(config, "volume", 1.0).clamp(0.0, 2.0) * prefs.volume as f64;
    let azimuth = pan[0].atan2(0.5);
    let angle = (azimuth + std::f64::consts::FRAC_PI_2) / 2.0;
    let stereo = if azimuth <= 0.0 {
        [
            [gain as f32, (-gain * azimuth.sin()) as f32],
            [0.0, (gain * azimuth.cos()) as f32],
        ]
    } else {
        [
            [(gain * azimuth.cos()) as f32, 0.0],
            [(gain * azimuth.sin()) as f32, gain as f32],
        ]
    };
    Route {
        gains: [(gain * angle.cos()) as f32, (gain * angle.sin()) as f32],
        stereo,
        effects,
    }
}
