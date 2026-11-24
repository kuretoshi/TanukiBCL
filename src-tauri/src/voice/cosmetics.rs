//! Bounded image relay for the existing OBS and mobile wire protocols.
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
struct Asset {
    source: String,
    id: String,
    png: String,
    len: usize,
    scaled: bool,
    metadata_known: bool,
}
struct Pending {
    source: String,
    task: tokio::task::JoinHandle<Option<(Vec<u8>, bool, bool)>>,
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
    catalog_revision: Option<Instant>,
    catalog_task: Option<tokio::task::JoinHandle<()>>,
    catalog_retry: Option<Instant>,
    refresh: HashSet<String>,
    back_failures: HashMap<String, u8>,
}
impl Drop for Relay {
    fn drop(&mut self) {
        for p in &self.pending {
            p.task.abort();
        }
        if let Some(task) = &self.catalog_task {
            task.abort();
        }
    }
}
fn valid(source: &str) -> bool {
    source.starts_with("nos-cosmetic://image/") && source.len() <= 512
        || source.len() <= 16 * 1024
            && ["hat-front", "hat-back", "visor", "skin"]
                .iter()
                .any(|part| source.starts_with(&format!("snr-cosmetic://{part}/")))
}
fn snr_sources(player: &Value) -> serde_json::Map<String, Value> {
    let outfit = matches!(player["currentOutfit"].as_i64(), Some(1..=10));
    let color = if outfit {
        player["appearanceColorId"].as_i64().filter(|c| *c >= 0)
    } else {
        None
    }
    .or_else(|| player["colorId"].as_i64())
    .unwrap_or(0);
    let hat = appearance(player, "SUPER_NEW_ROLES", "hat");
    let visor = appearance(player, "SUPER_NEW_ROLES", "visor");
    let skin = appearance(player, "SUPER_NEW_ROLES", "skin");
    let hat2 = player["snrHat2Id"].as_str().unwrap_or("");
    let visor2 = player["snrVisor2Id"].as_str().unwrap_or("");
    [
        ("hat", "hat-front", hat.as_str()),
        ("hatBack", "hat-back", hat.as_str()),
        ("skin", "skin", skin.as_str()),
        ("visor", "visor", visor.as_str()),
        ("hat2", "hat-front", hat2),
        ("hat2Back", "hat-back", hat2),
        ("visor2", "visor", visor2),
    ]
    .into_iter()
    .filter(|(_, _, id)| id.starts_with("Modded_") && id.encode_utf16().count() <= 1024)
    .map(|(slot, part, id)| {
        let encoded = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC);
        let adaptive = if part.starts_with("hat")
            && id.starts_with("Modded_Multiverse Costume SEL_")
            || id.to_ascii_lowercase().contains("_adaptive")
        {
            "&adaptive=1"
        } else {
            ""
        };
        (
            slot.into(),
            json!(format!(
                "snr-cosmetic://{part}/{encoded}?color={color}{adaptive}"
            )),
        )
    })
    .collect()
}
impl Relay {
    fn update_catalog(&mut self, revision: Option<Instant>) {
        if revision != self.catalog_revision {
            self.refresh.extend(
                self.cache
                    .iter()
                    .filter(|a| !a.metadata_known && self.active.contains(&a.source))
                    .map(|a| a.source.clone()),
            );
            self.catalog_revision = revision;
        }
    }
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
            if mobile {
                let parts = if state["mod"] == "SUPER_NEW_ROLES" {
                    snr_sources(p)
                } else if state["mod"] == "NoS" {
                    p["nosCosmetics"].as_object().cloned().unwrap_or_default()
                } else {
                    Default::default()
                };
                for source in parts
                    .values()
                    .filter_map(Value::as_str)
                    .filter(|s| valid(s))
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
        let backend = app.map(|app| app.state::<Arc<crate::Backend>>().inner().clone());
        if let Some(backend) = &backend {
            self.update_catalog(backend.cosmetics_catalog_revision());
        }
        self.refresh.retain(|source| self.active.contains(source));
        self.back_failures
            .retain(|source, _| self.active.contains(source));
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
            if let Some((bytes, scaled, metadata_known)) = result.filter(|(b, _, _)| {
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
                if let Some(at) = self.cache.iter().position(|a| a.source == pending.source) {
                    let old = self.cache.remove(at).unwrap();
                    self.bytes -= old.png.len();
                    if old.id != id {
                        self.sent.remove(&old.id);
                    }
                }
                self.refresh.remove(&pending.source);
                if !metadata_known && self.catalog_revision.is_some() {
                    self.refresh.insert(pending.source.clone());
                }
                self.back_failures.remove(&pending.source);
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
                    scaled,
                    metadata_known,
                });
            } else {
                if pending.source.starts_with("snr-cosmetic://hat-back/") {
                    let failures = self
                        .back_failures
                        .entry(pending.source.clone())
                        .or_default();
                    *failures = failures.saturating_add(1);
                }
                if self.retry.len() >= 128 {
                    self.retry.pop_front();
                }
                self.retry.push_back((pending.source, Instant::now()));
            }
        }
        self.retry
            .retain(|(_, t)| t.elapsed() < Duration::from_millis(1500));
        let Some(backend) = backend else { return };
        if self
            .catalog_task
            .as_ref()
            .is_some_and(|task| task.is_finished())
        {
            self.catalog_task = None;
        }
        if self
            .cache
            .iter()
            .any(|a| !a.metadata_known && self.active.contains(&a.source))
            && self.catalog_revision.is_none()
            && self.catalog_task.is_none()
            && self
                .catalog_retry
                .is_none_or(|at| at.elapsed() >= Duration::from_secs(10))
        {
            let catalog_backend = backend.clone();
            self.catalog_retry = Some(Instant::now());
            self.catalog_task = Some(tokio::spawn(async move {
                let _ = catalog_backend
                    .request("main", "native:cosmetics-catalog", vec![], "invoke")
                    .await;
            }));
        }
        for source in &self.active {
            if self.pending.len() >= 4 {
                break;
            }
            if self.cache.iter().any(|a| a.source == *source) && !self.refresh.contains(source)
                || self.pending.iter().any(|p| p.source == *source)
                || self.retry.iter().any(|(s, _)| s == source)
                || self.back_failures.get(source).copied().unwrap_or(0) >= 3
            {
                continue;
            }
            let Ok(url) = tauri::Url::parse(source) else {
                continue;
            };
            let scheme = url.scheme().to_string();
            let path = format!("/{}{}", url.host_str().unwrap_or(""), url.path());
            let query = url.query().unwrap_or("").to_string();
            let backend = backend.clone();
            let task = tokio::spawn(async move {
                let value = backend
                    .request(
                        "main",
                        "__asset",
                        vec![json!(scheme), json!(path), json!(query), json!(true)],
                        "invoke",
                    )
                    .await
                    .ok()?;
                let text = value["png"].as_str().or_else(|| value.as_str())?;
                if text.len() > 720 * 1024 {
                    return None;
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(text)
                    .ok()?;
                Some((
                    bytes,
                    value["snrScaled"] == true,
                    value["snrMetadataKnown"].as_bool().unwrap_or(true),
                ))
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
            let is_snr = state["mod"] == "SUPER_NEW_ROLES";
            let key = if is_snr {
                "snrCosmetics"
            } else {
                "nosCosmetics"
            };
            let sources = if is_snr {
                snr_sources(player)
            } else if state["mod"] == "NoS" {
                player["nosCosmetics"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default()
            } else {
                Default::default()
            };
            let parts: serde_json::Map<String, Value> = sources
                .iter()
                .filter_map(|(part, source)| {
                    let source = source.as_str()?;
                    if !valid(source) {
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
                .collect();
            if let Some(o) = player.as_object_mut() {
                o.remove(if is_snr {
                    "nosCosmetics"
                } else {
                    "snrCosmetics"
                });
            }
            if parts.is_empty() {
                if let Some(o) = player.as_object_mut() {
                    o.remove(key);
                }
            } else {
                player[key] = json!(parts);
            }
            if is_snr {
                let mut scales = serde_json::Map::new();
                for slot in ["visor", "visor2"] {
                    let scaled = sources
                        .get(slot)
                        .and_then(Value::as_str)
                        .and_then(|source| self.cache.iter().find(|asset| asset.source == source))
                        .is_some_and(|asset| asset.scaled);
                    scales.insert(slot.into(), json!(scaled));
                }
                player["snrCosmeticScale"] = json!(scales);
            } else if let Some(object) = player.as_object_mut() {
                object.remove("snrCosmeticScale");
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
        (
            snr_sources(p)
                .get("skin")
                .and_then(Value::as_str)
                .map(str::to_owned),
            None,
        )
    } else {
        (None, None)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn snr_player() -> Value {
        json!({"id":1,"colorId":6,"hatId":"Modded_pack_hat","skinId":"Modded_pack_skin",
            "visorId":"Modded_pack_visor","snrHat2Id":"Modded_pack_hat2","snrVisor2Id":"Modded_pack_visor2"})
    }
    #[test]
    fn snr_mobile_parts_include_both_slots_and_effective_body_color() {
        let mut p = snr_player();
        let sources = snr_sources(&p);
        assert_eq!(sources.len(), 7);
        assert!(sources
            .values()
            .all(|v| v.as_str().unwrap().ends_with("?color=6")));
        assert!(sources["hat2Back"]
            .as_str()
            .unwrap()
            .starts_with("snr-cosmetic://hat-back/"));
        p["currentOutfit"] = json!(1);
        p["appearanceColorId"] = json!(9);
        p["appearanceHatId"] = json!("Modded_other_hat");
        p["appearanceSkinId"] = json!("");
        p["appearanceVisorId"] = json!("visor_EmptyVisor");
        let changed = snr_sources(&p);
        assert_eq!(changed.len(), 5);
        assert!(changed
            .values()
            .all(|v| v.as_str().unwrap().ends_with("?color=9")));
        assert_ne!(changed["hat"], sources["hat"]);
        assert_ne!(changed["hat2"], sources["hat2"]);
        p["snrHat2Id"] = Value::Null;
        p["snrVisor2Id"] = Value::Null;
        assert_eq!(snr_sources(&p).len(), 2);
    }
    #[test]
    fn snr_mobile_reuses_bounded_png_frames_and_special_visor_metadata() {
        let p = snr_player();
        let mut relay = Relay::default();
        let state = json!({"mod":"SUPER_NEW_ROLES","lobbyCode":"TEST","players":[p]});
        let source = snr_sources(&state["players"][0])["visor2"]
            .as_str()
            .unwrap()
            .to_owned();
        relay.active.insert(source.clone());
        relay.cache.push_back(Asset {
            source: source.clone(),
            id: "fixture-sha".into(),
            png: "data:image/png;base64,fixture".into(),
            len: 100,
            scaled: true,
            metadata_known: true,
        });
        let frame = relay.mobile(&state);
        assert_eq!(
            frame["gameState"]["players"][0]["snrCosmetics"]["visor2"],
            "nos-web://fixture-sha"
        );
        assert_eq!(
            frame["gameState"]["players"][0]["snrCosmetics"]["hat2"],
            "nos-web://pending"
        );
        assert_eq!(
            frame["gameState"]["players"][0]["snrCosmeticScale"]["visor2"],
            true
        );
        assert_eq!(
            frame["nosCosmeticAssets"]["fixture-sha"],
            "data:image/png;base64,fixture"
        );
        assert!(relay.mobile(&state).get("nosCosmeticAssets").is_none());
        relay.resend(Some(&json!(["fixture-sha"])));
        relay.last_sent = None;
        assert!(relay.mobile(&state)["nosCosmeticAssets"]
            .get("fixture-sha")
            .is_some());
        let mut changed = state.clone();
        changed["players"][0]["colorId"] = json!(9);
        let changed_frame = relay.mobile(&changed);
        assert_eq!(
            changed_frame["gameState"]["players"][0]["snrCosmetics"]["visor2"],
            "nos-web://pending"
        );
        assert_eq!(
            changed_frame["gameState"]["players"][0]["snrCosmeticScale"]["visor2"],
            false
        );
        relay.reconcile(None, &changed, false, false);
        assert!(relay.cache.is_empty());
        assert!(relay.sent.is_empty());
    }
    #[test]
    fn mobile_frames_clear_snr_images_when_mod_is_absent() {
        let mut p = snr_player();
        p["snrCosmetics"] = json!({"visor2":"private-local-url"});
        p["snrCosmeticScale"] = json!({"visor2":true});
        let frame = Relay::default().mobile(&json!({"mod":"NONE","players":[p]}));
        assert!(frame["gameState"]["players"][0]
            .get("snrCosmetics")
            .is_none());
        assert!(frame["gameState"]["players"][0]
            .get("snrCosmeticScale")
            .is_none());
    }
    async fn complete_asset(
        relay: &mut Relay,
        state: &Value,
        source: &str,
        value: Option<(Vec<u8>, bool, bool)>,
    ) {
        let task = tokio::spawn(async move { value });
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        relay.pending.push(Pending {
            source: source.into(),
            task,
        });
        relay.reconcile(None, state, true, false);
    }
    #[tokio::test]
    async fn late_snr_metadata_refresh_keeps_the_previous_png_until_success() {
        let state = json!({"mod":"SUPER_NEW_ROLES","lobbyCode":"TEST","players":[snr_player()]});
        let mut relay = Relay::default();
        relay.reconcile(None, &state, true, false);
        let source = snr_sources(&state["players"][0])["visor2"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[255, 0, 0, 255])
                .unwrap();
        }
        complete_asset(
            &mut relay,
            &state,
            &source,
            Some((png.clone(), false, false)),
        )
        .await;
        let first =
            relay.mobile(&state)["gameState"]["players"][0]["snrCosmetics"]["visor2"].clone();
        let initial_bytes = relay.bytes;
        relay.update_catalog(Some(Instant::now()));
        assert!(relay.refresh.contains(&source));
        complete_asset(&mut relay, &state, &source, None).await;
        assert_eq!(
            relay.mobile(&state)["gameState"]["players"][0]["snrCosmetics"]["visor2"],
            first
        );
        assert_eq!(relay.bytes, initial_bytes);
        complete_asset(&mut relay, &state, &source, Some((png, true, true))).await;
        let ready = relay.mobile(&state);
        assert_eq!(
            ready["gameState"]["players"][0]["snrCosmetics"]["visor2"],
            first
        );
        assert_eq!(
            ready["gameState"]["players"][0]["snrCosmeticScale"]["visor2"],
            true
        );
        assert!(!relay.refresh.contains(&source));
        assert_eq!(relay.bytes, initial_bytes);
        assert_eq!(relay.cache.len(), 1);
    }
    #[tokio::test]
    async fn absent_optional_back_layers_have_a_session_bound_retry_limit() {
        let state = json!({"mod":"SUPER_NEW_ROLES","lobbyCode":"TEST","players":[snr_player()]});
        let mut relay = Relay::default();
        relay.reconcile(None, &state, true, false);
        let sources = snr_sources(&state["players"][0]);
        let back = sources["hatBack"].as_str().unwrap();
        let front = sources["hat"].as_str().unwrap();
        for _ in 0..3 {
            complete_asset(&mut relay, &state, back, None).await;
        }
        assert_eq!(relay.back_failures.get(back), Some(&3));
        complete_asset(&mut relay, &state, front, None).await;
        assert!(!relay.back_failures.contains_key(front));
        let mut changed = state.clone();
        changed["players"][0]["colorId"] = json!(9);
        relay.reconcile(None, &changed, true, false);
        assert!(relay.back_failures.is_empty());
        relay.reconcile(None, &changed, false, false);
        assert!(relay.retry.is_empty());
    }
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
