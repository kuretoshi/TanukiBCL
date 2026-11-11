//! Port of nosSnapshotMemory.ts / nosPalette.ts. Discovery and all recurring
//! snapshot and palette reads run in Rust.
use super::memory::*;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone)]
struct Costume {
    offset: usize,
    length: usize,
    name: usize,
    capacity: usize,
}
#[derive(Clone)]
pub struct Layout {
    pub schema: u64,
    ps: usize,
    slot: u64,
    header: Value,
    player: Value,
    radio: Value,
    stride: usize,
    header_size: usize,
    costumes: Vec<Costume>,
}
impl Layout {
    pub fn parse(value: &Value, pid: u32) -> Result<Self, String> {
        let ps = pointer_size(value, pid)?;
        let schema = uint(&value["schemaVersion"], 20991231)?;
        if ![20260918, 20260928, 20261005].contains(&schema) && schema < 20261009 {
            return Err("Unsupported NoS snapshot schema".into());
        }
        let slot = pointer_field(&value["latestSlotAddress"], ps)?;
        let h = &value["snapshot"];
        let p = &value["playerData"];
        if !h.is_object() || !p.is_object() {
            return Err("Missing NoS layout".into());
        }
        let stride = uint(&p["size"], 4096)? as usize;
        if stride < 96 {
            return Err("Invalid NoS player stride".into());
        }
        for key in [
            "localMicPositionX",
            "localMicPositionY",
            "playersLength",
            "players",
        ] {
            offset(&h[key], 4, 256)?;
        }
        optional(&h["localIsPseudocide"], 1, 256)?;
        for key in [
            "playerId",
            "isKiller",
            "isImpostor",
            "isCrewmate",
            "isNeutral",
            "isImpostorlike",
            "nameLength",
        ] {
            offset(&p[key], 1, stride)?;
        }
        for key in [
            "speakerPositionX",
            "speakerPositionY",
            "colorR",
            "colorG",
            "colorB",
        ] {
            offset(&p[key], 4, stride)?;
        }
        offset(&p["name"], 64, stride)?;
        let addon = optional(&p["addonData"], 4, stride)?;
        if (schema > 20261009 && addon.is_none())
            || addon.is_some() != optional(&h["addonData"], 4, 256)?.is_some()
        {
            return Err("Incomplete NoS addon layout".into());
        }
        let rates = [
            optional(&p["bodyRateX"], 4, stride)?,
            optional(&p["bodyRateY"], 4, stride)?,
        ];
        let body = [
            optional(&p["bodyType"], 4, stride)?,
            optional(&p["neckLength"], 4, stride)?,
        ];
        if rates[0].is_some() != rates[1].is_some()
            || body[0].is_some() != body[1].is_some()
            || (schema >= 20261009 && (rates[0].is_none() || body[0].is_none()))
        {
            return Err("Incomplete NoS body layout".into());
        }
        optional(&p["isJammed"], 1, stride)?;
        let mut costumes = Vec::new();
        for key in ["skin", "hat", "visor"] {
            let c = &p[key];
            if c.is_null() {
                continue;
            }
            let capacity = uint(&c["capacity"], 1024)? as usize;
            if capacity == 0 {
                return Err("Empty NoS costume capacity".into());
            }
            let size = uint(&c["size"], stride as u64)? as usize;
            costumes.push(Costume {
                offset: offset(&c["offset"], size, stride)?,
                length: offset(&c["nameLength"], 1, size)?,
                name: offset(&c["name"], capacity * 2, size)?,
                capacity,
            });
        }
        if (!costumes.is_empty() && costumes.len() != 3)
            || (schema >= 20261005 && costumes.len() != 3)
        {
            return Err("Incomplete NoS costume layout".into());
        }
        let r = &value["radioData"];
        let rc = [
            !h["radiosLength"].is_null(),
            !h["radios"].is_null(),
            !r.is_null(),
        ];
        if rc.iter().any(|v| *v) && !rc.iter().all(|v| *v) {
            return Err("Incomplete NoS radio layout".into());
        }
        if rc[0] {
            offset(&h["radiosLength"], 4, 256)?;
            offset(&h["radios"], 4, 256)?;
            let size = uint(&r["size"], 4096)? as usize;
            if size < 76 {
                return Err("Invalid NoS radio stride".into());
            }
            for key in ["kind", "hearableMask"] {
                offset(&r[key], 4, size)?;
            }
            offset(&r["nameLength"], 1, size)?;
            offset(&r["name"], 64, size)?;
        }
        let header_size = h
            .as_object()
            .unwrap()
            .values()
            .filter_map(Value::as_u64)
            .map(|v| v as usize + 4)
            .max()
            .unwrap_or(0)
            .max(h["players"].as_u64().unwrap() as usize + ps)
            .max(h["radios"].as_u64().unwrap_or(0) as usize + ps);
        if header_size > 264 {
            return Err("Invalid NoS header size".into());
        }
        Ok(Self {
            schema,
            ps,
            slot,
            header: h.clone(),
            player: p.clone(),
            radio: r.clone(),
            stride,
            header_size,
            costumes,
        })
    }
    pub fn read(&self, read: &Read<'_>) -> Result<Value, String> {
        let selected = ptr(read, self.slot, self.ps)?;
        if !pointer_valid(selected, self.ps) {
            return Err("NoS snapshot not published".into());
        }
        let h = read(selected, self.header_size)?;
        let s = &self.header;
        let p = &self.player;
        let at = |v: &Value| v.as_u64().unwrap() as usize;
        let count = i32_at(&h, at(&s["playersLength"]))?;
        let address = ptr_at(&h, at(&s["players"]), self.ps)?;
        if !(0..=24).contains(&count) || (count > 0 && !pointer_valid(address, self.ps)) {
            return Err("Invalid NoS players".into());
        }
        let bytes = if count > 0 {
            read(address, count as usize * self.stride)?
        } else {
            Vec::new()
        };
        let mut players = Vec::new();
        let mut ids = HashSet::new();
        for row in bytes.chunks_exact(self.stride) {
            let id = row[at(&p["playerId"])];
            let length = row[at(&p["nameLength"])] as usize;
            if length > 32 || !ids.insert(id) {
                return Err("Invalid NoS player identity".into());
            }
            let mut player = json!({"playerId":id,"name":utf16(row,at(&p["name"]),length)?});
            for key in [
                "isKiller",
                "isImpostor",
                "isCrewmate",
                "isNeutral",
                "isImpostorlike",
            ] {
                player[key] = json!(boolean(row, at(&p[key]))?);
            }
            if !p["isJammed"].is_null() {
                player["isJammed"] = json!(boolean(row, at(&p["isJammed"]))?);
            }
            for key in [
                "speakerPositionX",
                "speakerPositionY",
                "colorR",
                "colorG",
                "colorB",
                "bodyRateX",
                "bodyRateY",
                "neckLength",
            ] {
                if !p[key].is_null() {
                    let value = f32_at(row, at(&p[key]))?;
                    if key == "neckLength" && value < 0.0 {
                        return Err("Invalid NoS body state".into());
                    }
                    player[key] = json!(value);
                }
            }
            if !p["bodyType"].is_null() {
                let body = i32_at(row, at(&p["bodyType"]))?;
                if !(0..=32).contains(&body) {
                    return Err("Invalid NoS body state".into());
                }
                player["bodyType"] = json!(body);
            }
            if !p["addonData"].is_null() {
                player["addonData"] = json!(i32_at(row, at(&p["addonData"]))?);
            }
            for (key, costume) in ["skin", "hat", "visor"].iter().zip(&self.costumes) {
                let length = row[costume.offset + costume.length] as usize;
                if length > costume.capacity {
                    return Err("Invalid NoS costume name".into());
                }
                player[*key] = json!({"name":utf16(row,costume.offset+costume.name,length)?});
            }
            players.push(player);
        }
        let (radio_count, radio_address) = if s["radiosLength"].is_null() {
            (0, 0)
        } else {
            (
                i32_at(&h, at(&s["radiosLength"]))?,
                ptr_at(&h, at(&s["radios"]), self.ps)?,
            )
        };
        if !(0..=32).contains(&radio_count)
            || (radio_count > 0 && !pointer_valid(radio_address, self.ps))
        {
            return Err("Invalid NoS radios".into());
        }
        let r = &self.radio;
        let radio_stride = r["size"].as_u64().unwrap_or(1) as usize;
        let radio_bytes = if radio_count > 0 {
            read(radio_address, radio_count as usize * radio_stride)?
        } else {
            Vec::new()
        };
        let mut radios = Vec::new();
        for row in radio_bytes.chunks_exact(radio_stride) {
            let length = row[at(&r["nameLength"])] as usize;
            if length > 32 {
                return Err("Invalid NoS radio name".into());
            }
            radios.push(json!({"kind":i32_at(row,at(&r["kind"]))?,"hearableMask":i32_at(row,at(&r["hearableMask"]))?,"nameLength":length,"name":utf16(row,at(&r["name"]),length)?}));
        }
        verify(read, selected, &h)?;
        if count > 0 {
            verify(read, address, &bytes)?;
        }
        if radio_count > 0 {
            verify(read, radio_address, &radio_bytes)?;
        }
        let mut result = json!({"publication":selected,"players":players,"radios":radios,"localMicPosition":{"x":f32_at(&h,at(&s["localMicPositionX"]))?,"y":f32_at(&h,at(&s["localMicPositionY"]))?}});
        if !s["addonData"].is_null() {
            result["addonData"] = json!(i32_at(&h, at(&s["addonData"]))?);
        }
        if !s["localIsPseudocide"].is_null() {
            result["localIsPseudocide"] = json!(boolean(&h, at(&s["localIsPseudocide"]))?);
        }
        Ok(result)
    }
}
pub fn palette(layout: &Value, pid: u32, read: &Read<'_>) -> Result<Value, String> {
    let ps = pointer_size(layout, pid)?;
    let slot = pointer_field(&layout["arraySlot"], ps)?;
    let type_id = pointer_field(&layout["arrayType"], ps)?;
    if layout["arrayLengthOffset"].as_u64() != Some(ps as u64) {
        return Err("Invalid NoS palette length offset".into());
    }
    let data = uint(&layout["arrayDataOffset"], 64)?;
    let stride = uint(&layout["stride"], 64)? as usize;
    if data < 8 || stride < 12 {
        return Err("Invalid NoS palette layout".into());
    }
    let channels = [
        offset(&layout["r"], 4, stride)?,
        offset(&layout["g"], 4, stride)?,
        offset(&layout["b"], 4, stride)?,
    ];
    let array = ptr(read, slot, ps)?;
    if !pointer_valid(array, ps)
        || ptr(read, array, ps)? != type_id
        || u32_read(read, array + ps as u64)? != 32
    {
        return Err("NoS palette changed".into());
    }
    let bytes = read(array + data, 32 * stride)?;
    let mut colors = Vec::new();
    for row in bytes.chunks_exact(stride) {
        let mut color = String::from("#");
        for offset in channels {
            let n = f32_at(row, offset)?;
            if !(0.0..=1.0).contains(&n) {
                return Err("Invalid NoS palette color".into());
            }
            color.push_str(&format!("{:02x}", (f64::from(n) * 255.0).round() as u8));
        }
        colors.push(color);
    }
    if ptr(read, slot, ps)? != array || ptr(read, array, ps)? != type_id {
        return Err("NoS palette changed during read".into());
    }
    verify(read, array + data, &bytes)?;
    Ok(json!(colors))
}
