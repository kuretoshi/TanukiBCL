//! Versioned radio metadata interoperable with release PeerConnection controls.
use super::{model::*, routing::can_use_radio};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct Remote {
    version: Option<u64>,
    active: bool,
    kind: Option<i64>,
}
pub struct Radio {
    remote: HashMap<i64, Remote>,
    active: bool,
    version: u64,
    sent: Instant,
    kind: Option<i64>,
}
impl Default for Radio {
    fn default() -> Self {
        Self {
            remote: HashMap::new(),
            active: false,
            version: 0,
            sent: Instant::now() - Duration::from_secs(2),
            kind: None,
        }
    }
}
impl Radio {
    pub fn force(&mut self) {
        self.sent = Instant::now() - Duration::from_secs(2);
    }
    pub fn accept(&mut self, client: i64, data: &Value, state: &Value, rules: &Value) {
        let Some(active) = data["impostorRadio"].as_bool() else {
            return;
        };
        let Some(player) = state["players"].as_array().and_then(|ps| {
            ps.iter()
                .find(|p| p["clientId"].as_i64() == Some(client) && !flag(p, "isLocal"))
        }) else {
            return;
        };
        let version = if let Some(value) = data.get("impostorRadioVersion") {
            let Some(n) = value.as_u64().filter(|n| *n <= 9_007_199_254_740_991) else {
                return;
            };
            Some(n)
        } else {
            None
        };
        let kind = if let Some(kind) = data.get("nosRadioKind") {
            let Some(kind @ 0..=1) = kind.as_i64() else {
                return;
            };
            Some(kind)
        } else {
            None
        };
        let nos = state["mod"] == "NoS";
        if active
            && if nos {
                !matches!(state["gameState"].as_i64(), Some(1 | 2))
                    || flag(player, "isDead")
                    || flag(player, "disconnected")
                    || flag(player, "bugged")
            } else {
                !can_use_radio(state, player, rules)
            }
        {
            return;
        }
        if !self.remote.contains_key(&client) && self.remote.len() >= MAX_PEERS {
            return;
        }
        let entry = self.remote.entry(client).or_default();
        if entry
            .version
            .is_some_and(|old| version.is_none_or(|new| new < old))
        {
            return;
        }
        entry.version = version;
        entry.active = active;
        entry.kind = if active { kind } else { None };
    }
    pub fn prune(&mut self, state: &Value, rules: &Value, clients: &HashSet<i64>) {
        self.remote.retain(|id, entry| {
            if !clients.contains(id) {
                return false;
            }
            if !state["players"].as_array().is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["clientId"].as_i64() == Some(*id)
                        && if state["mod"] == "NoS" {
                            matches!(state["gameState"].as_i64(), Some(1 | 2))
                                && !flag(p, "isDead")
                                && !flag(p, "disconnected")
                                && !flag(p, "bugged")
                        } else {
                            can_use_radio(state, p, rules)
                        }
                })
            }) {
                entry.active = false;
            }
            true
        });
    }
    pub fn ids(&self) -> Vec<i64> {
        let mut ids: Vec<_> = self
            .remote
            .iter()
            .filter_map(|(id, value)| value.active.then_some(*id))
            .collect();
        ids.sort_unstable();
        ids
    }
    pub fn kinds(&self) -> HashMap<i64, Option<i64>> {
        self.remote
            .iter()
            .filter_map(|(id, r)| r.active.then_some((*id, r.kind)))
            .collect()
    }
    #[cfg(test)]
    pub fn update_local(&mut self, state: &Value, rules: &Value, held: bool) -> Option<Value> {
        self.update_channels(state, rules, held, 0)
    }
    pub fn update_channels(
        &mut self,
        state: &Value,
        rules: &Value,
        held: bool,
        selected: i64,
    ) -> Option<Value> {
        let kind = if state["mod"] == "NoS"
            && held
            && super::routing::radio_enabled(selected, rules)
            && state["nosRadios"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["kind"].as_i64() == Some(selected)))
        {
            Some(selected)
        } else {
            None
        };
        let active = held
            && local(state).is_some_and(|p| can_use_radio(state, p, rules))
            && (state["mod"] != "NoS" || kind.is_some());
        if active != self.active || kind != self.kind {
            self.active = active;
            self.kind = kind;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            self.version = now.max(self.version.saturating_add(1));
        } else if self.sent.elapsed() < Duration::from_secs(1) {
            return None;
        }
        self.sent = Instant::now();
        Some(self.message())
    }
    pub fn message(&self) -> Value {
        let mut message = json!({"impostorRadio":self.active,"impostorRadioVersion":self.version});
        if let Some(kind) = self.kind {
            message["nosRadioKind"] = json!(kind);
        }
        message
    }
    pub fn active(&self) -> bool {
        self.active
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Value {
        json!({"mod":"NONE","gameState":1,"players":[{"clientId":1,"isLocal":true,"isImpostor":true},{"clientId":2,"isImpostor":true}]})
    }
    #[test]
    fn stale_or_forged_radio_status_cannot_open_a_route() {
        let mut radio = Radio::default();
        let mut state = state();
        let rules = json!({"impostorRadioEnabled":true});
        radio.accept(
            2,
            &json!({"impostorRadio":true,"impostorRadioVersion":10}),
            &state,
            &rules,
        );
        assert_eq!(radio.ids(), vec![2]);
        radio.accept(
            2,
            &json!({"impostorRadio":false,"impostorRadioVersion":11}),
            &state,
            &rules,
        );
        radio.accept(
            2,
            &json!({"impostorRadio":true,"impostorRadioVersion":10}),
            &state,
            &rules,
        );
        radio.accept(2, &json!({"impostorRadio":true}), &state, &rules);
        assert!(radio.ids().is_empty());
        state["players"][1]["isImpostor"] = json!(false);
        radio.accept(
            2,
            &json!({"impostorRadio":true,"impostorRadioVersion":12}),
            &state,
            &rules,
        );
        radio.accept(
            1,
            &json!({"impostorRadio":true,"impostorRadioVersion":12}),
            &state,
            &rules,
        );
        assert!(radio.ids().is_empty());
    }
    #[test]
    fn role_death_disconnect_and_room_changes_clear_radios() {
        let mut radio = Radio::default();
        let mut state = state();
        let rules = json!({"impostorRadioOnlyMode":true});
        radio.accept(
            2,
            &json!({"impostorRadio":true,"impostorRadioVersion":1}),
            &state,
            &rules,
        );
        state["players"][1]["isDead"] = json!(true);
        radio.prune(&state, &rules, &HashSet::from([2]));
        assert!(radio.ids().is_empty());
        radio.prune(&state, &rules, &HashSet::new());
        assert!(radio.remote.is_empty());
        radio.update_local(&state, &rules, true);
        assert!(radio.active());
        state["players"][0]["isDead"] = json!(true);
        let stopped = radio.update_local(&state, &rules, true).unwrap();
        assert_eq!(stopped["impostorRadio"], false);
    }
}
