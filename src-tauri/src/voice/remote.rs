//! Explicit companion microphone pairing and server-authenticated level relay.
use super::{model::*, roles};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn token(v: &Value, len: usize, hyphens: bool) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (hyphens && b == b'-'))
    })
}
fn secret() -> String {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).expect("random pairing secret");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn identity(state: &Value) -> Option<Value> {
    if !roles::addon(state) || !matches!(state["gameState"].as_i64(), Some(0..=2)) {
        return None;
    }
    let p = local(state)?;
    Some(json!({"lobbyCode":state["lobbyCode"],"playerId":p["id"],"clientId":p["clientId"]}))
}
fn same(a: &Value, b: &Value) -> bool {
    ["lobbyCode", "playerId", "clientId"]
        .iter()
        .all(|k| a[*k] == b[*k])
}
#[derive(Default)]
pub struct Remote {
    pub code: String,
    identity: Value,
    peer: String,
    session: String,
    leases: HashMap<String, u64>,
    sequence: u64,
    received: u64,
    accepted: u64,
    last_source: u64,
    pending: VecDeque<(String, Value)>,
}
impl Remote {
    pub fn enable(&mut self, state: &Value) -> Result<(), String> {
        let id = identity(state).ok_or("NoSアドオンのロビーに参加してください")?;
        self.disable();
        self.identity = id;
        self.code = secret()[..12].to_string();
        Ok(())
    }
    pub fn disable(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        let ack = self
            .leases
            .iter()
            .max_by_key(|(_, t)| *t)
            .map(|(lease, _)| {
                let mut ack = self.identity.clone();
                ack["protocol"] = json!(1);
                ack["session"] = json!(self.session);
                ack["lease"] = json!(lease);
                ack["revoked"] = json!(true);
                ack
            });
        let peer = self.peer.clone();
        *self = Self {
            pending,
            ..Default::default()
        };
        if let Some(ack) = ack {
            self.pending
                .push_back((peer, json!({"type":"nos-voice-role","ack":ack})));
        }
    }
    pub fn connected(&self) -> bool {
        !self.code.is_empty() && now().saturating_sub(self.received) < 1000
    }
    pub fn sync(&mut self, state: &Value, own: &str) -> Vec<(String, Value)> {
        let id = identity(state);
        let old = if self.identity.is_null() {
            self.pending
                .front()
                .map(|(_, v)| v["ack"].clone())
                .unwrap_or(Value::Null)
        } else {
            self.identity.clone()
        };
        if !self.identity.is_null() && id.as_ref().is_none_or(|id| !same(id, &self.identity)) {
            self.disable();
        }
        let t = now();
        let mut out: Vec<_> = self.pending.drain(..).collect();
        if !out.is_empty() && !old.is_null() {
            let mut source = old;
            source["type"] = json!("nos-voice-source");
            source["peerId"] = json!(own);
            out.push((
                source["lobbyCode"].as_str().unwrap_or("").to_string(),
                source,
            ));
        }
        if !self.peer.is_empty() && t.saturating_sub(self.last_source) >= 750 {
            self.last_source = t;
            let mut source = self.identity.clone();
            source["type"] = json!("nos-voice-source");
            source["peerId"] = json!(self.peer);
            out.push((
                source["lobbyCode"].as_str().unwrap_or("").to_string(),
                source,
            ));
        }
        out
    }
    pub fn accept(
        &mut self,
        from: &str,
        client: &Value,
        data: &Value,
    ) -> (Option<Value>, Option<Value>) {
        if self.code.is_empty() {
            return (None, None);
        }
        let t = now();
        let matching = |v: &Value| {
            v["protocol"] == 1
                && same(v, &self.identity)
                && client["playerId"] == self.identity["playerId"]
                && client["clientId"] == self.identity["clientId"]
        };
        let release = &data["release"];
        if matching(release)
            && from == self.peer
            && release["session"] == self.session
            && release["lease"]
                .as_str()
                .and_then(|s| self.leases.get(s))
                .is_some_and(|at| t.saturating_sub(*at) <= 2000)
        {
            self.disable();
            return (None, None);
        }
        let req = &data["request"];
        if req.is_object() {
            if !matching(req)
                || req["code"] != self.code
                || !token(&req["session"], 32, false)
                || !self.peer.is_empty()
                    && (from != self.peer || req["session"] != self.session)
                    && t.saturating_sub(self.accepted) < 3000
            {
                return (None, None);
            }
            if from != self.peer || req["session"] != self.session {
                self.sequence = 0;
                self.leases.clear();
                self.received = 0;
            }
            self.peer = from.into();
            self.session = req["session"].as_str().unwrap().into();
            self.accepted = t;
            self.leases.retain(|_, at| t.saturating_sub(*at) <= 2000);
            let lease = secret();
            self.leases.insert(lease.clone(), t);
            let mut ack = self.identity.clone();
            ack["protocol"] = json!(1);
            ack["session"] = json!(self.session);
            ack["lease"] = json!(lease);
            return (Some(json!({"type":"nos-voice-role","ack":ack})), None);
        }
        let sample = &data["sample"];
        if from != self.peer
            || !matching(sample)
            || sample["session"] != self.session
            || !token(&sample["lease"], 32, false)
            || !sample["sequence"]
                .as_u64()
                .is_some_and(|n| n > self.sequence && n <= 9_007_199_254_740_991)
            || !sample["rms"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=1.).contains(&n))
            || !sample["active"].is_boolean()
            || !sample["lease"]
                .as_str()
                .and_then(|l| self.leases.get(l))
                .is_some_and(|at| t.saturating_sub(*at) <= 2000)
            || t.saturating_sub(self.received) < 30
        {
            return (None, None);
        }
        self.sequence = sample["sequence"].as_u64().unwrap();
        self.received = t;
        (None, Some(sample.clone()))
    }
}
#[derive(Default)]
pub struct Sources {
    scope: String,
    sources: HashMap<i64, (String, u64)>,
    host: HashMap<String, (String, u64, u64)>,
}
impl Sources {
    fn scope(&mut self, state: &Value) {
        let scope = state["lobbyCode"].as_str().unwrap_or("");
        if scope != self.scope {
            *self = Self {
                scope: scope.into(),
                ..Default::default()
            };
        }
    }
    pub fn receive(
        &mut self,
        sender: &Value,
        data: &Value,
        state: &Value,
        clients: &Map<String, Value>,
    ) -> bool {
        self.scope(state);
        let Some(peer) = data["peerId"].as_str().filter(|s| s.len() <= 128) else {
            return false;
        };
        if data["lobbyCode"] != state["lobbyCode"]
            || sender["playerId"].is_null()
            || data["playerId"] != sender["playerId"]
            || data["clientId"] != sender["clientId"]
            || clients.get(peer).is_none_or(|c| {
                c["clientId"] != sender["clientId"] || c["playerId"] != sender["playerId"]
            })
        {
            return false;
        }
        let Some(id) = sender["clientId"].as_i64() else {
            return false;
        };
        self.sources.insert(id, (peer.into(), now()));
        true
    }
    pub fn selected(
        &mut self,
        state: &Value,
        clients: &Map<String, Value>,
    ) -> HashMap<i64, String> {
        self.scope(state);
        let mut selected = HashMap::new();
        for (key, c) in clients {
            if let Some(id) = c["clientId"].as_i64() {
                selected.insert(id, key.clone());
            }
        }
        self.sources.retain(|id, (peer, at)| {
            let valid = now().saturating_sub(*at) <= 2500
                && clients
                    .get(peer)
                    .is_some_and(|c| c["clientId"].as_i64() == Some(*id));
            if valid {
                selected.insert(*id, peer.clone());
            }
            valid
        });
        selected
    }
    pub fn host_sample(&mut self, from: &str, client: &Value, data: &Value, state: &Value) -> bool {
        self.scope(state);
        if !flag(state, "isHost")
            || !roles::addon(state)
            || client["playerId"].is_null()
            || data["lobbyCode"] != state["lobbyCode"]
            || data["playerId"] != client["playerId"]
            || data["clientId"] != client["clientId"]
            || !token(&data["session"], 36, true)
            || !data["rms"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=1.).contains(&v))
            || !data["active"].is_boolean()
        {
            return false;
        }
        let Some(seq) = data["sequence"]
            .as_u64()
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        else {
            return false;
        };
        if !state["players"].as_array().is_some_and(|ps| {
            ps.iter().any(|p| {
                p["id"] == client["playerId"]
                    && p["clientId"] == client["clientId"]
                    && p["isDead"] != true
                    && p["disconnected"] != true
            })
        }) {
            return false;
        }
        let t = now();
        let session = data["session"].as_str().unwrap();
        if let Some((s, old, at)) = self.host.get(from) {
            if t.saturating_sub(*at) < 80 || s == session && seq <= *old {
                return false;
            }
        }
        if self.host.len() >= 256 && !self.host.contains_key(from) {
            return false;
        }
        self.host.insert(from.into(), (session.into(), seq, t));
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_lease_replay_expiry_and_revocation() {
        let state = json!({"mod":"NoS","nosAddonIds":["tanuki.bcl.roles"],"gameState":1,"lobbyCode":"ROOM","players":[{"id":1,"clientId":10,"isLocal":true}]});
        let client = json!({"playerId":1,"clientId":10});
        let mut r = Remote::default();
        r.enable(&state).unwrap();
        let request = json!({"request":{"protocol":1,"lobbyCode":"ROOM","playerId":1,"clientId":10,"code":r.code,"session":"a".repeat(32)}});
        let ack = r.accept("phone", &client, &request).0.unwrap();
        let mut sample = ack["ack"].clone();
        sample["sequence"] = json!(1);
        sample["rms"] = json!(0.4);
        sample["active"] = json!(true);
        let mut data = json!({"sample":sample});
        assert!(r.accept("impostor", &client, &data).1.is_none());
        assert!(r.accept("phone", &client, &data).1.is_some());
        assert!(r.connected());
        r.received = now() - 31;
        assert!(
            r.accept("phone", &client, &data).1.is_none(),
            "replayed sequence"
        );
        data["sample"]["sequence"] = json!(2);
        for t in r.leases.values_mut() {
            *t = now() - 2001;
        }
        assert!(
            r.accept("phone", &client, &data).1.is_none(),
            "expired lease"
        );
        r.accepted = now() - 3001;
        let ack = r.accept("phone", &client, &request).0.unwrap();
        assert_ne!(ack["ack"]["lease"], data["sample"]["lease"]);
        r.disable();
        let revoked = r.sync(&state, "desktop");
        assert!(revoked
            .iter()
            .any(|(to, v)| to == "phone" && v["ack"]["revoked"] == true));
        assert!(revoked.iter().any(|(_, v)| v["peerId"] == "desktop"));
        assert!(r.accept("phone", &client, &request).0.is_none());
    }
    #[test]
    fn selected_source_and_host_sample_are_bound_to_current_roster() {
        let state = json!({"mod":"NoS","nosAddonIds":["tanuki.bcl.roles"],"gameState":1,"isHost":true,"lobbyCode":"ROOM","players":[{"id":1,"clientId":10,"isDead":false,"disconnected":false}]});
        let client = json!({"playerId":1,"clientId":10});
        let clients = serde_json::from_value(
            json!({"desktop":client,"phone":client,"stranger":{"playerId":2,"clientId":20}}),
        )
        .unwrap();
        let mut sources = Sources::default();
        let mut source = json!({"lobbyCode":"ROOM","playerId":1,"clientId":10,"peerId":"stranger"});
        assert!(!sources.receive(&client, &source, &state, &clients));
        source["peerId"] = json!("phone");
        assert!(sources.receive(&client, &source, &state, &clients));
        assert_eq!(
            sources
                .selected(&state, &clients)
                .get(&10)
                .map(String::as_str),
            Some("phone")
        );
        sources.sources.get_mut(&10).unwrap().1 = now() - 2501;
        sources.selected(&state, &clients);
        assert!(sources.sources.is_empty());
        let mut sample = json!({"lobbyCode":"ROOM","playerId":1,"clientId":10,"session":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","sequence":1,"rms":0.4,"active":true});
        assert!(sources.host_sample("phone", &client, &sample, &state));
        sources.host.get_mut("phone").unwrap().2 = now() - 81;
        assert!(!sources.host_sample("phone", &client, &sample, &state));
        sample["sequence"] = json!(2);
        let mut dead = state.clone();
        dead["players"][0]["isDead"] = json!(true);
        assert!(!sources.host_sample("phone", &client, &sample, &dead));
        assert!(sources.host_sample("phone", &client, &sample, &state));
        let mut left = state.clone();
        left["lobbyCode"] = json!("OTHER");
        sources.selected(&left, &clients);
        assert!(sources.host.is_empty());
    }
    #[test]
    fn companion_cannot_pair_as_another_server_identity() {
        let state = json!({"mod":"NoS","nosAddonIds":["tanuki.bcl.roles"],"gameState":1,"lobbyCode":"ROOM","players":[{"id":1,"clientId":10,"isLocal":true}]});
        let mut r = Remote::default();
        r.enable(&state).unwrap();
        let data = json!({"request":{"protocol":1,"lobbyCode":"ROOM","playerId":1,"clientId":10,"code":r.code,"session":"a".repeat(32)}});
        assert!(r
            .accept("phone", &json!({"playerId":2,"clientId":20}), &data)
            .0
            .is_none());
        assert!(r
            .accept("phone", &json!({"playerId":1,"clientId":10}), &data)
            .0
            .is_some());
        assert!(!r.connected());
    }
}
