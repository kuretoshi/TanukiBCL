use super::{
    helper::{Broker, Kind},
    memory::*,
    nos, snr, toh,
};
use crate::native::memory::Process;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct Detection {
    pub id: String,
    pub files: Vec<String>,
}
pub fn detect(process: &Process) -> Detection {
    let root = process.path.parent().unwrap_or(Path::new("."));
    let mut files: Vec<String> = if root.join("winhttp.dll").is_file() {
        fs::read_dir(root.join("BepInEx/plugins"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|s| s.eq_ignore_ascii_case("dll"))
            })
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .take(4096)
            .collect()
    } else {
        Vec::new()
    };
    files.sort();
    if let Ok(modules) = process.modules() {
        for (name, id) in [
            ("SuperNewRoles.dll", "SUPER_NEW_ROLES"),
            ("Nebula.dll", "NoS"),
            ("TownOfHost_ForE_EM.dll", "TOH4E"),
            ("TownOfHost_ForE.dll", "TOH4E"),
            ("TownOfHostForE_EM.dll", "TOH4E"),
            ("TownOfHostForE.dll", "TOH4E"),
        ] {
            if let Some((_, path)) = modules.iter().find(|(module, path)| {
                module.eq_ignore_ascii_case(name)
                    && path
                        .file_name()
                        .is_some_and(|p| p.eq_ignore_ascii_case(name))
            }) {
                files.push(path.to_string_lossy().into_owned());
                return Detection {
                    id: id.into(),
                    files,
                };
            }
        }
    }
    let id = detect_files(&process.path, &files);
    Detection {
        id: id.into(),
        files,
    }
}
fn detect_files(path: &Path, files: &[String]) -> &'static str {
    if path.components().any(|p| {
        p.as_os_str()
            .to_string_lossy()
            .to_ascii_uppercase()
            .contains("TOH4E")
    }) {
        return "TOH4E";
    }
    for file in files {
        let name = file.to_ascii_lowercase();
        let compact = name.replace(['_', '-'], "");
        if compact.ends_with("townofhostfore.dll") || compact.ends_with("townofhostforeem.dll") {
            return "TOH4E";
        }
        for (prefix, id) in [
            ("supernewroles", "SUPER_NEW_ROLES"),
            ("townofusmira", "TOWN_OF_US_MIRA"),
            ("townofus", "TOWN_OF_US"),
            ("theotherroles", "THE_OTHER_ROLES"),
            ("lasmonjas", "LAS_MONJAS"),
            ("nebula", "NoS"),
        ] {
            if name.contains(prefix) {
                return id;
            }
        }
    }
    "NONE"
}

