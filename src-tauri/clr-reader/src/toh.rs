use crate::{
    managed::{Dictionary, Managed},
    metadata::Metadata,
    runtime::Module,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn role_classes(meta: &Metadata) -> Result<BTreeMap<String, bool>, String> {
    fn inherits(meta: &Metadata, token: u32, target: &str, visited: &mut BTreeSet<u32>) -> bool {
        if token == 0 || !visited.insert(token) || visited.len() > 256 {
            return false;
        }
        let Ok(ty) = meta.type_def(token) else {
            return false;
        };
        ty.name == target
            || inherits(meta, ty.extends, target, visited)
            || meta
                .interfaces
                .iter()
                .filter(|(owner, _)| *owner == token)
                .any(|(_, interface)| inherits(meta, *interface, target, visited))
    }
    let mut result = BTreeMap::new();
    for ty in &meta.types {
        if !inherits(
            meta,
            ty.token,
            "TownOfHostForE.Roles.Core.RoleBase",
            &mut BTreeSet::new(),
        ) {
            continue;
        }
        result.insert(
            ty.name.clone(),
            inherits(
                meta,
                ty.token,
                "TownOfHostForE.Roles.Core.Interfaces.IKiller",
                &mut BTreeSet::new(),
            ),
        );
    }
    Ok(result)
}
fn dictionary_layout(m: &Managed<'_>, slot: u64, d: &Dictionary) -> Result<Value, String> {
    if d.entries == 0 {
        return Err("TOH4E dictionary entries are not initialized".into());
    }
    let entry = d.data.element_type_handle;
    let raw = |name: &str| m.field(entry, name).map(|f| f.data.offset);
    Ok(
        json!({"dictionarySlot":slot,"dictionaryType":d.object_type,"entriesType":d.data.method_table,
        "entriesOffset":m.offset(d.object_type,"_entries")?,"countOffset":m.offset(d.object_type,"_count")?,"versionOffset":m.offset(d.object_type,"_version")?,
        "dataOffset":d.data.array_data-d.entries,"stride":d.data.component_size,"nextOffset":raw("next")?,"keyOffset":raw("key")?,"valueOffset":raw("value")?}),
    )
}
fn killer_layout(
    m: &Managed<'_>,
    module: u64,
    classes: &BTreeMap<String, bool>,
) -> Result<Value, String> {
    let Some(manager) = m.type_by_name(module, "TownOfHostForE.Roles.Core.CustomRoleManager")?
    else {
        return Ok(Value::Null);
    };
    let Ok(field) = m.field(manager, "AllActiveRoles") else {
        return Ok(Value::Null);
    };
    let Some(slot) = m.static_slot(&field)? else {
        return Ok(Value::Null);
    };
    let dictionary = m.runtime.target().pointer(slot)?;
    if dictionary == 0 {
        return Ok(Value::Null);
    }
    let entries = m.dictionary(dictionary, 256)?;
    if entries.entries == 0 {
        return Ok(Value::Null);
    }
    let mut types = Map::new();
    for (name, &is_killer) in classes {
        let Some(ty) = m.type_by_name(module, name)? else {
            continue;
        };
        types.insert(
            ty.to_string(),
            json!({"isKiller":is_killer,"stateOffset":m.offset(ty,"MyState")?}),
        );
    }
    let mut layout = dictionary_layout(m, slot, &entries)?;
    layout["types"] = json!(types);
    m.verify_dictionary(&entries)?;
    Ok(layout)
}
fn catalog(
    m: &Managed<'_>,
    module: u64,
    names: &BTreeMap<i64, String>,
    teams: &BTreeMap<i64, String>,
    classes: &BTreeMap<String, bool>,
) -> Result<Vec<Value>, String> {
    let Some(manager) = m.type_by_name(module, "TownOfHostForE.Roles.Core.CustomRoleManager")?
    else {
        return Ok(Vec::new());
    };
    let Ok(field) = m.field(manager, "AllRolesInfo") else {
        return Ok(Vec::new());
    };
    let Some(dictionary) = m.static_object(&field)? else {
        return Ok(Vec::new());
    };
    let entries = m.dictionary(dictionary, 1024)?;
    if entries.entries == 0 {
        return Ok(Vec::new());
    }
    let mut killers = BTreeMap::new();
    for (name, &killer) in classes {
        let Some(ty) = m.type_by_name(module, name)? else {
            continue;
        };
        let Ok(field) = m.field(ty, "RoleInfo") else {
            continue;
        };
        if let Some(info) = m.static_object(&field)? {
            killers.insert(info, killer);
        }
    }
    let key = m.field(entries.data.element_type_handle, "key")?;
    let key = m.numeric_description(&key, true)?;
    if key.size != 4 || !key.signed {
        return Err("TOH4E role catalog key must be Int32".into());
    }
    let mut result = BTreeMap::new();
    for &row in &entries.rows {
        let id = m.number(row + key.offset, 4, true)?;
        let info = m.entry_object(&entries, row, "value")?;
        if info == 0 {
            continue;
        }
        if m.runtime.type_name(m.object_type(info)?)? != "TownOfHostForE.Roles.Core.SimpleRoleInfo"
        {
            continue;
        }
        if m.number_field(info, "RoleName")? != id {
            return Err("TOH4E RoleInfo identity mismatch".into());
        }
        let team = m.number_field(info, "CustomRoleType")?;
        let (Some(name), Some(faction)) = (names.get(&id), teams.get(&team)) else {
            continue;
        };
        let command = m.string_field(info, "ChatCommand", 256)?;
        let label = command
            .as_ref()
            .filter(|text| !text.trim().is_empty() && text.chars().any(|c| c as u32 > 127))
            .unwrap_or(name);
        let entry = json!({"roleId":id,"roleName":name,"displayName":label,"customRoleType":faction,"isKiller":killers.get(&info)});
        if result.insert(id, entry).is_some() {
            return Err("Duplicate TOH4E RoleInfo".into());
        }
    }
    m.verify_dictionary(&entries)?;
    Ok(result.into_values().collect())
}
pub fn layout(m: &Managed<'_>, pid: u32) -> Result<Value, String> {
    let mut sources: Vec<(Module, u64, u64, u64)> = Vec::new();
    for module in m.modules()? {
        let leaf = Managed::module_leaf(&module)
            .replace(['_', '-'], "")
            .to_ascii_lowercase();
        if !leaf.starts_with("townofhostfore") {
            continue;
        }
        let Some(ty) = m.type_by_name(module.address, "TownOfHostForE.PlayerState")? else {
            continue;
        };
        if m.runtime.collectible(ty)? {
            continue;
        }
        let Ok(field) = m.field(ty, "allPlayerStates") else {
            continue;
        };
        let Some(slot) = m.static_slot(&field)? else {
            continue;
        };
        let dictionary = m.runtime.target().pointer(slot)?;
        if dictionary != 0 {
            sources.push((module, ty, slot, dictionary));
        }
    }
    if sources.len() != 1 {
        return Err(format!(
            "TOH4E expected one initialized player registry, found {}",
            sources.len()
        ));
    }
    let (module, player_type, slot, dictionary) = sources.pop().unwrap();
    let entries = m.dictionary(dictionary, 256)?;
    let role = m.field(player_type, "MainRole")?;
    let descriptor = m.numeric_description(&role, false)?;
    if descriptor.size != 4 || !descriptor.signed || descriptor.names.is_empty() {
        return Err("Unsupported TOH4E role enum".into());
    }
    let classes = m.metadata(module.address, role_classes)?;
    let teams = m.metadata(module.address, |meta| {
        meta.types
            .iter()
            .find(|t| t.name == "TownOfHostForE.Roles.Core.CustomRoleTypes")
            .map(|ty| meta.enum_values(ty.token))
            .unwrap_or_else(|| Ok(BTreeMap::new()))
    })?;
    let role_catalog = if teams.is_empty() {
        Vec::new()
    } else {
        catalog(m, module.address, &descriptor.names, &teams, &classes)?
    };
    let opportunist = if let Some(ty) =
        m.type_by_name(module.address, "TownOfHostForE.Roles.Neutral.Opportunist")?
    {
        m.field(ty, "CanKill")
            .ok()
            .filter(|f| f.data.element == 2)
            .and_then(|f| m.static_slot(&f).ok().flatten())
            .unwrap_or(0)
    } else {
        0
    };
    let mut layout = dictionary_layout(m, slot, &entries)?;
    let object = layout.as_object_mut().unwrap();
    object.insert("pid".into(), json!(pid));
    object.insert("pointerSize".into(), json!(m.runtime.target().pointer_size));
    object.insert("playerType".into(), json!(player_type));
    object.insert("idOffset".into(), json!(m.offset(player_type, "PlayerId")?));
    object.insert(
        "roleOffset".into(),
        json!(m.offset(player_type, "MainRole")?),
    );
    object.insert("names".into(), json!(descriptor.names));
    object.insert(
        "killerLayout".into(),
        killer_layout(m, module.address, &classes)?,
    );
    object.insert("roleCatalog".into(), json!(role_catalog));
    object.insert("opportunistCanKillSlot".into(), json!(opportunist));
    m.verify_dictionary(&entries)?;
    if m.runtime.target().pointer(slot)? != dictionary {
        return Err("TOH4E player registry changed during resolve".into());
    }
    Ok(json!({"status":"ok","pid":pid,"layout":layout}))
}
