//! SNR roles, Jumbo/Busker abilities and meeting pages from validated live
//! layouts. A torn managed snapshot grants no role/radio/hearing permission.
use super::memory::*;
use serde_json::{json, Value};

#[derive(Clone)]
struct Field {
    offset: usize,
    size: usize,
    signed: bool,
    names: Value,
}
impl Field {
    fn parse(value: &Value, required: bool) -> Result<Option<Self>, String> {
        if value.is_null() {
            return if required {
                Err("Missing SNR field".into())
            } else {
                Ok(None)
            };
        }
        let size = uint(&value["size"], 4)? as usize;
        if ![1, 2, 4].contains(&size) {
            return Err("Invalid SNR integer width".into());
        }
        let n = uint(&value["offset"], 1024)? as usize;
        if n < 4 {
            return Err("Invalid SNR field offset".into());
        }
        let signed = value["signed"].as_bool().ok_or("Invalid SNR signedness")?;
        let names = &value["names"];
        if !names.is_null()
            && !names
                .as_object()
                .is_some_and(|m| m.values().all(Value::is_string))
        {
            return Err("Invalid SNR enum names".into());
        }
        Ok(Some(Self {
            offset: n,
            size,
            signed,
            names: names.clone(),
        }))
    }
    fn describe(&self, bytes: &[u8], flags: bool) -> Result<Value, String> {
        let raw = slice(bytes, self.offset, self.size)?;
        let n = match (self.size, self.signed) {
            (1, true) => raw[0] as i8 as i64,
            (1, false) => raw[0] as i64,
            (2, true) => i16::from_le_bytes(raw.try_into().unwrap()) as i64,
            (2, false) => u16::from_le_bytes(raw.try_into().unwrap()) as i64,
            (4, true) => i32::from_le_bytes(raw.try_into().unwrap()) as i64,
            (4, false) => u32::from_le_bytes(raw.try_into().unwrap()) as i64,
            _ => unreachable!(),
        };
        let mut name = self.names[n.to_string()].clone();
        if flags && name.is_null() && n > 0 {
            let mut remaining = n as u64;
            let mut bits: Vec<_> = self
                .names
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| {
                    key.parse::<u64>()
                        .ok()
                        .filter(|n| n.is_power_of_two())
                        .map(|bit| (bit, value.as_str().unwrap()))
                })
                .collect();
            bits.sort_by_key(|p| p.0);
            let mut labels = Vec::new();
            for (bit, label) in bits {
                if remaining & bit == bit {
                    labels.push(label);
                    remaining &= !bit;
                }
            }
            if remaining == 0 && !labels.is_empty() {
                name = json!(labels.join(" | "));
            }
        }
        Ok(json!({"value":n,"name":name}))
    }
}
#[derive(Clone)]
pub struct Layout {
    value: Value,
    ps: usize,
    slot: u64,
    array_type: u64,
    player_type: u64,
    data: u64,
    fields: [Option<Field>; 4],
    size: usize,
}
impl Layout {
    pub fn parse(value: &Value, pid: u32) -> Result<Self, String> {
        let ps = pointer_size(value, pid)?;
        let slot = pointer_field(&value["arraySlot"], ps)?;
        let array_type = pointer_field(&value["arrayType"], ps)?;
        let player_type = pointer_field(&value["playerType"], ps)?;
        let data = uint(&value["arrayDataOffset"], 32)?;
        if value["arrayLengthOffset"].as_u64() != Some(ps as u64)
            || data < (ps + 4) as u64
            || data % ps as u64 != 0
        {
            return Err("Invalid SNR array layout".into());
        }
        let f = &value["fields"];
        let fields = [
            Field::parse(&f["playerId"], true)?,
            Field::parse(&f["role"], true)?,
            Field::parse(&f["modifier"], false)?,
            Field::parse(&f["ghostRole"], false)?,
        ];
        let size = fields
            .iter()
            .flatten()
            .map(|f| f.offset + f.size)
            .max()
            .unwrap()
            .max(ps);
        for key in ["jumbo", "busker"] {
            let ability = &value[key];
            if ability.is_null() {
                continue;
            }
            for field in if key == "jumbo" {
                &["abilityType", "dataType", "listType", "itemsType"][..]
            } else {
                &["abilityType", "listType", "itemsType"][..]
            } {
                pointer_field(&ability[*field], ps)?;
            }
            for field in if key == "jumbo" {
                &[
                    "abilitiesOffset",
                    "itemsOffset",
                    "countOffset",
                    "currentOffset",
                    "dataOffset",
                    "maxOffset",
                ][..]
            } else {
                &[
                    "abilitiesOffset",
                    "itemsOffset",
                    "countOffset",
                    "activeOffset",
                ][..]
            } {
                let n = uint(&ability[*field], 4096)?;
                if n < 4 || (key == "jumbo" && n % 4 != 0) {
                    return Err("Invalid SNR ability layout".into());
                }
            }
        }
        Ok(Self {
            value: value.clone(),
            ps,
            slot,
            array_type,
            player_type,
            data,
            fields,
            size,
        })
    }
    fn ability(&self, player: u64, key: &str, read: &Read<'_>) -> Result<Option<Value>, String> {
        let a = &self.value[key];
        if a.is_null() {
            return Ok(None);
        }
        let num = |key: &str| a[key].as_u64().unwrap();
        let list = ptr(read, player + num("abilitiesOffset"), self.ps)?;
        if !pointer_valid(list, self.ps) || ptr(read, list, self.ps)? != num("listType") {
            return Ok(None);
        }
        let items = ptr(read, list + num("itemsOffset"), self.ps)?;
        let count = u32_read(read, list + num("countOffset"))? as usize;
        if !pointer_valid(items, self.ps)
            || ptr(read, items, self.ps)? != num("itemsType")
            || count > 512
            || count > u32_read(read, items + self.ps as u64)? as usize
        {
            return Ok(None);
        }
        let entries = read(items + self.data, count * self.ps)?;
        for i in 0..count {
            let ability = ptr_at(&entries, i * self.ps, self.ps)?;
            if !pointer_valid(ability, self.ps)
                || ptr(read, ability, self.ps)? != num("abilityType")
            {
                continue;
            }
            let mut data = 0;
            let mut active = None;
            let result = if key == "jumbo" {
                data = ptr(read, ability + num("dataOffset"), self.ps)?;
                if !pointer_valid(data, self.ps) || ptr(read, data, self.ps)? != num("dataType") {
                    return Ok(None);
                }
                let current = f32_at(&read(ability + num("currentOffset"), 4)?, 0)?;
                let maximum = f32_at(&read(data + num("maxOffset"), 4)?, 0)?;
                if current < 0.0 || maximum <= 0.0 {
                    return Ok(None);
                }
                json!({"currentSize":current,"maxSize":maximum})
            } else {
                let value = read(ability + num("activeOffset"), 1)?[0];
                if value > 1 {
                    return Ok(None);
                }
                active = Some(value);
                json!(value == 1)
            };
            if ptr(read, player, self.ps)? != self.player_type
                || ptr(read, player + num("abilitiesOffset"), self.ps)? != list
                || ptr(read, list, self.ps)? != num("listType")
                || ptr(read, list + num("itemsOffset"), self.ps)? != items
                || u32_read(read, list + num("countOffset"))? as usize != count
                || ptr(read, items, self.ps)? != num("itemsType")
                || ptr(read, ability, self.ps)? != num("abilityType")
            {
                return Ok(None);
            }
            verify(read, items + self.data, &entries)?;
            if key == "jumbo"
                && (ptr(read, ability + num("dataOffset"), self.ps)? != data
                    || ptr(read, data, self.ps)? != num("dataType"))
            {
                return Ok(None);
            }
            if let Some(active) = active {
                if read(ability + num("activeOffset"), 1)?[0] != active {
                    return Ok(None);
                }
            }
            return Ok(Some(result));
        }
        Ok(None)
    }
    fn once(&self, read: &Read<'_>) -> Result<Vec<(u8, Value)>, String> {
        let array = ptr(read, self.slot, self.ps)?;
        if !pointer_valid(array, self.ps)
            || ptr(read, array, self.ps)? != self.array_type
            || u32_read(read, array + self.ps as u64)? != 256
        {
            return Err("SNR player array changed or is unavailable".into());
        }
        let entries = read(array + self.data, 256 * self.ps)?;
        let mut roles = Vec::new();
        for id in 0..256 {
            let player = ptr_at(&entries, id * self.ps, self.ps)?;
            if player == 0 {
                continue;
            }
            if !pointer_valid(player, self.ps) {
                return Err("Invalid SNR player pointer".into());
            }
            let bytes = read(player, self.size)?;
            if ptr_at(&bytes, 0, self.ps)? != self.player_type
                || self.fields[0].as_ref().unwrap().describe(&bytes, false)?["value"].as_u64()
                    != Some(id as u64)
            {
                return Err("SNR player changed during read".into());
            }
            let mut role = json!({});
            for (i, key) in ["role", "modifier", "ghostRole"].iter().enumerate() {
                role[*key] = self.fields[i + 1]
                    .as_ref()
                    .map(|f| f.describe(&bytes, *key == "modifier"))
                    .transpose()?
                    .unwrap_or(Value::Null);
            }
            if role["modifier"]["name"]
                .as_str()
                .is_some_and(|s| s.split(" | ").any(|s| s == "JumboModifier"))
            {
                if let Ok(Some(size)) = self.ability(player, "jumbo", read) {
                    role["jumbo"] = size;
                }
            }
            if role["role"]["name"] == "Busker" {
                if let Ok(Some(active)) = self.ability(player, "busker", read) {
                    role["buskerPseudocideActive"] = active;
                }
            }
            roles.push((id as u8, role));
        }
        if ptr(read, self.slot, self.ps)? != array {
            return Err("SNR player array changed during read".into());
        }
        verify(read, array + self.data, &entries)?;
        Ok(roles)
    }
    pub fn read(&self, read: &Read<'_>) -> Result<Value, String> {
        let first = self.once(read)?;
        let second = self.once(read)?;
        let identity = |rows: &[(u8, Value)]| {
            rows.iter()
                .map(|(id, r)| json!([id, r["role"], r["modifier"], r["ghostRole"]]))
                .collect::<Vec<_>>()
        };
        if identity(&first) != identity(&second) {
            return Err("SNR roles changed during read".into());
        }
        Ok(json!(second))
    }
    pub fn meeting(&self, read: &Read<'_>) -> Option<Value> {
        meeting(&self.value, self.ps, self.data, read).ok()
    }
}
fn meeting(value: &Value, ps: usize, data: u64, read: &Read<'_>) -> Result<Value, String> {
    let m = &value["meeting"];
    if m.is_null() {
        return Err("No SNR meeting layout".into());
    }
    let n = |key: &str| {
        m[key]
            .as_u64()
            .ok_or("Invalid SNR meeting layout".to_string())
    };
    for key in ["enabledSlot", "pageSlot"] {
        if uint(&m[key], 9_007_199_254_740_991)? < 0x10000 {
            return Err("Invalid SNR meeting slot".into());
        }
    }
    for key in [
        "areasSlot",
        "listType",
        "itemsType",
        "voteAreaType",
        "nativeClass",
    ] {
        pointer_field(&m[key], ps)?;
    }
    for key in [
        "itemsOffset",
        "countOffset",
        "versionOffset",
        "pooledPtrOffset",
        "playerIdOffset",
    ] {
        if uint(&m[key], 4096)? < 4 {
            return Err("Invalid SNR meeting offset".into());
        }
    }
    let pointer = |address| -> Result<u64, String> {
        let p = ptr(read, address, ps)?;
        if !pointer_valid(p, ps) {
            return Err("Invalid SNR meeting pointer".into());
        }
        Ok(p)
    };
    let once = || -> Result<Value, String> {
        let enabled = read(n("enabledSlot")?, 1)?[0];
        if enabled == 0 {
            return Ok(json!({"enabled":false,"currentPage":1,"playerIds":[]}));
        }
        if enabled != 1 {
            return Err("Invalid SNR paging flag".into());
        }
        let page = u32_read(read, n("pageSlot")?)?;
        let list = pointer(n("areasSlot")?)?;
        if pointer(list)? != n("listType")? {
            return Err("SNR meeting list type changed".into());
        }
        let count = u32_read(read, list + n("countOffset")?)?;
        let version = u32_read(read, list + n("versionOffset")?)?;
        let items = pointer(list + n("itemsOffset")?)?;
        let capacity = u32_read(read, items + ps as u64)?;
        if pointer(items)? != n("itemsType")?
            || !(1..=256).contains(&count)
            || capacity < count
            || capacity > 512
            || page < 1
            || page > count.div_ceil(15)
        {
            return Err("Invalid SNR meeting page".into());
        }
        let references = read(items + data, count as usize * ps)?;
        let mut ids = Vec::new();
        for i in 0..count as usize {
            let area = ptr_at(&references, i * ps, ps)?;
            if !pointer_valid(area, ps) {
                return Err("Invalid SNR vote area".into());
            }
            let wrapper = read(area, n("pooledPtrOffset")? as usize + ps)?;
            if ptr_at(&wrapper, 0, ps)? != n("voteAreaType")? {
                return Err("SNR vote area type changed".into());
            }
            let native = ptr_at(&wrapper, n("pooledPtrOffset")? as usize, ps)?;
            if !pointer_valid(native, ps) {
                return Err("Invalid SNR native vote area".into());
            }
            let bytes = read(native, n("playerIdOffset")? as usize + 1)?;
            if ptr_at(&bytes, 0, ps)? != n("nativeClass")? {
                return Err("SNR native vote area class changed".into());
            }
            let id = bytes[n("playerIdOffset")? as usize];
            if id == 255 || ids.contains(&id) {
                return Err("Invalid SNR meeting identity".into());
            }
            ids.push(id);
        }
        if u32_read(read, list + n("versionOffset")?)? != version {
            return Err("SNR meeting order changed during read".into());
        }
        Ok(json!({"enabled":true,"currentPage":page,"playerIds":ids}))
    };
    let first = once()?;
    let second = once()?;
    if first != second {
        return Err("SNR meeting changed during read".into());
    }
    Ok(second)
}
