//! TOH4E PlayerState and IKiller metadata. Unknown or moving role objects never
//! fall back to Vanilla's substitute role classification.
use super::memory::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Clone)]
pub struct Layout {
    value: Value,
    ps: usize,
}
fn dictionary_layout(value: &Value, ps: usize) -> Result<(), String> {
    for key in ["dictionarySlot", "dictionaryType", "entriesType"] {
        pointer_field(&value[key], ps)?;
    }
    for key in ["entriesOffset", "countOffset", "versionOffset"] {
        if uint(&value[key], 1024)? < 4 {
            return Err("Invalid TOH4E dictionary offset".into());
        }
    }
    let stride = uint(&value["stride"], 64)? as usize;
    if stride < 12 || value["dataOffset"].as_u64() != Some((ps * 2) as u64) {
        return Err("Invalid TOH4E dictionary stride".into());
    }
    offset(&value["nextOffset"], 4, stride)?;
    offset(&value["keyOffset"], 4, stride)?;
    offset(&value["valueOffset"], ps, stride)?;
    Ok(())
}
fn catalog(value: &Value, names: &Value) -> Result<(), String> {
    let rows = value
        .as_array()
        .filter(|r| r.len() <= 1024)
        .ok_or("Invalid TOH4E catalog")?;
    let mut ids = HashSet::new();
    let mut seen = HashSet::new();
    for row in rows {
        let id = row["roleId"].as_i64().ok_or("Invalid TOH4E role ID")?;
        let name = row["roleName"].as_str().ok_or("Invalid TOH4E role name")?;
        let bytes = name.as_bytes();
        let valid = bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.len() <= 128
            && bytes
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'_');
        if !valid
            || !ids.insert(id)
            || !seen.insert(name)
            || names[id.to_string()] != name
            || !row["displayName"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 256)
            || !row["customRoleType"].as_str().is_some_and(|s| {
                ["Impostor", "Madmate", "Crewmate", "Neutral", "Animals"].contains(&s)
            })
            || (!row["isKiller"].is_null() && !row["isKiller"].is_boolean())
        {
            return Err("Invalid TOH4E catalog role".into());
        }
    }
    Ok(())
}
impl Layout {
    pub fn parse(value: &Value, pid: u32) -> Result<Self, String> {
        let ps = pointer_size(value, pid)?;
        dictionary_layout(value, ps)?;
        pointer_field(&value["playerType"], ps)?;
        for key in ["idOffset", "roleOffset"] {
            if uint(&value[key], 1024)? < 4 {
                return Err("Invalid TOH4E player field".into());
            }
        }
        let optional = uint(
            &value["opportunistCanKillSlot"],
            if ps == 4 {
                0xffff_ffff
            } else {
                9_007_199_254_740_991
            },
        )?;
        if optional != 0 && optional < 0x10000 {
            return Err("Invalid TOH4E option slot".into());
        }
        let names = &value["names"];
        if !names
            .as_object()
            .is_some_and(|m| m.values().all(Value::is_string))
        {
            return Err("Invalid TOH4E names".into());
        }
        catalog(&value["roleCatalog"], names)?;
        let killer = &value["killerLayout"];
        if !killer.is_null() {
            dictionary_layout(killer, ps)?;
            for (key, row) in killer["types"]
                .as_object()
                .ok_or("Invalid TOH4E killer types")?
            {
                let address = key
                    .parse::<u64>()
                    .map_err(|_| "Invalid TOH4E killer type")?;
                if !pointer_valid(address, ps)
                    || !row["isKiller"].is_boolean()
                    || uint(&row["stateOffset"], 1024)? < 4
                {
                    return Err("Invalid TOH4E killer type".into());
                }
            }
        }
        Ok(Self {
            value: value.clone(),
            ps,
        })
    }
    fn dictionary(&self, layout: &Value, read: &Read<'_>) -> Result<Dictionary, String> {
        let n = |key: &str| layout[key].as_u64().unwrap();
        let pointer = ptr(read, n("dictionarySlot"), self.ps)?;
        if !pointer_valid(pointer, self.ps) || ptr(read, pointer, self.ps)? != n("dictionaryType") {
            return Err("TOH4E dictionary unavailable".into());
        }
        let entries = ptr(read, pointer + n("entriesOffset"), self.ps)?;
        let count = u32_read(read, pointer + n("countOffset"))? as usize;
        let version = u32_read(read, pointer + n("versionOffset"))?;
        if !pointer_valid(entries, self.ps)
            || ptr(read, entries, self.ps)? != n("entriesType")
            || count > 256
            || count > u32_read(read, entries + self.ps as u64)? as usize
        {
            return Err("Invalid TOH4E entries".into());
        }
        let bytes = read(entries + n("dataOffset"), count * n("stride") as usize)?;
        Ok(Dictionary {
            pointer,
            entries,
            count,
            version,
            bytes,
        })
    }
    fn verify(&self, layout: &Value, d: &Dictionary, read: &Read<'_>) -> Result<(), String> {
        let n = |key: &str| layout[key].as_u64().unwrap();
        if ptr(read, n("dictionarySlot"), self.ps)? != d.pointer
            || ptr(read, d.pointer, self.ps)? != n("dictionaryType")
            || u32_read(read, d.pointer + n("versionOffset"))? != d.version
            || ptr(read, d.pointer + n("entriesOffset"), self.ps)? != d.entries
            || u32_read(read, d.pointer + n("countOffset"))? as usize != d.count
            || ptr(read, d.entries, self.ps)? != n("entriesType")
        {
            return Err("TOH4E dictionary changed".into());
        }
        verify(read, d.entries + n("dataOffset"), &d.bytes)
    }
    fn once(&self, read: &Read<'_>) -> Result<Vec<(u8, Value)>, String> {
        let v = &self.value;
        let k = &v["killerLayout"];
        let n = |key: &str| v[key].as_u64().unwrap();
        let mut killers = HashMap::new();
        let mut active = None;
        if !k.is_null() {
            let d = self.dictionary(k, read)?;
            for row in d.bytes.chunks_exact(k["stride"].as_u64().unwrap() as usize) {
                if i32_at(row, k["nextOffset"].as_u64().unwrap() as usize)? < -1 {
                    continue;
                }
                let id = row[k["keyOffset"].as_u64().unwrap() as usize];
                let role = ptr_at(row, k["valueOffset"].as_u64().unwrap() as usize, self.ps)?;
                if !pointer_valid(role, self.ps) || killers.contains_key(&id) {
                    return Err("Invalid TOH4E active role".into());
                }
                let type_id = ptr(read, role, self.ps)?;
                let info = &k["types"][type_id.to_string()];
                let state = if info.is_null() {
                    0
                } else {
                    ptr(read, role + info["stateOffset"].as_u64().unwrap(), self.ps)?
                };
                killers.insert(id, (state, info["isKiller"].clone()));
            }
            active = Some(d);
        }
        let d = self.dictionary(v, read)?;
        let can_kill = if n("opportunistCanKillSlot") == 0 {
            None
        } else {
            Some(boolean(&read(n("opportunistCanKillSlot"), 1)?, 0)?)
        };
        let mut ids = HashSet::new();
        let mut roles = Vec::new();
        for row in d.bytes.chunks_exact(n("stride") as usize) {
            if i32_at(row, n("nextOffset") as usize)? < -1 {
                continue;
            }
            let id = row[n("keyOffset") as usize];
            let player = ptr_at(row, n("valueOffset") as usize, self.ps)?;
            if !pointer_valid(player, self.ps)
                || ptr(read, player, self.ps)? != n("playerType")
                || read(player + n("idOffset"), 1)?[0] != id
                || !ids.insert(id)
            {
                return Err("TOH4E player identity changed".into());
            }
            let role_id = i32_at(&read(player + n("roleOffset"), 4)?, 0)?;
            let name = &v["names"][role_id.to_string()];
            let custom = v["roleCatalog"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["roleId"].as_i64() == Some(role_id as i64))
                .map(|r| r["customRoleType"].clone())
                .unwrap_or(Value::Null);
            let neutral = match name.as_str() {
                None | Some("") | Some("NotAssigned") => Value::Null,
                Some("Opportunist") => can_kill.map(|v| json!(v)).unwrap_or(Value::Null),
                Some(name) => {
                    json!(["Egoist", "Jackal", "Gizoku", "Oniichan", "DarkHide"].contains(&name))
                }
            };
            let killer = if name
                .as_str()
                .is_some_and(|s| !s.is_empty() && s != "NotAssigned")
            {
                killers
                    .get(&id)
                    .filter(|(state, _)| *state == player)
                    .map(|(_, k)| k.clone())
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let mut role = json!({"roleId":role_id,"roleName":name,"customRoleType":custom,"isNeutralKiller":neutral,"isKiller":killer});
            if name == "Opportunist" {
                if let Some(can_kill) = can_kill {
                    role["opportunistCanKill"] = json!(can_kill);
                }
            }
            roles.push((id, role));
        }
        self.verify(v, &d, read)?;
        if let Some(d) = active {
            self.verify(k, &d, read)?;
        }
        Ok(roles)
    }
    pub fn read(&self, read: &Read<'_>) -> Result<Value, String> {
        let first = self.once(read)?;
        let second = self.once(read)?;
        if first != second {
            return Err("TOH4E roles changed during read".into());
        }
        Ok(json!(second))
    }
    pub fn catalog(&self) -> Value {
        self.value["roleCatalog"].clone()
    }
}
struct Dictionary {
    pointer: u64,
    entries: u64,
    count: usize,
    version: u32,
    bytes: Vec<u8>,
}
