//! Vanilla x64 reader using the same release offset schema and wire format.
use super::{
    http,
    memory::{self, Process},
};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

const SOURCES: [&str; 2] = [
    "https://raw.githubusercontent.com/OhMyGuus/BetterCrewlink-Offsets/main",
    "https://cdn.jsdelivr.net/gh/OhMyGuus/BetterCrewlink-Offsets@main",
];
fn ints(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}
fn number(value: &Value) -> i64 {
    value.as_i64().unwrap_or_default()
}

fn cached_json(
    client: &Client,
    data: &Path,
    cache: &str,
    suffix: &str,
    refresh: bool,
) -> Result<Value, String> {
    let path = data.join(cache);
    if !refresh {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                return Ok(value);
            }
        }
    }
    for source in SOURCES {
        if let Ok(bytes) = http::get(client, &format!("{source}/{suffix}"), 1024 * 1024) {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                let temporary = path.with_extension("rust.tmp");
                fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
                fs::rename(temporary, &path).map_err(|e| e.to_string())?;
                return Ok(value);
            }
        }
    }
    let bytes = fs::read(&path)
        .map_err(|_| "ゲームのオフセットを取得できません。ネットワーク接続を確認してください。")?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn signature(
    process: &Process,
    sections: &[(u64, Vec<u8>)],
    signature: &Value,
    location: bool,
) -> Result<i64, String> {
    let pattern =
        memory::parse_pattern(signature["sig"].as_str().ok_or("Missing game signature")?)?;
    let found = sections
        .iter()
        .find_map(|(base, bytes)| {
            memory::find_pattern(bytes, &pattern).map(|offset| *base as i64 + offset as i64)
        })
        .ok_or("ゲームのシグネチャが見つかりません。互換モードを利用してください。")?;
    let instruction = found + number(&signature["patternOffset"]);
    let extra = number(&signature["addressOffset"]);
    if location {
        return Ok(instruction + extra);
    }
    if !process.x64 {
        return Ok(process.u32(
            process
                .base
                .checked_add_signed(instruction)
                .ok_or("Invalid x86 signature")?,
        )? as i64
            - process.base as i64);
    }
    Ok(process.i32(
        process
            .base
            .checked_add_signed(instruction)
            .ok_or("Invalid signature location")?,
    )? as i64
        + instruction
        + extra)
}

#[derive(Clone)]
struct Field {
    name: String,
    offset: usize,
    width: usize,
}
pub struct Reader {
    pub process: Process,
    pub offsets: Value,
    fields: Vec<Field>,
    pub broadcast_version: i32,
    pub offsets_version: i64,
    pub colors: Vec<[String; 2]>,
    old_state: i32,
    last_light: Option<f64>,
    stable_colors: HashMap<String, i32>,
    last_players_pointer: u64,
    menu_updates: i32,
}

