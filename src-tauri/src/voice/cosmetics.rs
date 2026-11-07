//! Bounded image relay for the existing OBS and mobile wire protocols.
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
struct Asset {
    source: String,
    id: String,
    png: String,
    len: usize,
}
struct Pending {
    source: String,
    task: tokio::task::JoinHandle<Option<Vec<u8>>>,
}
#[derive(Default)]
pub struct Relay {
    scope: String,
    cache: VecDeque<Asset>,
    bytes: usize,
    pending: Vec<Pending>,
    active: HashSet<String>,
    obs: HashSet<String>,
    sent: HashSet<String>,
    retry: VecDeque<(String, Instant)>,
    requests: VecDeque<(String, String)>,
    last_sent: Option<Instant>,
}
impl Drop for Relay {
    fn drop(&mut self) {
        for p in &self.pending {
            p.task.abort();
        }
    }
}
fn valid(source: &str) -> bool {
    source.len() <= 512
        && (source.starts_with("nos-cosmetic://image/")
            || source.starts_with("snr-cosmetic://skin/"))
}
impl Relay {
    pub fn reconcile(&mut self, app: Option<&AppHandle>, state: &Value, mobile: bool, obs: bool) {
        let scope = format!("{}:{}:{}:{}", state["lobbyCode"], state["mod"], mobile, obs);
        if scope != self.scope {
            *self = Self::default();
            self.scope = scope;
        }
        if !mobile && !obs {
            return;
        }
        self.active.clear();
        self.obs.clear();
        for p in state["players"].as_array().into_iter().flatten() {
            if mobile && state["mod"] == "NoS" {
                for source in p["nosCosmetics"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(_, v)| v.as_str())
                    .filter(|s| s.starts_with("nos-cosmetic://image/") && s.len() <= 512)
                {
                    self.active.insert(source.into());
                }
            }
            if obs {
                let (skin, mask) = sources(p, state["mod"].as_str().unwrap_or(""));
                for source in [skin, mask].into_iter().flatten().filter(|s| valid(s)) {
                    self.active.insert(source.clone());
                    self.obs.insert(source);
                }
            }
        }
        let mut i = 0;
        while i < self.pending.len() {
            if !self.pending[i].task.is_finished() {
                i += 1;
                continue;
            }
            let pending = self.pending.swap_remove(i);
            let result = futures_util::FutureExt::now_or_never(pending.task)
                .and_then(Result::ok)
                .flatten();
            if let Some(bytes) = result.filter(|b| {
                self.active.contains(&pending.source)
                    && b.len() >= 24
                    && b.len() <= 512 * 1024
                    && b.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
            }) {
                let id = format!("{:x}", Sha256::digest(&bytes));
                let png = format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                );
                while self.bytes + png.len() > 8 * 1024 * 1024 || self.cache.len() >= 128 {
                    let Some(old) = self.cache.pop_front() else {
                        break;
                    };
                    self.bytes -= old.png.len();
                    self.sent.remove(&old.id);
                }
                self.bytes += png.len();
                self.cache.push_back(Asset {
                    source: pending.source,
                    id,
                    png,
                    len: bytes.len(),
                });
            } else {
                if self.retry.len() >= 128 {
                    self.retry.pop_front();
                }
                self.retry.push_back((pending.source, Instant::now()));
            }
        }
        self.retry
            .retain(|(_, t)| t.elapsed() < Duration::from_millis(1500));
        let Some(app) = app else { return };
        for source in &self.active {
            if self.pending.len() >= 4 {
                break;
            }
            if self.cache.iter().any(|a| a.source == *source)
                || self.pending.iter().any(|p| p.source == *source)
                || self.retry.iter().any(|(s, _)| s == source)
            {
                continue;
            }
            let Ok(url) = tauri::Url::parse(source) else {
                continue;
            };
            let scheme = url.scheme().to_string();
            let path = format!("/{}{}", url.host_str().unwrap_or(""), url.path());
            let query = url.query().unwrap_or("").to_string();
            let backend = app.state::<Arc<crate::Backend>>().inner().clone();
            let task = tokio::spawn(async move {
                let value = backend
                    .request(
                        "main",
                        "__asset",
                        vec![json!(scheme), json!(path), json!(query)],
                        "invoke",
                    )
                    .await
                    .ok()?;
                let text = value.as_str()?;
                if text.len() > 720 * 1024 {
                    return None;
                }
                base64::engine::general_purpose::STANDARD.decode(text).ok()
            });
            self.pending.push(Pending {
                source: source.clone(),
                task,
            });
        }
    }
    pub fn resend(&mut self, ids: Option<&Value>) {
        if let Some(ids) = ids.and_then(Value::as_array) {
            for id in ids.iter().take(75).filter_map(Value::as_str) {
                self.sent.remove(id);
            }
        } else {
            self.sent.clear();
        }
    }
    pub fn mobile(&mut self, state: &Value) -> Value {
        let mut frame = state.clone();
        if let Some(o) = frame.as_object_mut() {
            o.remove("nosLoadedContents");
        }
        for player in frame["players"].as_array_mut().into_iter().flatten() {
            let parts: serde_json::Map<String, Value> = if state["mod"] == "NoS" {
                player["nosCosmetics"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(part, source)| {
                        let source = source.as_str()?;
                        if !source.starts_with("nos-cosmetic://image/") {
                            return None;
                        }
                        let id = self
                            .cache
                            .iter()
                            .find(|a| a.source == source)
                            .map(|a| a.id.as_str())
                            .unwrap_or("pending");
                        Some((part.clone(), json!(format!("nos-web://{id}"))))
                    })
                    .collect()
            } else {
                Default::default()
            };
            if parts.is_empty() {
                if let Some(o) = player.as_object_mut() {
                    o.remove("nosCosmetics");
                }
            } else {
                player["nosCosmetics"] = json!(parts);
            }
        }
        let mut result = json!({"gameState":frame});
        if state["mod"] == "NoS" {
            result["nosVoiceFrameTime"] = json!(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64);
        }
        if self
            .last_sent
            .is_none_or(|t| t.elapsed() >= Duration::from_millis(100))
        {
            if let Some(asset) = self.cache.iter().find(|a| {
                a.len <= 192 * 1024 && self.active.contains(&a.source) && !self.sent.contains(&a.id)
            }) {
                self.sent.insert(asset.id.clone());
                self.last_sent = Some(Instant::now());
                let mut images = serde_json::Map::new();
                images.insert(asset.id.clone(), json!(asset.png));
                result["nosCosmeticAssets"] = json!(images);
            }
        }
        result
    }
    pub fn request(&mut self, from: &str, requested: &Value) {
        if from.len() > 128 {
            return;
        }
        for source in requested
            .as_array()
            .into_iter()
            .flatten()
            .take(4)
            .filter_map(Value::as_str)
        {
            if self.obs.contains(source) && self.requests.len() < 16 {
                self.requests.push_back((from.into(), source.into()));
            }
        }
    }
    pub fn responses(&mut self) -> Vec<(String, Value)> {
        let mut result = Vec::new();
        let mut pending = VecDeque::new();
        for (to, source) in self.requests.drain(..) {
            if !self.obs.contains(&source) {
                continue;
            }
            if let Some(asset) = self.cache.iter().find(|a| a.source == source) {
                result.push((
                    to,
                    json!({"type":"obs-cosmetic","source":source,"png":asset.png}),
                ));
            } else {
                pending.push_back((to, source));
            }
        }
        self.requests = pending;
        result
    }
}
pub fn appearance(p: &Value, mod_id: &str, kind: &str) -> String {
    if mod_id == "NoS" {
        if let Some(name) = p["nosPlayer"][kind]["name"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            return name.into();
        }
    }
    let original = p[format!("{kind}Id")].as_str().unwrap_or("");
    let key = format!(
        "appearance{}Id",
        format!("{}{}", kind[..1].to_uppercase(), &kind[1..])
    );
    let current = p[&key].as_str().unwrap_or("");
    if p["currentOutfit"]
        .as_i64()
        .is_some_and(|n| (1..=10).contains(&n))
        || current.starts_with("Modded_")
    {
        current.into()
    } else {
        original.into()
    }
}
pub fn sources(p: &Value, mod_id: &str) -> (Option<String>, Option<String>) {
    let nos = |part: &str| {
        p["nosCosmetics"][part]
            .as_str()
            .filter(|s| s.starts_with("nos-cosmetic://image/"))
            .map(str::to_string)
    };
    if mod_id == "NoS" {
        (nos("skin"), nos("bodyMask"))
    } else if mod_id == "SUPER_NEW_ROLES" {
        let skin = appearance(p, mod_id, "skin");
        (
            (skin.starts_with("Modded_")).then(|| {
                format!(
                    "snr-cosmetic://skin/{}",
                    percent_encoding::utf8_percent_encode(
                        &skin,
                        percent_encoding::NON_ALPHANUMERIC
                    )
                )
            }),
            None,
        )
    } else {
        (None, None)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_urls_are_content_addressed_without_exposing_game_paths() {
        let mut relay = Relay::default();
        let state = json!({"mod":"NoS","players":[{"nosCosmetics":{"hat":"nos-cosmetic://image/test"}}],"nosLoadedContents":{"path":"private-game-path"}});
        let result = relay.mobile(&state);
        assert_eq!(
            result["gameState"]["players"][0]["nosCosmetics"]["hat"],
            "nos-web://pending"
        );
        assert!(result["gameState"].get("nosLoadedContents").is_none());
    }
}
