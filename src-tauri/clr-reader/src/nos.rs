use crate::{managed::Managed, runtime::Module};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn nebula(m: &Managed<'_>) -> Result<Module, String> {
    let mut modules = m
        .modules()?
        .into_iter()
        .filter(|module| Managed::module_leaf(module).eq_ignore_ascii_case("Nebula.dll"));
    let module = modules.next().ok_or("Nebula.dll is not loaded")?;
    if modules.next().is_some() {
        return Err("Multiple NoS modules are loaded".into());
    }
    Ok(module)
}
fn required_type(m: &Managed<'_>, module: u64, name: &str) -> Result<u64, String> {
    m.type_by_name(module, name)?
        .ok_or_else(|| format!("NoS type unavailable: {name}"))
}
fn raw_offset(m: &Managed<'_>, ty: u64, name: &str) -> Result<u32, String> {
    let f = m.field(ty, name)?;
    if f.data.is_static != 0 || f.data.offset > 16384 {
        return Err("Invalid NoS structure offset".into());
    }
    Ok(f.data.offset)
}
fn costume(m: &Managed<'_>, player: u64, name: &str) -> Result<Option<Value>, String> {
    let Ok(field) = m.field(player, name) else {
        return Ok(None);
    };
    let ty = field.data.field_type;
    if ty == 0 {
        return Err("NoS costume type unavailable".into());
    }
    let buffer = m.field(ty, "Name")?;
    let length = raw_offset(m, ty, "NameLength")?;
    let buffer_type = m.runtime.type_data(buffer.data.field_type)?;
    let size = m.metadata(buffer_type.module, |meta| {
        meta.class_sizes
            .get(&buffer_type.token)
            .copied()
            .ok_or("Fixed costume buffer layout unavailable".into())
    })?;
    if size == 0 || size % 2 != 0 || size / 2 > 1024 {
        return Err("Invalid NoS costume capacity".into());
    }
    let struct_size = (length + 1).max(buffer.data.offset + size);
    Ok(Some(
        json!({"offset":field.data.offset,"nameLength":length,"name":buffer.data.offset,"capacity":size/2,"size":struct_size}),
    ))
}
pub fn layout(m: &Managed<'_>, pid: u32) -> Result<Value, String> {
    let module = nebula(m)?;
    let tbcl = required_type(m, module.address, "Nebula.Collab.TBCLFields")?;
    if m.runtime.collectible(tbcl)? {
        return Err("Collectible NoS publication is unsupported".into());
    }
    let next = m.field(tbcl, "nextIndex")?;
    let latest = m.field(tbcl, "Latest")?;
    if next.data.element != 8 || latest.data.element != 15 {
        return Err("Unsupported NoS publication statics".into());
    }
    let anchor = m
        .static_slot(&next)?
        .ok_or("NoS publication is not initialized")?;
    let slot = anchor
        .checked_sub(next.data.offset as u64)
        .and_then(|base| base.checked_add(latest.data.offset as u64))
        .ok_or("Invalid NoS static base")?;
    let snapshot = required_type(m, module.address, "Nebula.Collab.TBCLFields+Snapshot")?;
    let player = required_type(m, module.address, "Nebula.Collab.TBCLFields+PlayerData")?;
    let radio = m.type_by_name(module.address, "Nebula.Collab.TBCLFields+RadioData")?;
    let fields = |ty: u64,
                  required: &[(&str, &str)],
                  optional: &[(&str, &str)]|
     -> Result<Map<String, Value>, String> {
        let mut result = Map::new();
        for &(name, key) in required {
            result.insert(key.into(), json!(raw_offset(m, ty, name)?));
        }
        for &(name, key) in optional {
            result.insert(
                key.into(),
                json!(m.field(ty, name).ok().map(|f| f.data.offset)),
            );
        }
        Ok(result)
    };
    let snapshot_layout = fields(
        snapshot,
        &[
            ("LocalMicPositionX", "localMicPositionX"),
            ("LocalMicPositionY", "localMicPositionY"),
            ("PlayersLength", "playersLength"),
            ("Players", "players"),
        ],
        &[
            ("AddonData", "addonData"),
            ("RadiosLength", "radiosLength"),
            ("Radios", "radios"),
            ("LocalIsPseudocide", "localIsPseudocide"),
        ],
    )?;
    let mut player_layout = fields(
        player,
        &[
            ("PlayerId", "playerId"),
            ("IsKiller", "isKiller"),
            ("IsImpostor", "isImpostor"),
            ("IsCrewmate", "isCrewmate"),
            ("IsNeutral", "isNeutral"),
            ("IsImpostorlike", "isImpostorlike"),
            ("SpeakerPositionX", "speakerPositionX"),
            ("SpeakerPositionY", "speakerPositionY"),
            ("NameLength", "nameLength"),
            ("Name", "name"),
            ("ColorR", "colorR"),
            ("ColorG", "colorG"),
            ("ColorB", "colorB"),
        ],
        &[
            ("AddonData", "addonData"),
            ("BodyRateX", "bodyRateX"),
            ("BodyRateY", "bodyRateY"),
            ("BodyType", "bodyType"),
            ("NeckLength", "neckLength"),
            ("IsJammed", "isJammed"),
        ],
    )?;
    let offset = |fields: &Map<String, Value>, key: &str| fields[key].as_u64().unwrap_or(0);
    let mut size = (offset(&player_layout, "name") + 64).max(offset(&player_layout, "colorB") + 4);
    for key in [
        "bodyRateX",
        "bodyRateY",
        "bodyType",
        "neckLength",
        "addonData",
    ] {
        size = size.max(offset(&player_layout, key) + 4);
    }
    size = size.max(offset(&player_layout, "isJammed") + 1);
    for (name, key) in [("Skin", "skin"), ("Hat", "hat"), ("Visor", "visor")] {
        let value = costume(m, player, name)?;
        if let Some(c) = &value {
            size = size.max(c["offset"].as_u64().unwrap() + c["size"].as_u64().unwrap());
        }
        player_layout.insert(key.into(), json!(value));
    }
    player_layout.insert("size".into(), json!((size + 3) & !3));
    let radio_layout = if let Some(radio) = radio {
        let mut fields = fields(
            radio,
            &[
                ("Kind", "kind"),
                ("HearableMask", "hearableMask"),
                ("NameLength", "nameLength"),
                ("Name", "name"),
            ],
            &[],
        )?;
        let size = (offset(&fields, "kind") + 4)
            .max(offset(&fields, "hearableMask") + 4)
            .max(offset(&fields, "nameLength") + 1)
            .max(offset(&fields, "name") + 64);
        fields.insert("size".into(), json!((size + 3) & !3));
        Some(fields)
    } else {
        None
    };
    if snapshot_layout["radiosLength"].is_null() != snapshot_layout["radios"].is_null()
        || (!snapshot_layout["radios"].is_null() && radio_layout.is_none())
    {
        return Err("Incomplete NoS radio layout".into());
    }
    let schema = m.metadata(module.address, |meta| {
        let ty = meta
            .types
            .iter()
            .find(|t| t.name == "Nebula.Collab.TBCLFields")
            .ok_or("TBCL metadata missing")?;
        let field = meta.fields[ty.first_field as usize - 1..ty.end_field as usize - 1]
            .iter()
            .find(|f| f.name == "Version");
        Ok(field
            .and_then(|f| meta.constants.get(&f.token))
            .copied()
            .unwrap_or(if player_layout["skin"].is_null() {
                20260918
            } else {
                20261005
            }))
    })?;
    if m.static_slot(&next)? != Some(anchor) {
        return Err("NoS publication static changed".into());
    }
    let metadata = json!({"pid":pid,"processStartUtcTicks":m.runtime.target().started+504911232000000000u64,"pointerSize":m.runtime.target().pointer_size,"schemaVersion":schema,"latestSlotAddress":slot,"snapshot":snapshot_layout,"playerData":player_layout,"radioData":radio_layout});
    Ok(json!({"status":"ok","pid":pid,"metadata":metadata}))
}
fn color_channel(m: &Managed<'_>, ty: u64, name: &str, depth: usize) -> Result<u32, String> {
    if depth > 2 {
        return Err("Unsupported NoS color nesting".into());
    }
    let fields = m.fields(ty)?;
    if let Some(field) = fields.iter().find(|f| {
        f.data.is_static == 0
            && f.data.element == 12
            && (f.name.eq_ignore_ascii_case(name) || f.name == format!("<{name}>k__BackingField"))
    }) {
        return Ok(field.data.offset);
    }
    let nested: Vec<_> = fields
        .iter()
        .filter(|f| f.data.is_static == 0 && f.data.element == 17 && f.data.field_type != 0)
        .collect();
    if nested.len() != 1 {
        return Err("NoS color channel unavailable".into());
    }
    Ok(nested[0].data.offset + color_channel(m, nested[0].data.field_type, name, depth + 1)?)
}
pub fn palette(m: &Managed<'_>, pid: u32) -> Result<Value, String> {
    let mut candidates = Vec::new();
    for module in m.modules()? {
        if !Managed::module_leaf(&module).eq_ignore_ascii_case("Nebula.dll") {
            continue;
        }
        let Some(ty) = m.type_by_name(module.address, "Nebula.Modules.Cosmetics.DynamicPalette")?
        else {
            continue;
        };
        let field = m.field(ty, "PlayerColors")?;
        let Some(slot) = m.static_slot(&field)? else {
            continue;
        };
        let array = m.runtime.target().pointer(slot)?;
        if array == 0 {
            continue;
        }
        let data = m.runtime.object_data(array)?;
        if data.kind == 3 && data.rank == 1 && data.length == 32 {
            candidates.push((field, slot, array, data));
        }
    }
    if candidates.len() != 1 {
        return Err("NoS palette is uninitialized or ambiguous".into());
    }
    let (field, slot, array, data) = candidates.pop().unwrap();
    if m.runtime.collectible(data.method_table)?
        || m.runtime.collectible(field.data.owner)?
        || data.element_type_handle == 0
    {
        return Err("Unsupported NoS palette type".into());
    }
    let metadata = json!({"pid":pid,"pointerSize":m.runtime.target().pointer_size,"arraySlot":slot,"arrayType":data.method_table,
        "arrayLengthOffset":m.runtime.target().pointer_size,"arrayDataOffset":data.array_data-array,"stride":data.component_size,
        "r":color_channel(m,data.element_type_handle,"R",0)?,"g":color_channel(m,data.element_type_handle,"G",0)?,"b":color_channel(m,data.element_type_handle,"B",0)?});
    if m.static_slot(&field)? != Some(slot)
        || m.runtime.target().pointer(slot)? != array
        || m.object_type(array)? != data.method_table
    {
        return Err("NoS palette changed during resolve".into());
    }
    Ok(json!({"status":"ok","pid":pid,"metadata":metadata}))
}
fn definition(m: &Managed<'_>, role: u64) -> Result<u64, String> {
    for name in ["role", "Role"] {
        if let Ok(value) = m.object_field(role, name) {
            if value != 0 && m.field(m.object_type(value)?, "LocalizedName").is_ok() {
                return Ok(value);
            }
        }
    }
    let ty = m.runtime.type_data(m.object_type(role)?)?;
    let name = m.runtime.type_name(m.object_type(role)?)?;
    if let Some((parent, _)) = name.rsplit_once('+') {
        if let Some(parent) = m.type_by_name(ty.module, parent)? {
            if let Ok(field) = m.field(parent, "MyRole") {
                return Ok(m.static_object(&field)?.unwrap_or(0));
            }
        }
    }
    Ok(0)
}
fn rainbow_star(m: &Managed<'_>, player: u64) -> Result<bool, String> {
    let modifiers = m.object_field(player, "myModifiers")?;
    for modifier in m.list(modifiers, 64)? {
        if modifier == 0 {
            continue;
        }
        let ty = m.object_type(modifier)?;
        if m.runtime.type_name(ty)? != "Hori.Scripts.Role.Modifier.StarU+Instance" {
            continue;
        }
        let module = m.runtime.type_data(ty)?.module;
        let parent = required_type(m, module, "Hori.Scripts.Role.Modifier.StarU")?;
        let config = m
            .static_object(&m.field(parent, "RainbowStar")?)?
            .ok_or("RainbowStar config unavailable")?;
        let value = m.object_field(config, "val")?;
        if m.runtime.type_name(m.object_type(value)?)?
            != "Nebula.Configuration.BoolConfigurationValue"
        {
            return Err("Unsupported RainbowStar config type".into());
        }
        return Ok(m.number_field(value, "currentValue")? != 0);
    }
    Ok(false)
}
fn native_field(m: &Managed<'_>, ty: u64, name: &str) -> Result<(u64, u32), String> {
    let slot = m.static_named_slot(ty, &format!("NativeFieldInfoPtr_{name}"))?;
    let info = m.runtime.target().pointer(slot)?;
    let ps = m.runtime.target().pointer_size as u64;
    if m.c_string(m.runtime.target().pointer(info)?, 64)? != name {
        return Err("IL2CPP field identity mismatch".into());
    }
    let offset = m.number(info + 3 * ps, 4, true)?;
    if offset < 2 * ps as i64 || offset > 4096 {
        return Err("IL2CPP field offset out of range".into());
    }
    Ok((m.runtime.target().pointer(info + 2 * ps)?, offset as u32))
}
fn body_layout(m: &Managed<'_>, player: u64, id: u8) -> Result<Value, String> {
    let control = m.object_field(player, "MyControl")?;
    let ty = m.object_type(control)?;
    let address = m
        .runtime
        .target()
        .pointer(control + m.offset(ty, "pooledPtr")?)?;
    let cosmetics_type = required_type(m, m.runtime.type_data(ty)?.module, "CosmeticsLayer")?;
    let (class, cosmetics_offset) = native_field(m, ty, "cosmetics")?;
    let (id_class, id_offset) = native_field(m, ty, "PlayerId")?;
    let (cosmetics_class, body_offset) = native_field(m, cosmetics_type, "bodyType")?;
    let cosmetics = m
        .runtime
        .target()
        .pointer(address + cosmetics_offset as u64)?;
    if class != id_class
        || m.runtime.target().pointer(address)? != class
        || m.runtime.target().pointer(cosmetics)? != cosmetics_class
        || m.number(address + id_offset as u64, 1, false)? != id as i64
    {
        return Err("NoS native player identity mismatch".into());
    }
    Ok(
        json!({"pointerSize":m.runtime.target().pointer_size,"controlAddress":address,"controlClass":class,"cosmeticsClass":cosmetics_class,"playerIdOffset":id_offset,"cosmeticsOffset":cosmetics_offset,"bodyTypeOffset":body_offset}),
    )
}
fn translations(
    m: &Managed<'_>,
    module: u64,
    keys: BTreeSet<String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut missing = keys;
    let mut result = BTreeMap::new();
    if missing.is_empty() {
        return Ok(result);
    }
    let language_type = required_type(m, module, "Nebula.Modules.Language")?;
    for name in ["GuestLanguage", "CurrentLanguage", "DefaultLanguage"] {
        if missing.is_empty() {
            break;
        }
        let Ok(field) = m.field(language_type, name) else {
            continue;
        };
        let Some(language) = m.static_object(&field)? else {
            continue;
        };
        let dictionary = m.object_field(language, "translationMap")?;
        let entries = m.dictionary(dictionary, 100000)?;
        for &row in &entries.rows {
            let key = m
                .runtime
                .string(m.entry_object(&entries, row, "key")?, 512)?;
            if !missing.contains(&key) {
                continue;
            }
            let value = m.entry_object(&entries, row, "value")?;
            if value == 0 {
                continue;
            }
            let value = m.runtime.string(value, 512)?;
            missing.remove(&key);
            result.insert(key, value);
            if missing.is_empty() {
                break;
            }
        }
        m.verify_dictionary(&entries)?;
        if m.static_object(&field)? != Some(language)
            || m.object_field(language, "translationMap")? != dictionary
        {
            return Err("NoS language changed during read".into());
        }
    }
    Ok(result)
}
pub fn roles(m: &Managed<'_>, pid: u32) -> Result<Value, String> {
    let module = nebula(m)?;
    let ty = required_type(m, module.address, "Nebula.Game.NebulaGameManager")?;
    let field = m.field(ty, "instance")?;
    let manager = m.static_object(&field)?.unwrap_or(0);
    let mut result = Vec::new();
    if manager != 0 {
        let dictionary = m.object_field(manager, "allModPlayers")?;
        let entries = m.dictionary(dictionary, 64)?;
        let key_desc = if entries.rows.is_empty() {
            None
        } else {
            let key = m.field(entries.data.element_type_handle, "key")?;
            let description = m.numeric_description(&key, true)?;
            if description.size != 1 || description.signed {
                return Err("NoS player registry key must be byte".into());
            }
            Some(description)
        };
        let mut ids = BTreeSet::new();
        for &row in &entries.rows {
            let id = m.number(row + key_desc.as_ref().unwrap().offset, 1, false)? as u8;
            let player = m.entry_object(&entries, row, "value")?;
            if m.runtime.type_name(m.object_type(player)?)? != "Nebula.Player.PlayerModInfo"
                || m.number_field(player, "PlayerId")? != id as i64
                || !ids.insert(id)
            {
                return Err("Invalid NoS player identity".into());
            }
            let role = m.object_field(player, "myRole")?;
            if role == 0 {
                continue;
            }
            let definition = definition(m, role)?;
            let (name, role_id) = if definition == 0 {
                (None, None)
            } else {
                (
                    m.string_field(definition, "LocalizedName", 256)?,
                    Some(m.number_field(
                        definition,
                        "<Virial.Assignable.IRoleID.Id>k__BackingField",
                    )?),
                )
            };
            let body = if name.as_deref() == Some("berserker") {
                body_layout(m, player, id).ok()
            } else {
                None
            };
            result.push(json!({"playerId":id,"role":{"roleId":role_id,"roleName":name,"displayName":null,"runtimeClass":m.runtime.type_name(m.object_type(role)?)?,"isRainbowStar":rainbow_star(m,player).ok()},"bodyLayout":body}));
        }
        let keys = result
            .iter()
            .filter_map(|row| {
                row["role"]["roleName"]
                    .as_str()
                    .map(|name| format!("role.{name}.name"))
            })
            .collect();
        let translations = translations(m, module.address, keys)?;
        for row in &mut result {
            if let Some(name) = row["role"]["roleName"].as_str() {
                let label = translations.get(&format!("role.{name}.name"));
                row["role"]["displayName"] = json!(label);
            }
        }
        m.verify_dictionary(&entries)?;
        if m.object_field(manager, "allModPlayers")? != dictionary {
            return Err("NoS player registry changed".into());
        }
    }
    if m.static_object(&field)?.unwrap_or(0) != manager {
        return Err("NoS manager changed".into());
    }
    Ok(json!({"status":"ok","pid":pid,"metadata":result}))
}
