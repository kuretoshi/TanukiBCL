//! UI/OBS/mobile/public-lobby frames for the native Vanilla voice engine.
use super::{
    model::*,
    routing::{can_use_radio, route},
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub fn voice_state(
    state: &Value,
    rules: &Value,
    prefs: &Preferences,
    shared: &Value,
    clients: &Map<String, Value>,
    connected: &HashSet<String>,
    vad: &HashMap<i64, bool>,
    radios: &[i64],
    talking: bool,
    controls: &Controls,
) -> Value {
    let me = local(state);
    let mut sockets = Map::new();
    let mut other_talking = Map::new();
    let mut other_dead = Map::new();
    for (socket, client) in clients {
        if let Some(id) = client["clientId"].as_i64() {
            sockets.insert(id.to_string(), json!(socket));
        }
    }
    for player in state["players"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| !flag(p, "isLocal"))
    {
        let Some(id) = player["clientId"].as_i64() else {
            continue;
        };
        let audible = route(state, id, rules, prefs, shared, radios)
            .gains
            .iter()
            .any(|g| *g > 0.0);
        other_talking.insert(
            id.to_string(),
            json!(
                vad.get(&id) == Some(&true)
                    && audible
                    && !controls.deafened.load(std::sync::atomic::Ordering::Relaxed)
            ),
        );
        if state["gameState"] != 0 {
            other_dead.insert(id.to_string(), json!(flag(player, "isDead")));
        }
    }
    let visible_radios: Vec<_> = radios
        .iter()
        .copied()
        .filter(|id| {
            state["players"].as_array().is_some_and(|ps| {
                ps.iter()
                    .find(|p| p["clientId"].as_i64() == Some(*id))
                    .is_some_and(|sender| {
                        me.is_some_and(|me| {
                            if state["mod"] == "NoS" {
                                if flag(sender, "isLocal") {
                                    can_use_radio(state, sender, rules)
                                } else {
                                    (super::routing::radio_enabled(0, rules)
                                        && flag(sender, "nativeNosRadioHearable0"))
                                        || (super::routing::radio_enabled(1, rules)
                                            && flag(sender, "nativeNosRadioHearable1"))
                                }
                            } else {
                                can_use_radio(state, me, rules)
                                    && if state["mod"] == "SUPER_NEW_ROLES"
                                        && super::roles::jackal_team(me)
                                    {
                                        super::roles::jackal_team(sender)
                                    } else {
                                        super::roles::impostor(state, sender)
                                            && !(state["mod"] == "SUPER_NEW_ROLES"
                                                && super::roles::jackal_team(sender))
                                    }
                            }
                        })
                    })
            })
        })
        .collect();
    let audio_connected: Map<String, Value> = connected
        .iter()
        .map(|id| (id.clone(), json!(true)))
        .collect();
    json!({"otherTalking":other_talking,"playerSocketIds":sockets,"otherDead":other_dead,"socketClients":clients,"audioConnected":audio_connected,"localTalking":talking,"localIsAlive":!me.is_some_and(|p|flag(p,"isDead")),"impostorRadioClientId":visible_radios.first().copied().unwrap_or(-1),"impostorRadioClientIds":visible_radios,"muted":controls.muted.load(std::sync::atomic::Ordering::Relaxed),"deafened":controls.deafened.load(std::sync::atomic::Ordering::Relaxed),"mod":state["mod"]})
}
fn outfit(player: &Value, original: &str, current: &str) -> String {
    let changed = player["currentOutfit"]
        .as_i64()
        .is_some_and(|n| (1..=10).contains(&n));
    let display = player[current].as_str().unwrap_or("");
    if changed || display.starts_with("Modded_") {
        display.into()
    } else {
        player[original].as_str().unwrap_or("").into()
    }
}
pub fn obs_state(state: &Value, voice: &Value, colors: &Value) -> Value {
    let players: Vec<_> = state["players"].as_array().into_iter().flatten().map(|p| {
        let id = p["clientId"].as_i64().unwrap_or(-1).to_string();
        let connected = voice["playerSocketIds"][&id].as_str().is_some_and(|socket|voice["socketClients"][socket]["clientId"]==p["clientId"]);
        let mut player=json!({"id":p["id"],"clientId":p["clientId"],"inVent":flag(p,"inVent"),"isDead":flag(p,"isDead"),"name":p["name"].as_str().unwrap_or(""),"hatId":outfit(p,"hatId","appearanceHatId"),"petId":p["petId"],"skinId":outfit(p,"skinId","appearanceSkinId"),"visorId":outfit(p,"visorId","appearanceVisorId"),"disconnected":flag(p,"disconnected"),"isLocal":flag(p,"isLocal"),"bugged":flag(p,"bugged"),"colorId":p["colorId"],"shiftedColor":p["shiftedColor"],"usingRadio":voice["impostorRadioClientIds"].as_array().is_some_and(|ids|ids.contains(&p["clientId"])),"connected":connected});
        if let Some(color)=p["colorId"].as_u64().and_then(|id|colors.as_array().and_then(|cs|cs.get(id as usize))) { player["realColor"]=color.clone(); }
        let mod_id=state["mod"].as_str().unwrap_or("");for kind in ["hat","skin","visor"]{player[format!("{kind}Id")]=json!(super::cosmetics::appearance(p,mod_id,kind));}let(skin,mask)=super::cosmetics::sources(p,mod_id);if let Some(skin)=skin{player["skinSource"]=json!(skin);}if let Some(mask)=mask{player["bodyMaskSource"]=json!(mask);}
        if mod_id=="NoS"{if let Some(o)=player.as_object_mut(){for key in ["colorId","shiftedColor","realColor"]{o.remove(key);}}let color=p["nosLobbyColor"].as_str().map(str::to_string).or_else(||{let values=[p["nosPlayer"]["colorR"].as_f64()?,p["nosPlayer"]["colorG"].as_f64()?,p["nosPlayer"]["colorB"].as_f64()?];values.iter().all(|v|v.is_finite()).then(||format!("#{:02x}{:02x}{:02x}",(values[0].clamp(0.,1.)*255.).round() as u8,(values[1].clamp(0.,1.)*255.).round() as u8,(values[2].clamp(0.,1.)*255.).round() as u8))});if let Some(color)=color{player["nosColor"]=json!(color);}}
        player
    }).collect();
    json!({"overlayState":{"gameState":state["gameState"],"players":players},"otherTalking":voice["otherTalking"],"otherDead":voice["otherDead"],"localTalking":voice["localTalking"],"localIsAlive":voice["localIsAlive"],"mod":state["mod"],"oldMeetingHud":flag(state,"oldMeetingHud"),"snrMeeting":state["snrMeeting"],"assetSession":format!("{}:{}",state["lobbyCode"].as_str().unwrap_or("MENU"),state["mod"].as_str().unwrap_or("NONE"))})
}
pub fn public_lobby(state: &Value, rules: &Value) -> Option<Value> {
    if !flag(state, "isHost")
        || !matches!(state["gameState"].as_i64(), Some(0..=2))
        || state["lobbyCode"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s == "MENU")
    {
        return None;
    }
    Some(
        json!({"id":-1,"title":rules["publicLobby_title"].as_str().unwrap_or(""),"host":local(state).and_then(|p|p["name"].as_str()).unwrap_or(""),"current_players":state["players"].as_array().map(Vec::len).unwrap_or(0),"max_players":state["maxPlayers"].as_u64().unwrap_or(15),"language":rules["publicLobby_language"].as_str().unwrap_or("ja"),"mods":state["mod"],"isPublic":flag(rules,"publicLobby_on"),"gameState":state["gameState"]}),
    )
}
pub struct Ui {
    cache: HashMap<String, Value>,
    windows: HashSet<String>,
    refreshed: Instant,
}
impl Default for Ui {
    fn default() -> Self {
        Self {
            cache: HashMap::new(),
            windows: HashSet::new(),
            refreshed: Instant::now(),
        }
    }
}
impl Ui {
    fn send(&mut self, app: &AppHandle, target: &str, channel: &str, value: Value) {
        let key = format!("{target}:{channel}");
        if self.cache.get(&key) == Some(&value) {
            return;
        }
        let _ = app.emit_to(
            target,
            "backend-ipc",
            json!({"channel":channel,"args":[value.clone()]}),
        );
        self.cache.insert(key, value);
    }
    pub fn publish(
        &mut self,
        app: &AppHandle,
        state: &Value,
        voice: &Value,
        shared: &Value,
        rules: &Value,
        host: i64,
        context: &Value,
    ) {
        if self.refreshed.elapsed() >= Duration::from_secs(2) {
            self.cache.clear();
            self.refreshed = Instant::now();
        }
        for target in ["overlay", "settings", "debug"] {
            if app.get_webview_window(target).is_none() {
                self.windows.remove(target);
                continue;
            }
            if self.windows.insert(target.into()) {
                self.cache
                    .retain(|key, _| !key.starts_with(&format!("{target}:")));
            }
            if target == "overlay" {
                self.send(app, target, "NOTIFY_GAME_STATE_CHANGED", state.clone());
                self.send(app, target, "NOTIFY_VOICE_STATE_CHANGED", voice.clone());
                self.send(app, target, "NOTIFY_SETTINGS_CHANGED", shared.clone());
                if context["playerColors"].is_array() {
                    self.send(
                        app,
                        target,
                        "NOTIFY_PLAYERCOLORS_CHANGED",
                        context["playerColors"].clone(),
                    );
                }
            } else {
                self.send(
                    app,
                    target,
                    "SETTINGS_NOTIFY_GAME_STATE_CHANGED",
                    state.clone(),
                );
                self.send(
                    app,
                    target,
                    "SETTINGS_NOTIFY_ACTIVE_LOBBY_SETTINGS_CHANGED",
                    rules.clone(),
                );
                self.send(app, target, "SETTINGS_NOTIFY_HOST_ID_CHANGED", json!(host));
                self.send(app, target, "DEBUG_VOICE_CHANGED", voice.clone());
                if context["playerColors"].is_array() {
                    self.send(
                        app,
                        target,
                        "SETTINGS_NOTIFY_PLAYER_COLORS_CHANGED",
                        context["playerColors"].clone(),
                    );
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crew_and_ghosts_cannot_see_radio_icons_and_inaudible_vad_is_hidden() {
        let state = json!({"mod":"NONE","gameState":1,"players":[{"clientId":1,"isLocal":true,"x":0,"y":0},{"clientId":2,"isImpostor":true,"x":20,"y":0}]});
        let voice = voice_state(
            &state,
            &json!({"impostorRadioEnabled":true}),
            &Preferences::default(),
            &json!({}),
            &Map::new(),
            &HashSet::new(),
            &HashMap::from([(2, true)]),
            &[2],
            false,
            &Controls::default(),
        );
        assert_eq!(voice["impostorRadioClientIds"], json!([]));
        assert_eq!(voice["otherTalking"]["2"], false);
    }
    #[test]
    fn obs_frame_and_public_listing_do_not_include_memory_pointers_or_role_flags() {
        let state = json!({"mod":"NONE","gameState":1,"lobbyCode":"FIXTURE","isHost":true,"maxPlayers":15,"players":[{"clientId":1,"isLocal":true,"name":"Synthetic","isImpostor":true,"ptr":123,"hatId":"hat","appearanceHatId":"other","currentOutfit":0}]});
        let frame = obs_state(&state, &json!({}), &json!([]));
        let player = &frame["overlayState"]["players"][0];
        assert_eq!(player["hatId"], "hat");
        assert!(player.get("ptr").is_none() && player.get("isImpostor").is_none());
        assert_eq!(public_lobby(&state, &json!({})).unwrap()["isPublic"], false);
    }
}