pub struct Live {
    resources: PathBuf,
    pid: u32,
    detection: Detection,
    detect_at: Instant,
    scope: String,
    session: u64,
    broker: Option<Broker>,
    pending: HashSet<Kind>,
    next: HashMap<Kind, Instant>,
    nos: Option<nos::Layout>,
    palette: Option<Value>,
    roles: Value,
    roles_at: Option<Instant>,
    snr: Option<snr::Layout>,
    snr_metadata: Value,
    toh: Option<toh::Layout>,
    publication: Option<u64>,
    fresh: Option<Instant>,
    failed_since: Option<Instant>,
    pub message: String,
    addons: super::zip::Addons,
    addon_ids: Vec<String>,
    addon: super::addon::Reader,
    push: super::push::Tracker,
    cosmetics: std::sync::Arc<std::sync::Mutex<super::cosmetics::Cosmetics>>,
    link: std::sync::Arc<std::sync::Mutex<super::link::Link>>,
}
impl Live {
    pub fn new(
        resources: PathBuf,
        cosmetics: std::sync::Arc<std::sync::Mutex<super::cosmetics::Cosmetics>>,
        link: std::sync::Arc<std::sync::Mutex<super::link::Link>>,
    ) -> Self {
        Self {
            resources,
            pid: 0,
            detection: Detection::default(),
            detect_at: Instant::now(),
            scope: String::new(),
            session: 0,
            broker: None,
            pending: HashSet::new(),
            next: HashMap::new(),
            nos: None,
            palette: None,
            roles: Value::Null,
            roles_at: None,
            snr: None,
            snr_metadata: Value::Null,
            toh: None,
            publication: None,
            fresh: None,
            failed_since: None,
            message: String::new(),
            addons: super::zip::Addons::default(),
            addon_ids: Vec::new(),
            addon: super::addon::Reader::default(),
            push: super::push::Tracker::default(),
            cosmetics,
            link,
        }
    }
    pub fn clear(&mut self) {
        let resources = self.resources.clone();
        let cosmetics = self.cosmetics.clone();
        cosmetics.lock().unwrap().clear();
        let link = self.link.clone();
        link.lock().unwrap().clear();
        *self = Self::new(resources, cosmetics, link);
    }
    pub fn detection(&self) -> &Detection {
        &self.detection
    }
    fn request(&mut self, kind: Kind, process: &Process, interval: Duration) {
        if self.pending.contains(&kind)
            || self.next.get(&kind).is_some_and(|at| Instant::now() < *at)
        {
            return;
        }
        if self
            .broker
            .as_ref()
            .is_some_and(|b| b.submit(kind, process.pid, process.x64, self.session))
        {
            self.pending.insert(kind);
            self.next.insert(kind, Instant::now() + interval);
        }
    }
    fn replies(&mut self, process: &Process) {
        let replies: Vec<_> = self
            .broker
            .as_ref()
            .map(|b| b.receiver.try_iter().collect())
            .unwrap_or_default();
        for reply in replies {
            if reply.session != self.session {
                continue;
            }
            self.pending.remove(&reply.kind);
            let result = reply.value.and_then(|value| {
                match reply.kind {
                    Kind::NosLayout => {
                        self.nos = Some(nos::Layout::parse(&value["metadata"], process.pid)?);
                        self.publication = None;
                        self.fresh = None;
                    }
                    Kind::NosPalette => {
                        self.palette = Some(value["metadata"].clone());
                    }
                    Kind::NosRoles => {
                        valid_roles(&value["metadata"])?;
                        self.roles = value["metadata"].clone();
                        self.roles_at = Some(Instant::now());
                    }
                    Kind::Snr => {
                        self.snr = Some(snr::Layout::parse(&value["liveLayout"], process.pid)?);
                        self.snr_metadata = value["players"].clone();
                    }
                    Kind::Toh => {
                        self.toh = Some(toh::Layout::parse(&value["layout"], process.pid)?);
                    }
                }
                Ok(())
            });
            if let Err(error) = result {
                if reply.kind == Kind::NosRoles {
                    self.roles = Value::Null;
                    self.roles_at = None;
                }
                self.message = error;
                self.next.insert(
                    reply.kind,
                    Instant::now()
                        + Duration::from_secs(if matches!(reply.kind, Kind::NosLayout) {
                            3
                        } else {
                            10
                        }),
                );
            }
        }
    }
    pub fn update(&mut self, process: &Process, state: &mut Value, base_palette: &[[String; 2]]) {
        if self.pid != process.pid {
            self.clear();
            self.pid = process.pid;
        }
        if self.detection.id.is_empty() || Instant::now() >= self.detect_at {
            self.detection = detect(process);
            self.addon_ids = if self.detection.id == "NoS" {
                self.addons
                    .ids(process.path.parent().unwrap_or(Path::new(".")))
            } else {
                Vec::new()
            };
            self.detect_at = Instant::now() + Duration::from_secs(2);
        }
        state["mod"] = json!(self.detection.id);
        if self.detection.id == "NoS" {
            state["nosAddonIds"] = json!(self.addon_ids);
        }
        let phase = state["gameState"].as_i64().unwrap_or(3);
        let active = phase == 1 || phase == 2;
        if !["NoS", "SUPER_NEW_ROLES", "TOH4E"].contains(&self.detection.id.as_str())
            || !matches!(phase, 0..=2)
        {
            self.broker = None;
            self.pending.clear();
            self.scope.clear();
            self.nos = None;
            self.palette = None;
            self.roles = Value::Null;
            self.snr = None;
            self.toh = None;
            return;
        }
        let scope = format!(
            "{}:{}:{}:{}",
            process.pid, self.detection.id, state["lobbyCode"], active
        );
        if self.scope != scope {
            self.scope = scope;
            self.session = self.session.wrapping_add(1);
            self.broker = Some(Broker::new(self.resources.clone()));
            self.pending.clear();
            self.next.clear();
            self.nos = None;
            self.palette = None;
            self.roles = Value::Null;
            self.roles_at = None;
            self.snr = None;
            self.snr_metadata = Value::Null;
            self.toh = None;
            self.publication = None;
            self.fresh = None;
            self.failed_since = None;
        }
        self.replies(process);
        let read = |address, size| process.bytes(address, size);
        match self.detection.id.as_str() {
            "NoS" => {
                if self.nos.is_none() {
                    self.request(Kind::NosLayout, process, Duration::from_secs(3));
                }
                if active {
                    self.request(Kind::NosRoles, process, Duration::from_secs(2));
                } else if self.palette.is_none() {
                    self.request(Kind::NosPalette, process, Duration::from_secs(30));
                }
                let snapshot = self.nos.as_ref().map(|l| l.read(&read)).transpose();
                let mut snapshot = match snapshot {
                    Ok(Some(value)) => {
                        let publication = value["publication"].as_u64();
                        if self.publication.is_some() && self.publication != publication {
                            self.fresh = Some(Instant::now());
                        }
                        self.publication = publication;
                        if self
                            .fresh
                            .is_some_and(|at| at.elapsed() <= Duration::from_secs(3))
                        {
                            self.failed_since = None;
                            Some(value)
                        } else {
                            None
                        }
                    }
                    Ok(None) => None,
                    Err(error) => {
                        self.message = error;
                        None
                    }
                };
                if snapshot.is_none() {
                    let since = *self.failed_since.get_or_insert(Instant::now());
                    if since.elapsed() >= Duration::from_secs(5) {
                        self.nos = None;
                        self.failed_since = None;
                        self.publication = None;
                        self.fresh = None;
                    }
                } else {
                    self.message = "NoSスナップショットを自動更新中".into();
                }
                let colors = if !active {
                    self.palette
                        .as_ref()
                        .and_then(|l| nos::palette(l, process.pid, &read).ok())
                } else {
                    None
                };
                if self
                    .roles_at
                    .is_none_or(|at| at.elapsed() > Duration::from_secs(5))
                {
                    self.roles = Value::Null;
                }
                let schema = self.nos.as_ref().map(|l| l.schema);
                let complete = enrich_nos(
                    state,
                    snapshot.as_ref(),
                    colors.as_ref(),
                    &self.roles,
                    schema,
                    &read,
                );
                {
                    let mut cosmetics = self.cosmetics.lock().unwrap();
                    cosmetics.update(process.path.parent().unwrap_or(Path::new(".")));
                    let palette = json!(base_palette);
                    for p in state["players"].as_array_mut().into_iter().flatten() {
                        p["nosCosmetics"] = cosmetics.player(p, phase == 0, &palette);
                    }
                }
                let linked = self.link.lock().unwrap().update(
                    process.pid,
                    state,
                    &snapshot
                        .as_ref()
                        .map(|s| s["addonData"].clone())
                        .unwrap_or(Value::Null),
                );
                if let Some(fields) = self
                    .addon
                    .update(process.pid, state, snapshot.as_ref(), linked.as_ref())
                    .as_object()
                {
                    for (key, value) in fields {
                        state[key] = value.clone();
                    }
                }
                if let Some(snapshot) = snapshot.take() {
                    state["nosLocalMicPosition"] = snapshot["localMicPosition"].clone();
                    state["nosLocalIsPseudocide"] = snapshot["localIsPseudocide"].clone();
                    state["nosRadios"] = snapshot["radios"].clone();
                }
                state["nosReadStatus"] = json!({"failed":active&&!complete,"message":self.message,"schemaVersion":schema});
            }
            "SUPER_NEW_ROLES" => {
                self.cosmetics
                    .lock()
                    .unwrap()
                    .snr
                    .update(process.path.parent().unwrap_or(Path::new(".")));
                if active {
                    self.request(
                        Kind::Snr,
                        process,
                        Duration::from_secs(if self.snr.is_some() { 5 } else { 10 }),
                    );
                }
                let rows = if active {
                    self.snr.as_ref().and_then(|l| l.read(&read).ok())
                } else {
                    None
                };
                enrich_snr(state, rows.as_ref(), &self.snr_metadata);
                self.push
                    .update(&self.resources, process.pid, process.x64, state);
                if phase == 2 {
                    state["snrMeeting"] = self
                        .snr
                        .as_ref()
                        .and_then(|l| l.meeting(&read))
                        .unwrap_or(Value::Null);
                }
            }
            "TOH4E" => {
                if self.toh.is_none() {
                    self.request(Kind::Toh, process, Duration::from_secs(3));
                }
                let rows = self.toh.as_ref().and_then(|l| l.read(&read).ok());
                enrich_toh(state, rows.as_ref());
                state["tohRoleCatalog"] = self
                    .toh
                    .as_ref()
                    .map(|l| l.catalog())
                    .unwrap_or_else(|| json!([]));
                if rows
                    .as_ref()
                    .and_then(Value::as_array)
                    .is_some_and(|rs| rs.iter().any(|r| r[1]["isKiller"].is_null()))
                {
                    self.request(Kind::Toh, process, Duration::from_secs(3));
                }
            }
            _ => {}
        }
    }
}
fn valid_roles(value: &Value) -> Result<(), String> {
    let rows = value
        .as_array()
        .filter(|r| r.len() <= 64)
        .ok_or("Invalid NoS role rows")?;
    let mut ids = HashSet::new();
    for row in rows {
        let id = uint(&row["playerId"], 255)?;
        let r = &row["role"];
        if !ids.insert(id)
            || (!r["roleId"].is_null() && r["roleId"].as_u64().is_none())
            || !["roleName", "displayName"].iter().all(|key| {
                r[*key].is_null()
                    || r[*key]
                        .as_str()
                        .is_some_and(|s| s.encode_utf16().count() <= 512)
            })
            || !r["runtimeClass"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 1024)
            || (!r["isRainbowStar"].is_null() && !r["isRainbowStar"].is_boolean())
        {
            return Err("Invalid NoS role".into());
        }
    }
    Ok(())
}
fn body_type(layout: &Value, id: u64, read: &Read<'_>) -> Result<Value, String> {
    let ps = match layout["pointerSize"].as_u64() {
        Some(4) => 4,
        Some(8) => 8,
        _ => return Err("Invalid NoS native pointer size".into()),
    };
    for key in ["controlAddress", "controlClass", "cosmeticsClass"] {
        if pointer_field(&layout[key], ps)? <= 0x10000 {
            return Err("Invalid NoS native pointer".into());
        }
    }
    for key in ["playerIdOffset", "cosmeticsOffset", "bodyTypeOffset"] {
        if uint(&layout[key], 4096)? < (2 * ps) as u64 {
            return Err("Invalid NoS native field".into());
        }
    }
    let n = |key: &str| layout[key].as_u64().unwrap();
    let control = n("controlAddress");
    if ptr(read, control, ps)? != n("controlClass")
        || read(control + n("playerIdOffset"), 1)?[0] as u64 != id
    {
        return Err("NoS native player identity changed".into());
    }
    let cosmetics = ptr(read, control + n("cosmeticsOffset"), ps)?;
    if !pointer_valid(cosmetics, ps) || ptr(read, cosmetics, ps)? != n("cosmeticsClass") {
        return Err("NoS cosmetics class changed".into());
    }
    let body = i32_at(&read(cosmetics + n("bodyTypeOffset"), 4)?, 0)?;
    if !(0..=32).contains(&body)
        || ptr(read, control, ps)? != n("controlClass")
        || read(control + n("playerIdOffset"), 1)?[0] as u64 != id
        || ptr(read, control + n("cosmeticsOffset"), ps)? != cosmetics
    {
        return Err("NoS native body changed".into());
    }
    Ok(json!(body))
}
fn enrich_nos(
    state: &mut Value,
    snapshot: Option<&Value>,
    colors: Option<&Value>,
    roles: &Value,
    schema: Option<u64>,
    read: &Read<'_>,
) -> bool {
    let mut complete = snapshot.is_some();
    for p in state["players"].as_array_mut().into_iter().flatten() {
        let id = p["id"].as_u64();
        let connected = p["disconnected"] != true;
        let published = connected
            .then(|| {
                snapshot
                    .and_then(|s| s["players"].as_array())
                    .and_then(|rows| rows.iter().find(|row| row["playerId"].as_u64() == id))
            })
            .flatten();
        if connected && published.is_none() {
            complete = false;
        }
        p["nosPlayer"] = published.cloned().unwrap_or(Value::Null);
        p["nosLobbyColor"] = if connected {
            colors
                .and_then(|cs| id.and_then(|id| cs.get(id as usize)))
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        p["isImpostor"] = json!(published.is_some_and(|p| p["isImpostor"] == true));
        p["isThirdParty"] = json!(published.is_some_and(|p| p["isNeutral"] == true));
        p["roleName"] = json!(if let Some(data) = published {
            let labels = [
                ("isImpostor", "Impostor"),
                ("isCrewmate", "Crewmate"),
                ("isNeutral", "Neutral"),
            ]
            .iter()
            .filter_map(|(key, label)| (data[*key] == true).then_some(*label))
            .collect::<Vec<_>>();
            format!(
                "NoS: {}",
                if labels.is_empty() {
                    "Unknown".into()
                } else {
                    labels.join(" / ")
                }
            )
        } else {
            "NoS陣営未取得".into()
        });
        if let Some(data) = published {
            p["appearanceName"] = data["name"].clone();
        }
        let row = connected
            .then(|| {
                roles
                    .as_array()
                    .and_then(|rows| rows.iter().find(|r| r["playerId"].as_u64() == id))
            })
            .flatten();
        let mut role = row.map(|r| r["role"].clone()).unwrap_or(Value::Null);
        if role.is_object() {
            let body = if schema.is_some_and(|v| v >= 20261009) {
                published
                    .map(|p| p["bodyType"].clone())
                    .unwrap_or(Value::Null)
            } else {
                row.filter(|r| r["role"]["roleName"] == "berserker")
                    .and_then(|r| id.and_then(|id| body_type(&r["bodyLayout"], id, read).ok()))
                    .unwrap_or(Value::Null)
            };
            role["bodyType"] = body.clone();
            role["isBerserking"] = if role["roleName"] == "berserker" && !body.is_null() {
                json!(body == 2)
            } else {
                Value::Null
            };
            let label = role["displayName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| role["roleName"].as_str().filter(|s| !s.is_empty()))
                .unwrap_or("役職名未取得");
            p["roleName"] = json!(format!("NoS: {label}"));
        }
        p["nosRole"] = role;
    }
    complete
}
fn enrich_snr(state: &mut Value, rows: Option<&Value>, metadata: &Value) {
    for p in state["players"].as_array_mut().into_iter().flatten() {
        let role = if p["disconnected"] == true {
            None
        } else {
            rows.and_then(Value::as_array)
                .and_then(|rs| rs.iter().find(|r| r[0] == p["id"]))
        };
        let mut role = role.map(|r| r[1].clone()).unwrap_or(Value::Null);
        if role.is_object() {
            let matching = metadata.as_array().and_then(|rs| {
                rs.iter().find(|r| {
                    r["playerId"] == p["id"] && r["role"]["value"] == role["role"]["value"]
                })
            });
            if let Some(m) = matching {
                for key in [
                    "isNeutral",
                    "canKill",
                    "assignedTeam",
                    "winnerTeam",
                    "teamTag",
                    "hat2Id",
                    "visor2Id",
                ] {
                    role[key] = m[key].clone();
                }
            }
            if role["role"]["name"]
                .as_str()
                .is_some_and(|s| ["Jackal", "WaveCannonJackal"].contains(&s))
            {
                role["isNeutral"] = json!(true);
                role["canKill"] = json!(true);
            }
            let label = role["role"]["name"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("RoleId({})", role["role"]["value"]));
            let modifier = if role["modifier"]["value"].as_i64().is_some_and(|v| v != 0) {
                format!(
                    " + {}",
                    role["modifier"]["name"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!(
                            "ModifierRoleId({})",
                            role["modifier"]["value"]
                        ))
                )
            } else {
                String::new()
            };
            p["roleName"] = json!(format!("{label}{modifier}"));
        } else {
            p["roleName"] = json!("SNR役職未取得");
        }
        p["snrHat2Id"] = role["hat2Id"].clone();
        p["snrVisor2Id"] = role["visor2Id"].clone();
        p["snrRole"] = role;
    }
}
fn enrich_toh(state: &mut Value, rows: Option<&Value>) {
    for p in state["players"].as_array_mut().into_iter().flatten() {
        let role = if p["disconnected"] == true {
            None
        } else {
            rows.and_then(Value::as_array)
                .and_then(|rs| rs.iter().find(|r| r[0] == p["id"]))
        };
        p["tohRole"] = role.map(|r| r[1].clone()).unwrap_or(Value::Null);
        p["vanillaIsImpostor"] = p["isImpostor"].clone();
        p["isImpostor"] =
            json!(p["vanillaIsImpostor"] == true && p["tohRole"]["customRoleType"] == "Impostor");
        p["roleName"] = json!(p["tohRole"]["roleName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| format!("TOH4E: {s}"))
            .unwrap_or_else(|| "TOH4E役職未取得".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mod_detection_recognizes_launcher_and_historical_names() {
        assert_eq!(
            detect_files(Path::new("D:/Games/AmongUs TOH4E_EM/GameAssembly.dll"), &[]),
            "TOH4E"
        );
        assert_eq!(
            detect_files(
                Path::new("D:/Games/AmongUs/GameAssembly.dll"),
                &["TownOfHost_ForE_EM.dll".into()]
            ),
            "TOH4E"
        );
        assert_eq!(
            detect_files(
                Path::new("D:/Games/AmongUs/GameAssembly.dll"),
                &["TownOfUsMira.dll".into()]
            ),
            "TOWN_OF_US_MIRA"
        );
    }
    #[test]
    fn absent_mod_metadata_does_not_reuse_vanilla_role_permissions() {
        let mut state = json!({"players":[{"id":1,"isImpostor":true},{"id":2,"isImpostor":false}]});
        let read = |_, _| Err("No memory".into());
        assert!(!enrich_nos(
            &mut state,
            None,
            None,
            &Value::Null,
            None,
            &read
        ));
        assert_eq!(state["players"][0]["isImpostor"], false);
        state["players"][0]["isImpostor"] = json!(true);
        enrich_toh(&mut state, None);
        assert_eq!(state["players"][0]["isImpostor"], false);
        assert_eq!(state["players"][0]["vanillaIsImpostor"], true);
    }
    #[test]
    fn mismatched_snr_metadata_cannot_grant_neutral_killer_permissions() {
        let mut state = json!({"players":[{"id":1}]});
        let rows =
            json!([[1,{"role":{"value":3,"name":"Crewmate"},"modifier":null,"ghostRole":null}]]);
        let metadata = json!([{"playerId":1,"role":{"value":2},"isNeutral":true,"canKill":true}]);
        enrich_snr(&mut state, Some(&rows), &metadata);
        assert!(state["players"][0]["snrRole"]["canKill"].is_null());
    }
}
