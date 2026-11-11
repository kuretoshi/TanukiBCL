//! Bounded, local, pure routing probe for comparing with the release TS oracle.
use super::{geometry, model};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    state: Value,
    #[serde(default)]
    rules: Value,
    #[serde(default)]
    shared: Value,
    #[serde(default)]
    preferences: model::Preferences,
    #[serde(default = "other")]
    other_client: i64,
    #[serde(default)]
    radios: Vec<i64>,
}
fn other() -> i64 {
    2
}
pub fn run(input: &Path, output: &Path) -> Result<(), String> {
    if fs::metadata(input).map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("Routing input exceeds the size limit".into());
    }
    let cases: Vec<Case> = serde_json::from_slice(&fs::read(input).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if cases.len() > 20_000 {
        return Err("Too many routing cases".into());
    }
    let results: Vec<_> = cases.iter().map(|c| {
        let state = &c.state;
        let players = state["players"].as_array();
        let me = model::local(state);
        let other = players.and_then(|ps| ps.iter().find(|p| p["clientId"].as_i64() == Some(c.other_client)));
        let blocked = me.zip(other).map(|(me, other)| geometry::blocks(
            state["map"].as_i64().unwrap_or(6),
            [model::number(me, "x", 0.0), model::number(me, "y", 0.0)],
            [model::number(other, "x", 0.0), model::number(other, "y", 0.0)],
            &state["closedDoors"],
        ));
        let routing = super::routing::route(state,c.other_client,&c.rules,&c.preferences,&c.shared,&c.radios);
        json!({"blocked":blocked,"distance":me.and_then(|p| model::hearing_distance(state, &c.rules, p)),"gains":routing.gains,"effects":routing.effects})
    }).collect();
    fs::write(
        output,
        serde_json::to_vec(&results).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
