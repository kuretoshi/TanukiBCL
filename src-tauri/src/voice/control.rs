//! Validated peer metadata for NoS radios/pseudocide and TOH host-only roles.
//! All grants are bound to the current room, host and actual game identities.
use super::{model::*, roles};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct NosReport {
    client: i64,
    radios: Value,
    at: Instant,
    unix: u64,
}
struct Pseudo {
    client: i64,
    active: bool,
    at: Instant,
}
pub struct Outgoing {
    pub target: Option<i64>,
    pub value: Value,
}
#[derive(Default)]
pub struct Book {
    scope: String,
    nos: HashMap<i64, NosReport>,
    pseudo: HashMap<i64, Pseudo>,
    toh_enabled: bool,
    catalog: Value,
    catalog_at: Option<Instant>,
    role: Value,
    role_at: Option<Instant>,
    impostors: Value,
    names: Map<String, Value>,
    dead: Map<String, Value>,
    platforms: HashMap<i64, (String, Instant)>,
    sent: HashMap<String, (Value, Instant)>,
    host_checked: bool,
}
fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn valid_radios(value: &Value) -> bool {
    value.as_array().is_some_and(|rows| {
        rows.len() <= 8
            && rows.iter().all(|r| {
                r["kind"].as_i64().is_some()
                    && r["hearableMask"]
                        .as_i64()
                        .is_some_and(|n| i32::try_from(n).is_ok())
                    && r["nameLength"].as_u64().is_some_and(|n| {
                        n <= 32
                            && r["name"]
                                .as_str()
                                .is_some_and(|s| s.encode_utf16().count() == n as usize)
                    })
            })
    })
}
pub fn valid_catalog(value: &Value) -> bool {
    let Some(rows) = value.as_array().filter(|rs| rs.len() <= 1024) else {
        return false;
    };
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    rows.iter().all(|r| {
        let Some(id) = r["roleId"].as_i64() else {
            return false;
        };
        let Some(name) = r["roleName"].as_str() else {
            return false;
        };
        let valid = name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && name.len() <= 128
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        valid
            && ids.insert(id)
            && names.insert(name)
            && r["displayName"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256)
            && r["customRoleType"].as_str().is_some_and(|s| {
                ["Impostor", "Madmate", "Crewmate", "Neutral", "Animals"].contains(&s)
            })
            && r.get("isKiller")
                .is_some_and(|v| v.is_null() || v.is_boolean())
    })
}
fn valid_role(r: &Value) -> bool {
    r["roleId"].as_i64().is_some()
        && r.get("roleName")
            .is_some_and(|v| v.is_null() || v.is_string())
        && ["isKiller", "isNeutralKiller"]
            .iter()
            .all(|key| r.get(*key).is_some_and(|v| v.is_null() || v.is_boolean()))
        && (r["customRoleType"].is_null()
            || r["customRoleType"].as_str().is_some_and(|s| {
                ["Impostor", "Madmate", "Crewmate", "Neutral", "Animals"].contains(&s)
            }))
        && r.get("opportunistCanKill").is_none_or(Value::is_boolean)
}
fn valid_impostors(value: &Value) -> bool {
    let Some(rows) = value.as_array().filter(|r| r.len() <= 20) else {
        return false;
    };
    let mut ids = HashSet::new();
    let mut clients = HashSet::new();
    rows.iter().all(|r| {
        r["playerId"]
            .as_u64()
            .is_some_and(|id| id <= 255 && ids.insert(id))
            && r["clientId"].as_i64().is_some_and(|id| clients.insert(id))
            && r["isImpostor"].is_boolean()
    })
}
fn host_marker(text: &str) -> bool {
    let clean = text
        .chars()
        .filter(|c| !matches!(*c, '\u{200b}'..='\u{200d}' | '\u{feff}'))
        .collect::<String>();
    let clean = clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let marker = "town of host for e";
    clean.match_indices(marker).any(|(i, _)| {
        clean
            .as_bytes()
            .get(i + marker.len())
            .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_')
    })
}
impl Book {
    pub fn force(&mut self) {
        self.sent.clear();
    }
    fn sync(&mut self, state: &Value, host: i64) {
        let scope = format!("{}:{}:{host}", state["lobbyCode"], state["clientId"]);
        if self.scope != scope {
            *self = Self::default();
            self.scope = scope;
        }
        let phase = state["gameState"].as_i64().unwrap_or(3);
        let players = state["players"].as_array();
        let present = |id: i64, client: i64| {
            players.is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["id"].as_i64() == Some(id)
                        && p["clientId"].as_i64() == Some(client)
                        && !flag(p, "disconnected")
                })
            })
        };
        self.nos
            .retain(|id, r| r.at.elapsed() < Duration::from_secs(10) && present(*id, r.client));
        self.pseudo
            .retain(|id, r| r.at.elapsed() < Duration::from_secs(3) && present(*id, r.client));
        self.platforms.retain(|client, (_, at)| {
            at.elapsed() < Duration::from_millis(6500)
                && players.is_some_and(|ps| {
                    ps.iter().any(|p| {
                        p["clientId"].as_i64() == Some(*client) && !flag(p, "disconnected")
                    })
                })
        });
        if phase == 0 {
            self.dead.clear();
            if local(state).is_some_and(|p| p["clientId"].as_i64() == Some(host)) {
                self.names.clear();
                for p in players
                    .into_iter()
                    .flatten()
                    .filter(|p| !flag(p, "disconnected"))
                {
                    if let Some(client) = p["clientId"].as_i64() {
                        self.names.insert(client.to_string(), p["name"].clone());
                    }
                }
            }
        }
        if phase == 2 {
            for p in players.into_iter().flatten() {
                if let Some(client) = p["clientId"].as_i64() {
                    self.dead.insert(
                        client.to_string(),
                        json!(flag(p, "isDead") || flag(p, "disconnected")),
                    );
                }
            }
        }
        if phase == 3 || phase == 4 {
            self.toh_enabled = false;
            self.catalog = Value::Null;
            self.role = Value::Null;
            self.names.clear();
            self.dead.clear();
            self.nos.clear();
            self.pseudo.clear();
        }
        if !self.host_checked
            && players.is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["clientId"].as_i64() == Some(host)
                        && ["name", "appearanceName"]
                            .iter()
                            .any(|key| p[*key].as_str().is_some_and(host_marker))
                })
            })
        {
            self.toh_enabled = true;
        }
        self.host_checked = true;
    }
    pub fn accept(&mut self, client: i64, data: &Value, state: &Value, host: i64) {
        self.sync(state, host);
        let Some(sender) = state["players"].as_array().and_then(|ps| {
            ps.iter().find(|p| {
                p["clientId"].as_i64() == Some(client)
                    && !flag(p, "isLocal")
                    && !flag(p, "disconnected")
            })
        }) else {
            return;
        };
        let phase = state["gameState"].as_i64().unwrap_or(3);
        let active = phase == 1 || phase == 2;
        if data["type"] == "app-version" && data["lobbyCode"] == state["lobbyCode"] {
            if let Some(platform) = data["platform"]
                .as_str()
                .filter(|s| ["desktop", "web", "mobile"].contains(s))
            {
                self.platforms
                    .insert(client, (platform.into(), Instant::now()));
            }
            return;
        }
        if data["lobbyCode"] != state["lobbyCode"] {
            return;
        }
        if data["type"] == "nos-radio-data" {
            if state["mod"] == "NoS"
                && active
                && data["playerId"] == sender["id"]
                && valid_radios(&data["radios"])
            {
                if let Some(id) = sender["id"].as_i64() {
                    self.nos.insert(
                        id,
                        NosReport {
                            client,
                            radios: data["radios"].clone(),
                            at: Instant::now(),
                            unix: unix_ms(),
                        },
                    );
                }
            }
            return;
        }
        if data["type"] == "nos-pseudocide" {
            if state["mod"] == "NoS" && active && data["playerId"] == sender["id"] {
                if let (Some(id), Some(active)) = (sender["id"].as_i64(), data["active"].as_bool())
                {
                    self.pseudo.insert(
                        id,
                        Pseudo {
                            client,
                            active,
                            at: Instant::now(),
                        },
                    );
                }
            }
            return;
        }
        if client != host
            || local(state).is_some_and(|p| p["clientId"].as_i64() == Some(host))
            || !matches!(phase, 0..=2)
        {
            return;
        }
        match data["type"].as_str() {
            Some("toh4e-lobby") => {
                if let Some(enabled) = data["enabled"].as_bool() {
                    if data.get("roleCatalog").is_some() && !valid_catalog(&data["roleCatalog"]) {
                        return;
                    }
                    self.toh_enabled = enabled;
                    self.catalog_at = Some(Instant::now());
                    self.catalog = if enabled && valid_catalog(&data["roleCatalog"]) {
                        data["roleCatalog"].clone()
                    } else {
                        json!([])
                    };
                    if !enabled {
                        self.role = Value::Null;
                        self.role_at = None;
                        self.impostors = Value::Null;
                        self.names.clear();
                    }
                }
            }
            Some("toh4e-roster") => {
                if let Some(rows) = data["players"].as_array().filter(|r| r.len() <= 20) {
                    let mut names = Map::new();
                    for row in rows {
                        let Some(client) = row["clientId"].as_i64() else {
                            return;
                        };
                        let Some(name) = row["name"]
                            .as_str()
                            .filter(|s| s.encode_utf16().count() <= 100)
                        else {
                            return;
                        };
                        names.insert(client.to_string(), json!(name));
                    }
                    self.names = names;
                    self.toh_enabled = true;
                }
            }
            Some("toh4e-role")
                if active
                    && data["targetClientId"] == state["clientId"]
                    && local(state).is_some_and(|p| p["id"] == data["targetPlayerId"]) =>
            {
                if (!data["role"].is_null() && !valid_role(&data["role"]))
                    || data.get("impostors").is_some_and(|v| !valid_impostors(v))
                {
                    return;
                }
                self.role = data["role"].clone();
                self.role_at = Some(Instant::now());
                self.impostors = data["impostors"].clone();
                self.toh_enabled = true;
            }
            _ => {}
        }
    }
    pub fn decorate(&mut self, state: &mut Value, host: i64, kinds: &HashMap<i64, Option<i64>>) {
        self.sync(state, host);
        let local_id = local(state).and_then(|p| p["id"].as_u64());
        let local_client = state["clientId"].as_i64();
        let is_host = local_client == Some(host);
        let nos = state["mod"] == "NoS";
        if nos {
            let local_pseudo = state["nosLocalIsPseudocide"].clone();
            for p in state["players"].as_array_mut().into_iter().flatten() {
                let id = p["id"].as_i64();
                let client = p["clientId"].as_i64();
                let report = id
                    .and_then(|id| self.nos.get(&id))
                    .filter(|r| Some(r.client) == client);
                p["nativeNosRadios"] = report.map(|r| r.radios.clone()).unwrap_or(Value::Null);
                let mut selected = client.and_then(|client| kinds.get(&client).copied().flatten());
                if selected.is_none() {
                    let kinds: HashSet<_> = report
                        .and_then(|r| r.radios.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|r| r["kind"].as_i64().filter(|k| *k == 0 || *k == 1))
                        .collect();
                    if kinds.len() == 1 {
                        selected = kinds.iter().next().copied();
                    }
                }
                for kind in [0, 1] {
                    let reach = selected == Some(kind)
                        && local_id.is_some_and(|id| {
                            id < 32
                                && report
                                    .and_then(|r| r.radios.as_array())
                                    .is_some_and(|rows| {
                                        rows.iter().any(|r| {
                                            r["kind"].as_i64() == Some(kind)
                                                && r["hearableMask"].as_i64().is_some_and(|mask| {
                                                    (mask as u32 >> id) & 1 != 0
                                                })
                                        })
                                    })
                        });
                    p[format!("nativeNosRadioHearable{kind}")] = json!(reach);
                }
                p["nosIsPseudocide"] = if flag(p, "isLocal") {
                    local_pseudo.clone()
                } else {
                    id.and_then(|id| self.pseudo.get(&id))
                        .filter(|r| Some(r.client) == client)
                        .map(|r| json!(r.active))
                        .unwrap_or(Value::Null)
                };
            }
        }
        if !["NONE", "TOH4E"].contains(&state["mod"].as_str().unwrap_or("NONE"))
            || (!self.toh_enabled && state["mod"] != "TOH4E")
        {
            return;
        }
        state["mod"] = json!("TOH4E");
        if !is_host {
            state["tohRoleCatalog"] = if self
                .catalog_at
                .is_some_and(|at| at.elapsed() <= Duration::from_secs(5))
            {
                self.catalog.clone()
            } else {
                json!([])
            };
        }
        let fresh = self
            .role_at
            .is_some_and(|at| at.elapsed() <= Duration::from_secs(5));
        let raw = state.clone();
        for p in state["players"].as_array_mut().into_iter().flatten() {
            if let Some(name) = p["clientId"]
                .as_i64()
                .and_then(|id| self.names.get(&id.to_string()))
            {
                p["name"] = name.clone();
                p["appearanceName"] = name.clone();
            }
            if !is_host {
                let entry = fresh
                    .then(|| {
                        self.impostors.as_array().and_then(|rs| {
                            rs.iter().find(|r| {
                                r["playerId"] == p["id"] && r["clientId"] == p["clientId"]
                            })
                        })
                    })
                    .flatten();
                p["tohImpostor"] = entry
                    .map(|e| e["isImpostor"].clone())
                    .unwrap_or(Value::Null);
                if flag(p, "isLocal") {
                    p["tohRole"] = if fresh {
                        self.role.clone()
                    } else {
                        Value::Null
                    };
                }
            }
            if p["vanillaIsImpostor"].is_null() {
                p["vanillaIsImpostor"] = p["isImpostor"].clone();
            }
            p["isImpostor"] = json!(roles::impostor(&raw, p));
        }
    }
    fn emit(&mut self, key: String, target: Option<i64>, value: Value, output: &mut Vec<Outgoing>) {
        if self
            .sent
            .get(&key)
            .is_some_and(|(old, at)| *old == value && at.elapsed() < Duration::from_secs(3))
        {
            return;
        }
        self.sent.insert(key, (value.clone(), Instant::now()));
        output.push(Outgoing { target, value });
    }
    pub fn outgoing(&mut self, state: &Value, host: i64, rules: &Value) -> Vec<Outgoing> {
        let mut output = Vec::new();
        let Some(me) = local(state) else {
            return output;
        };
        if !matches!(state["gameState"].as_i64(), Some(0..=2)) {
            return output;
        }
        let lobby = &state["lobbyCode"];
        self.emit("version".into(),None,json!({"type":"app-version","lobbyCode":lobby,"version":crate::compat_version(),"platform":"desktop","tauriNativeVoice":true}),&mut output);
        if state["mod"] == "NoS" && matches!(state["gameState"].as_i64(), Some(1 | 2)) {
            if !state["nosRadios"].is_null() {
                self.emit("nos-radio".into(),None,json!({"type":"nos-radio-data","lobbyCode":lobby,"playerId":me["id"],"radios":state["nosRadios"]}),&mut output);
            }
            if state["nosLocalIsPseudocide"].is_boolean() {
                self.emit("nos-pseudo".into(),None,json!({"type":"nos-pseudocide","lobbyCode":lobby,"playerId":me["id"],"active":state["nosLocalIsPseudocide"]}),&mut output);
            }
        }
        if me["clientId"].as_i64() == Some(host) {
            self.emit("host-rules".into(), None, rules.clone(), &mut output);
            let enabled = state["mod"] == "TOH4E";
            let catalog = if enabled && valid_catalog(&state["tohRoleCatalog"]) {
                state["tohRoleCatalog"].clone()
            } else {
                json!([])
            };
            self.emit("toh-lobby".into(),None,json!({"type":"toh4e-lobby","lobbyCode":lobby,"enabled":enabled,"roleCatalog":catalog}),&mut output);
            if enabled && matches!(state["gameState"].as_i64(), Some(1 | 2)) {
                let players = state["players"].as_array().cloned().unwrap_or_default();
                if self.names.is_empty() {
                    for p in &players {
                        if let (Some(client), Some(name)) =
                            (p["clientId"].as_i64(), p["name"].as_str())
                        {
                            self.names.insert(client.to_string(), json!(name));
                        }
                    }
                }
                let roster: Vec<_> = self
                    .names
                    .iter()
                    .filter_map(|(id, name)| {
                        id.parse::<i64>()
                            .ok()
                            .map(|id| json!({"clientId":id,"name":name}))
                    })
                    .collect();
                self.emit(
                    "toh-roster".into(),
                    None,
                    json!({"type":"toh4e-roster","lobbyCode":lobby,"players":roster}),
                    &mut output,
                );
                let impostors:Vec<_>=players.iter().filter(|p|!flag(p,"disconnected")).map(|p|json!({"playerId":p["id"],"clientId":p["clientId"],"isImpostor":roles::impostor(state,p)})).collect();
                for p in players
                    .iter()
                    .filter(|p| !flag(p, "isLocal") && !flag(p, "disconnected"))
                {
                    if let Some(client) = p["clientId"].as_i64() {
                        self.emit(format!("toh-role:{client}"),Some(client),json!({"type":"toh4e-role","lobbyCode":lobby,"targetClientId":client,"targetPlayerId":p["id"],"role":p["tohRole"],"impostors":impostors}),&mut output);
                    }
                }
            }
        }
        output
    }
    pub fn snapshot(&self, state: &Value) -> Value {
        let reports: Map<String, Value> = self
            .nos
            .iter()
            .map(|(id, r)| {
                (
                    id.to_string(),
                    json!({"clientId":r.client,"radios":r.radios,"receivedAt":r.unix}),
                )
            })
            .collect();
        json!({"otherDead":self.dead,"toh4eLobby":state["mod"]=="TOH4E","tohRole":local(state).map(|p|p["tohRole"].clone()).unwrap_or(Value::Null),"tohRoleCatalog":state["tohRoleCatalog"].as_array().cloned().unwrap_or_default(),"tohGameStartNames":self.names,"nosRadiosByPlayer":reports})
    }
    pub fn platform(&self, client: i64) -> Option<&str> {
        self.platforms
            .get(&client)
            .filter(|(_, at)| at.elapsed() < Duration::from_millis(6500))
            .map(|(p, _)| p.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(mod_name: &str) -> Value {
        json!({"mod":mod_name,"gameState":1,"lobbyCode":"RUSTVOICE","clientId":1,"hostId":2,"players":[{"id":0,"clientId":1,"isLocal":true,"isImpostor":true},{"id":1,"clientId":2},{"id":2,"clientId":3}]})
    }
    #[test]
    fn outgoing_version_matches_release_compatibility() {
        let mut book = Book::default();
        let outputs = book.outgoing(&state("NONE"), 1, &json!({}));
        let version = outputs.iter().find(|o| o.value["type"] == "app-version").expect("version announcement");
        let base: Value = serde_json::from_str(include_str!("../../release-base.json")).unwrap();
        assert_eq!(version.value["version"], base["baseVersion"]);
    }
    #[test]
    fn only_the_room_host_can_assign_a_targeted_toh_role() {
        let mut book = Book::default();
        let mut s = state("NONE");
        let payload = json!({"type":"toh4e-role","lobbyCode":"RUSTVOICE","targetClientId":1,"targetPlayerId":0,"role":{"roleId":1,"roleName":"Crewmate","isKiller":false,"isNeutralKiller":false,"customRoleType":"Crewmate"}});
        book.accept(3, &payload, &s, 2);
        book.decorate(&mut s, 2, &HashMap::new());
        assert_eq!(s["mod"], "NONE");
        book.accept(2, &payload, &s, 2);
        book.decorate(&mut s, 2, &HashMap::new());
        assert_eq!(s["mod"], "TOH4E");
        assert_eq!(s["players"][0]["isImpostor"], false);
    }
    #[test]
    fn nos_reception_uses_senders_mask_and_waits_when_metadata_is_missing() {
        let mut book = Book::default();
        let mut s = state("NoS");
        let kinds = HashMap::from([(2, Some(1))]);
        book.decorate(&mut s, 2, &kinds);
        assert_eq!(s["players"][1]["nativeNosRadioHearable1"], false);
        book.accept(2,&json!({"type":"nos-radio-data","lobbyCode":"RUSTVOICE","playerId":1,"radios":[{"kind":1,"hearableMask":1,"nameLength":0,"name":""}]}),&s,2);
        book.decorate(&mut s, 2, &kinds);
        assert_eq!(s["players"][1]["nativeNosRadioHearable1"], true);
        assert_eq!(s["players"][1]["nativeNosRadioHearable0"], false);
        s["lobbyCode"] = json!("NEWROOM");
        book.decorate(&mut s, 2, &kinds);
        assert_eq!(s["players"][1]["nativeNosRadioHearable1"], false);
    }
    #[test]
    fn task_deaths_are_only_shown_after_meeting_publication() {
        let mut book = Book::default();
        let mut s = state("NONE");
        s["players"][1]["isDead"] = json!(true);
        book.decorate(&mut s, 2, &HashMap::new());
        assert!(book.snapshot(&s)["otherDead"]["2"].is_null());
        s["gameState"] = json!(2);
        book.decorate(&mut s, 2, &HashMap::new());
        assert_eq!(book.snapshot(&s)["otherDead"]["2"], true);
        s["gameState"] = json!(0);
        book.decorate(&mut s, 2, &HashMap::new());
        assert!(book.snapshot(&s)["otherDead"]["2"].is_null());
    }
    #[test]
    fn catalog_rejects_missing_killer_field_and_duplicate_roles() {
        let row = json!({"roleId":1,"roleName":"Crewmate","displayName":"Crewmate","customRoleType":"Crewmate","isKiller":false});
        assert!(valid_catalog(&json!([row])));
        assert!(!valid_catalog(&json!([row, row])));
        let mut missing = row;
        missing.as_object_mut().unwrap().remove("isKiller");
        assert!(!valid_catalog(&json!([missing])));
    }
}