impl Reader {
    pub fn attach(pid: u32, data: &Path, client: &Client) -> Result<Self, String> {
        let process = Process::open(pid)?;
        let architecture = if process.x64 { "x64" } else { "x86" };
        let sections = process.executable_sections()?;
        let lookup = cached_json(client, data, "lookup.json", "lookup.json", true)?;
        let broadcast_location = signature(
            &process,
            &sections,
            &lookup["patterns"][architecture]["broadcastVersion"],
            true,
        )?;
        let broadcast_version = process.i32(
            process
                .base
                .checked_add_signed(broadcast_location)
                .ok_or("Invalid broadcast location")?,
        )?;
        let version = lookup["versions"]
            .get(broadcast_version.to_string())
            .unwrap_or(&lookup["versions"]["default"]);
        let filename = version["file"].as_str().ok_or("Unknown game version")?;
        if filename.split('/').any(|part| part == "..") || !filename.ends_with(".json") {
            return Err("Invalid offset file name".into());
        }
        let offsets_version = number(&version["offsetsVersion"]);
        let cached = fs::read(data.join("offsets.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let mut offsets = if let Some(cached) = cached.filter(|v| {
            v["filename"] == filename
                && v["is_64bit"] == process.x64
                && number(&v["offsetsVersion"]) >= offsets_version
        }) {
            cached["IOffsets"].clone()
        } else {
            let offsets = cached_json(
                client,
                data,
                &format!("rust-offset-download-{architecture}.json"),
                &format!("offsets/{architecture}/{filename}"),
                true,
            )?;
            let metadata = json!({"filename":filename,"is_64bit":process.x64,"offsetsVersion":offsets_version,"IOffsets":offsets});
            let path = data.join("offsets.rust.tmp");
            fs::write(
                &path,
                serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(path, data.join("offsets.json")).map_err(|e| e.to_string())?;
            offsets
        };
        for (name, target) in [
            ("innerNetClient", "/innerNetClient/base/0"),
            ("gameData", "/allPlayersPtr/0"),
            ("meetingHud", "/meetingHud/0"),
            ("shipStatus", "/shipStatus/0"),
            ("miniGame", "/miniGame/0"),
            ("palette", "/palette/0"),
        ] {
            let address = signature(&process, &sections, &offsets["signatures"][name], false)?;
            if address <= 0 || address as usize >= process.size {
                return Err(format!("Invalid {name} signature result"));
            }
            *offsets.pointer_mut(target).ok_or("Invalid offset schema")? = json!(address);
        }
        let options_name = if offsets["newGameOptions"] == true {
            "gameOptionsManager"
        } else {
            "playerControl"
        };
        let options_address = signature(
            &process,
            &sections,
            &offsets["signatures"][options_name],
            false,
        )?;
        *offsets
            .pointer_mut("/gameoptionsData/0")
            .ok_or("Missing game option offsets")? = json!(options_address);
        // The large executable snapshot is released before normal polling.
        drop(sections);
        let mut cursor = 0;
        let mut fields = Vec::new();
        for field in offsets["player"]["struct"]
            .as_array()
            .ok_or("Missing player layout")?
        {
            let kind = field["type"].as_str().ok_or("Invalid player field")?;
            let width = match kind {
                "SKIP" => number(&field["skip"]) as usize,
                "BYTE" | "CHAR" => 1,
                "SHORT" | "USHORT" => 2,
                "INT" | "UINT" | "FLOAT" => 4,
                _ => return Err("Unsupported player field type".into()),
            };
            if kind != "SKIP" {
                fields.push(Field {
                    name: field["name"]
                        .as_str()
                        .ok_or("Missing player field name")?
                        .into(),
                    offset: cursor,
                    width,
                });
            }
            cursor += width;
            if cursor > 4096 {
                return Err("Player layout exceeds the limit".into());
            }
        }
        Ok(Self {
            process,
            offsets,
            fields,
            broadcast_version,
            offsets_version,
            colors: Vec::new(),
            old_state: 4,
            last_light: None,
            stable_colors: HashMap::new(),
            last_players_pointer: 0,
            menu_updates: 20,
        })
    }
    fn ptr(&self, base: u64, path: &str) -> Result<u64, String> {
        self.process.ptr_at(
            base,
            &ints(self.offsets.pointer(path).ok_or("Missing pointer path")?),
        )
    }
    fn int(&self, base: u64, path: &str) -> Result<i32, String> {
        self.process.int_at(
            base,
            &ints(self.offsets.pointer(path).ok_or("Missing integer path")?),
        )
    }
    fn byte(&self, base: u64, path: &str) -> Result<u8, String> {
        self.process.byte_at(
            base,
            &ints(self.offsets.pointer(path).ok_or("Missing byte path")?),
        )
    }
    fn field(&self, base: u64, buffer: &[u8], name: &str, pointer: bool) -> u64 {
        let Some(field) = self.fields.iter().find(|field| field.name == name) else {
            return 0;
        };
        let width = if pointer {
            if self.process.x64 {
                8
            } else {
                4
            }
        } else {
            field.width
        };
        if let Some(bytes) = buffer.get(field.offset..field.offset + width) {
            let mut result = [0; 8];
            result[..width].copy_from_slice(bytes);
            u64::from_le_bytes(result)
        } else if pointer {
            self.process
                .pointer(base + field.offset as u64)
                .unwrap_or_default()
        } else {
            0
        }
    }
    pub fn load_colors(&mut self) -> Result<(), String> {
        if !self.colors.is_empty() {
            return Ok(());
        }
        let palette = self.ptr(self.process.base, "/palette")?;
        let colors = self.ptr(palette, "/palette_playercolor")?;
        let shadows = self.ptr(palette, "/palette_shadowColor")?;
        let count = self.int(shadows, "/playerCount")?;
        if !(18..=300).contains(&count) {
            return Err("ゲームのパレット読み込みを待っています".into());
        }
        let start = number(&self.offsets["playerAddrPtr"]) as u64;
        if self.process.u32(colors + start)? != 4279308742 {
            return Err("Unsupported Vanilla palette".into());
        }
        for index in 0..count as u64 {
            let rgb = |color: u32| {
                format!(
                    "#{:02x}{:02x}{:02x}",
                    color & 255,
                    (color >> 8) & 255,
                    (color >> 16) & 255
                )
            };
            self.colors.push([
                rgb(self.process.u32(colors + start + index * 4)?),
                rgb(self.process.u32(shadows + start + index * 4)?),
            ]);
        }
        Ok(())
    }
    fn outfit(&self, address: u64) -> Result<Value, String> {
        let string = |field: &str, limit| -> Result<String, String> {
            Ok(self.process.string(
                self.ptr(address, &format!("/player/outfit/{field}"))?,
                limit,
            ))
        };
        Ok(
            json!({"name":strip_tags(&string("playerName",1000)?),"color":self.int(address,"/player/outfit/colorId")?,"hat":string("hatId",500)?,"skin":string("skinId",500)?,"visor":string("visorId",500)?}),
        )
    }
    fn player(&self, address: u64, local_client: i32, meeting: bool) -> Result<Value, String> {
        let length = number(&self.offsets["player"]["bufferLength"]);
        if !(1..=4096).contains(&length) {
            return Err("Invalid player buffer length".into());
        }
        let buffer = self.process.bytes(address, length as usize + 8)?;
        let field = |name, pointer| self.field(address, &buffer, name, pointer);
        let object = field("objectPtr", true);
        if object == 0 {
            return Err("Player object is not available".into());
        }
        let client = if self.fields.iter().any(|f| f.name == "clientId") {
            field("clientId", false) as u32 as i32
        } else {
            self.int(object, "/player/clientId")?
        };
        let disconnected = field("disconnected", false) != 0;
        let local = local_client == client && !disconnected;
        let (x_path, y_path) = if local {
            ("localX", "localY")
        } else {
            ("remoteX", "remoteY")
        };
        let x = self
            .process
            .float_at(object, &ints(&self.offsets["player"][x_path]));
        let y = self
            .process
            .float_at(object, &ints(&self.offsets["player"][y_path]));
        let current_outfit = self.int(object, "/player/currentOutfit")?;
        let outfits = field("outfitsPtr", true);
        let dictionary = self.process.dictionary(outfits, 12)?;
        let base_outfit = dictionary
            .iter()
            .find(|(key, _)| *key == 0)
            .ok_or("Base player outfit is not available")?;
        let base = self.outfit(base_outfit.1)?;
        let display = if !meeting && (1..=10).contains(&current_outfit) {
            dictionary
                .iter()
                .find(|(key, _)| *key == current_outfit)
                .map(|(_, v)| self.outfit(*v))
                .transpose()?
                .unwrap_or_else(|| base.clone())
        } else {
            base.clone()
        };
        let role = field("rolePtr", true);
        let team = self.int(role, "/player/roleTeam").unwrap_or_default();
        let uid = self.process.string(field("puid", true), 50);
        let name = base["name"].as_str().unwrap_or("");
        let name_hash = hash_code(name);
        let color = base["color"].as_i64().unwrap_or(-1) as i32;
        let bugged = disconnected
            || x.is_err()
            || y.is_err()
            || color < 0
            || color as usize > self.colors.len();
        let appearance_id = format!(
            "{}|{}|{}|{}",
            display["color"],
            display["hat"].as_str().unwrap_or(""),
            display["skin"].as_str().unwrap_or(""),
            display["visor"].as_str().unwrap_or("")
        );
        Ok(json!({
            "ptr":address,"id":field("id",false),"clientId":client,"name":name,"nameHash":name_hash,"playerConfigId":if uid.is_empty(){name_hash}else{hash_code(&uid)},
            "friendCode":self.process.string(field("friendCode",true),50),"playerIdentifier":if uid.is_empty(){client.to_string()}else{uid.clone()},"playerUid":uid,
            "colorId":color,"hatId":base["hat"],"skinId":base["skin"],"visorId":base["visor"],
            "currentOutfit":if meeting {0}else{current_outfit},"appearanceName":if display["name"].as_str().unwrap_or("").is_empty(){&base["name"]}else{&display["name"]},
            "appearanceColorId":display["color"],"appearanceHatId":display["hat"],"appearanceSkinId":display["skin"],"appearanceVisorId":display["visor"],"appearanceId":appearance_id,
            "disconnected":disconnected,"rolePtr":role,"roleTeam":team,"roleName":if team==1{"Impostor".into()}else if team==0{"Crewmate".into()}else{format!("ThirdParty({team})")},
            "isImpostor":team==1,"isThirdParty":team!=0&&team!=1,"isDead":field("dead",false)==1,"taskPtr":field("taskPtr",true),"objectPtr":object,"isLocal":local,
            "shiftedColor":if !meeting&&(1..=10).contains(&current_outfit) {display["color"].as_i64().unwrap_or(-1)}else{-1},
            "bugged":bugged,"x":if bugged{9999.0}else{x.unwrap_or(9999.0)},"y":if bugged{9999.0}else{y.unwrap_or(9999.0)},
            "inVent":!meeting&&self.byte(object,"/player/inVent")?>0,"isDummy":self.byte(object,"/player/isDummy")?>0
        }))
    }
    pub fn read(&mut self) -> Result<Value, String> {
        self.load_colors()?;
        let process = &self.process;
        let inner = self.ptr(process.base, "/innerNetClient/base")?;
        if inner == 0 {
            return Ok(menu_state(self.old_state));
        }
        let net = &self.offsets["innerNetClient"];
        let raw = process.i32(inner + number(&net["gameState"]) as u64)?;
        let meeting = self.ptr(process.base, "/meetingHud")?;
        let meeting_cached = self.ptr(meeting, "/objectCachePtr")?;
        let meeting_state = if meeting_cached == 0 {
            4
        } else {
            self.int(meeting, "/meetingHudState")?
        };
        let mut state = match raw {
            0 => 3,
            1 | 3 => 0,
            _ if meeting_state < 4 => 2,
            _ => 1,
        };
        let code_int = if state == 3 {
            -1
        } else {
            process.i32(inner + number(&net["gameId"]) as u64)?
        };
        let client = process.i32(inner + number(&net["clientId"]) as u64)?;
        let host = process.i32(inner + number(&net["hostId"]) as u64)?;
        let list = self.ptr(process.base, "/allPlayersPtr")?;
        let array = self.ptr(list, "/allPlayers")?;
        let count = self.int(list, "/playerCount")?.clamp(0, 40);
        let mut players = Vec::new();
        let mut code = game_code(code_int);
        if state != 3 && array != 0 {
            let start = array + number(&self.offsets["playerAddrPtr"]) as u64;
            for index in 0..count {
                let address = process.address(
                    start + index as u64 * if process.x64 { 8 } else { 4 },
                    &ints(&self.offsets["player"]["offsets"]),
                );
                if let Ok(address) = address {
                    if address != 0 {
                        if let Ok(player) = self.player(address, client, state == 2) {
                            if code_int == 32 && player["clientId"] == host {
                                code = (player["nameHash"].as_i64().unwrap_or_default() % 99999)
                                    .to_string();
                            }
                            players.push(player);
                        }
                    }
                }
            }
        }
        if count > 0 && players.is_empty() {
            return Err("ゲームのプレイヤー構造を読み取れません".into());
        }
        normalize_colors(&mut players, &mut self.stable_colors, self.colors.len());
        let local = players.iter().find(|p| p["isLocal"] == true);
        if self.old_state == 3
            && state == 0
            && self.menu_updates > 0
            && (self.last_players_pointer == array || local.is_none())
        {
            state = 3;
            self.menu_updates -= 1;
        } else {
            self.menu_updates = 20;
            self.last_players_pointer = array;
        }
        let options = self.ptr(process.base, "/gameoptionsData")?;
        let ship = self.ptr(process.base, "/shipStatus")?;
        let normalize_map = |map| {
            if (0..=6).contains(&map) || map == 105 {
                map
            } else {
                6
            }
        };
        let mut map = normalize_map(
            self.byte(options, "/gameOptions_MapId")
                .map(i32::from)
                .unwrap_or(6),
        );
        if map == 6 && ship != 0 {
            map = normalize_map(
                self.byte(ship, "/shipStatus_map")
                    .map(i32::from)
                    .unwrap_or(6),
            );
        }
        let mut doors = Vec::new();
        let mut comms = false;
        let mut camera = 7;
        if state == 1 {
            let systems = self.ptr(ship, "/shipStatus_systems")?;
            for (key, value) in process.dictionary(systems, 64)? {
                if key == 14 {
                    comms = if map == 1 || map == 5 {
                        self.int(value, "/hqHudSystemType_CompletedConsoles")? < 2
                    } else {
                        self.int(value, "/HudOverrideSystemType_isActive")? == 1
                    };
                }
                if key == 18 && map == 1 {
                    if self.int(value, "/deconDoorLowerOpen")? == 0 {
                        doors.push(0)
                    }
                    if self.int(value, "/deconDoorUpperOpen")? == 0 {
                        doors.push(1)
                    }
                }
            }
            if map != 1 {
                let array = self.ptr(ship, "/shipstatus_allDoors")?;
                let count = self.int(array, "/playerCount")?.clamp(0, 16);
                for index in 0..count {
                    let door = process.pointer(
                        array
                            + number(&self.offsets["playerAddrPtr"]) as u64
                            + index as u64 * if process.x64 { 8 } else { 4 },
                    )?;
                    if process.i32(door + number(&self.offsets["door_isOpen"]) as u64)? != 1 {
                        doors.push(index);
                    }
                }
            }
            let mini = self.ptr(process.base, "/miniGame")?;
            if self.ptr(mini, "/objectCachePtr")? != 0 {
                if map == 2 || map == 4 {
                    let id = self.int(mini, "/planetSurveillanceMinigame_currentCamera")?;
                    if (0..=5).contains(&id)
                        && self.int(mini, "/planetSurveillanceMinigame_camarasCount")? == 6
                    {
                        camera = id;
                    }
                } else if map == 0
                    && self.int(mini, "/surveillanceMinigame_FilteredRoomsCount")? == 4
                {
                    if let Some(local) = local {
                        let x = local["x"].as_f64().unwrap_or(9999.0);
                        let y = local["y"].as_f64().unwrap_or(9999.0);
                        if ((x + 12.9364).powi(2) + (y + 2.7928).powi(2)).sqrt() < 0.6 {
                            camera = 6;
                        }
                    }
                }
            }
        }
        let mixup = state == 1 && players.iter().any(disguised);
        let airship = state == 1
            && map == 4
            && players.len() >= 2
            && players
                .iter()
                .filter(|p| p["disconnected"] != true && p["bugged"] != true)
                .all(|p| p["currentOutfit"] == 1)
            && !mixup;
        let light = local
            .and_then(|p| p["objectPtr"].as_u64())
            .and_then(|p| {
                process
                    .float_at(p, &ints(&self.offsets["lightRadius"]))
                    .ok()
            })
            .unwrap_or(1.0);
        let result = json!({"gameState":state,"oldGameState":self.old_state,"lobbyCodeInt":code_int,"lobbyCode":if state==3||code.is_empty(){"MENU".into()}else{code},
            "players":players,"isHost":client!=0&&host!=0&&client==host,"clientId":client,"hostId":host,"comsSabotaged":comms,"mixupSabotaged":mixup,"camouflaged":false,
            "currentCamera":camera,"map":map,"lightRadius":light,"lightRadiusChanged":self.last_light!=Some(light),"closedDoors":doors,"maxPlayers":self.byte(options,"/gameOptions_MaxPLayers").unwrap_or(10),
            "mod":"NONE","oldMeetingHud":self.offsets["oldMeetingHud"]==true,"airshipMeetingByOutfit":airship});
        self.old_state = state;
        self.last_light = Some(light);
        if state == 3 {
            self.stable_colors.clear();
        }
        Ok(result)
    }
}

pub fn hash_code(text: &str) -> i32 {
    text.encode_utf16()
        .fold(0i32, |hash, c| hash.wrapping_mul(31).wrapping_add(c as i32))
}
fn strip_tags(text: &str) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        result.push_str(&rest[..start]);
        let tail = &rest[start..];
        if let Some(end) = tail.find('>').filter(|end| !tail[..*end].contains('\n')) {
            rest = &tail[end + 1..];
        } else {
            result.push_str(tail);
            return result;
        }
    }
    result.push_str(rest);
    result
}
pub fn game_code(code: i32) -> String {
    if code == 0 || (-999..0).contains(&code) {
        return String::new();
    }
    if code > 0 {
        return String::from_utf8_lossy(&code.to_le_bytes()).to_string();
    }
    let letters = b"QWXRTYLPESDFGHUJKZOCVBINMA";
    let a = (code & 0x3ff) as usize;
    let b = ((code >> 10) & 0xfffff) as usize;
    [
        a % 26,
        a / 26,
        b % 26,
        (b / 26) % 26,
        (b / 676) % 26,
        (b / 17576) % 26,
    ]
    .into_iter()
    .filter_map(|index| letters.get(index).copied().map(char::from))
    .collect()
}
pub fn menu_state(old: i32) -> Value {
    json!({"gameState":3,"oldGameState":old,"lobbyCode":"MENU","lobbyCodeInt":-1,"players":[],"isHost":false,"clientId":-1,"hostId":-1,"comsSabotaged":false,"mixupSabotaged":false,"camouflaged":false,"currentCamera":7,"map":6,"lightRadius":1,"lightRadiusChanged":true,"closedDoors":[],"maxPlayers":10,"mod":"NONE","nosAddonIds":[],"oldMeetingHud":false,"airshipMeetingByOutfit":false})
}
fn disguised(p: &Value) -> bool {
    let outfit = number(&p["currentOutfit"]);
    if !(1..=10).contains(&outfit) || p["disconnected"] == true || p["bugged"] == true {
        return false;
    }
    let norm = |s: &Value| {
        let s = s.as_str().unwrap_or("");
        if ["hat_NoHat", "skin_None", "visor_EmptyVisor"].contains(&s) {
            "".to_string()
        } else {
            s.to_string()
        }
    };
    p["colorId"] != p["appearanceColorId"]
        || norm(&p["hatId"]) != norm(&p["appearanceHatId"])
        || norm(&p["skinId"]) != norm(&p["appearanceSkinId"])
        || norm(&p["visorId"]) != norm(&p["appearanceVisorId"])
}
fn normalize_colors(players: &mut [Value], stable: &mut HashMap<String, i32>, length: usize) {
    let mut counts = HashMap::new();
    for p in players
        .iter()
        .filter(|p| p["disconnected"] != true && p["bugged"] != true)
    {
        let c = number(&p["colorId"]);
        if c >= 0 && (c as usize) < length {
            *counts.entry(c).or_insert(0) += 1;
        }
    }
    for p in players
        .iter_mut()
        .filter(|p| p["disconnected"] != true && p["bugged"] != true)
    {
        let color = number(&p["colorId"]) as i32;
        if color < 0 || color as usize >= length {
            continue;
        }
        let key = if let Some(uid) = p["playerIdentifier"].as_str().filter(|s| !s.is_empty()) {
            uid.to_string()
        } else {
            format!("{}:{}", p["id"], p["nameHash"])
        };
        if counts.get(&(color as i64)).copied().unwrap_or(0) <= 1 {
            stable.insert(key, color);
        } else if let Some(previous) = stable.get(&key) {
            if p["shiftedColor"] == -1 {
                p["shiftedColor"] = json!(color);
            }
            p["colorId"] = json!(previous);
        }
    }
}
pub fn data_directory() -> PathBuf {
    std::env::var_os("TANUKI_TAURI_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
                .join("work.kuretoshi.tanukibcl.tauri.beta")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn javascript_hashes_use_utf16_and_wrapping_i32() {
        assert_eq!(hash_code("Crewmate"), 1905167366);
        assert_eq!(hash_code("😀"), 1772899);
        assert_eq!(strip_tags("<color=red>太郎</color>"), "太郎");
    }
    #[test]
    fn game_codes_preserve_old_ascii_and_menu_semantics() {
        assert_eq!(game_code(i32::from_le_bytes(*b"ABCD")), "ABCD");
        assert_eq!(game_code(0), "");
        assert_eq!(game_code(-1), "");
        assert_eq!(game_code(i32::MIN), "QQQQQQ");
    }
    #[test]
    fn meeting_snapshot_has_no_audio_routing_hazards() {
        let state = menu_state(2);
        assert_eq!(state["currentCamera"], 7);
        assert_eq!(state["comsSabotaged"], false);
        assert!(state["players"].as_array().unwrap().is_empty());
    }
}
