use crate::{abi::ObjectData, managed::Managed, runtime::Module};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub struct Source {
    pub module: Module,
    pub player_type: u64,
    pub slot: u64,
    pub array: u64,
    pub data: ObjectData,
    pub players: Vec<u64>,
}
pub fn source(managed: &Managed<'_>) -> Result<Source, String> {
    let mut candidates = Vec::new();
    for module in managed.modules()? {
        if !Managed::module_leaf(&module).eq_ignore_ascii_case("SuperNewRoles.dll") {
            continue;
        }
        let Some(player_type) =
            managed.type_by_name(module.address, "SuperNewRoles.Modules.ExPlayerControl")?
        else {
            continue;
        };
        let field = managed.field(player_type, "_exPlayerControlsArray")?;
        let Some(slot) = managed.static_slot(&field)? else {
            continue;
        };
        let array = managed.runtime.target().pointer(slot)?;
        if array == 0 {
            continue;
        }
        let (data, players) = managed.array(array, 256)?;
        if data.length != 256 || data.element_type_handle != player_type {
            return Err("Unexpected SNR player array structure".into());
        }
        if managed.runtime.target().pointer(slot)? != array {
            return Err("SNR player array changed".into());
        }
        candidates.push(Source {
            module,
            player_type,
            slot,
            array,
            data,
            players,
        });
    }
    match candidates.len() {
        1 => Ok(candidates.pop().unwrap()),
        0 => Err("SNR player array is not initialized".into()),
        _ => Err("Multiple initialized SNR modules; refusing ambiguous data".into()),
    }
}
pub fn basic_layout(managed: &Managed<'_>, pid: u32) -> Result<Value, String> {
    // SNR does not populate ExPlayerControl until roles are assigned. Cosmetic
    // layers already exist in the lobby and must remain readable on their own.
    let cosmetic_sample = cosmetic_publication(managed, pid);
    let cosmetic_error = cosmetic_sample.as_ref().err().cloned();
    let (publication, cosmetics) =
        cosmetic_sample.unwrap_or_else(|_| (Value::Null, BTreeMap::new()));
    let source = match source(managed) {
        Ok(source) => source,
        Err(error) if !publication.is_null() => {
            return Ok(
                json!({"status":"ok","pid":pid,"players":[],"liveLayout":null,
                "secondaryCosmetics":publication,"diagnostics":{"roles":error}}),
            );
        }
        Err(error) => return Err(error),
    };
    let descriptor = |name: &str| {
        managed
            .field(source.player_type, name)
            .and_then(|f| managed.numeric_description(&f, false))
            .ok()
    };
    let mut players = Vec::new();
    for (id, &player) in source.players.iter().enumerate() {
        if player == 0 {
            continue;
        }
        if managed.object_type(player)? != source.player_type
            || managed.number_field(player, "PlayerId")? != id as i64
        {
            return Err("SNR player identity mismatch".into());
        }
        let describe = |object: u64, name: &str| -> Value {
            let Ok(ty) = managed.object_type(object) else {
                return Value::Null;
            };
            let Ok(field) = managed.field(ty, name) else {
                return Value::Null;
            };
            let Ok(d) = managed.numeric_description(&field, false) else {
                return Value::Null;
            };
            match managed.number(object + d.offset, d.size, d.signed) {
                Ok(value) => {
                    let label = d.names.get(&value).cloned().or_else(|| {
                        if name == "ModifierRole" {
                            let parts: Vec<_> = d
                                .names
                                .iter()
                                .filter(|(v, _)| {
                                    **v > 0 && (**v & (**v - 1)) == 0 && (value & **v) == **v
                                })
                                .map(|(_, name)| name.clone())
                                .collect();
                            Some(parts.join(" | "))
                        } else {
                            None
                        }
                    });
                    json!({"value":value,"name":label})
                }
                Err(_) => Value::Null,
            }
        };
        let role_base = managed.object_field(player, "roleBase").unwrap_or(0);
        let abilities = managed
            .object_field(player, "_playerAbilities")
            .and_then(|list| managed.list(list, 1024))
            .unwrap_or_default();
        let can_kill = abilities
            .iter()
            .find_map(|&a| managed.number_field(a, "CanKill").ok())
            .is_none_or(|n| n != 0);
        let assigned = describe(role_base, "AssignedTeam");
        let layer = player_cosmetics(managed, player).ok();
        let secondary = layer.as_ref().and_then(|layer| cosmetics.get(layer));
        players.push(json!({"playerId":id,"role":describe(player,"Role"),"modifier":describe(player,"ModifierRole"),"ghostRole":describe(player,"GhostRole"),
            "roleClass":if role_base==0{None}else{managed.object_type(role_base).and_then(|t|managed.runtime.type_name(t)).ok()},
            "isNeutral":assigned["name"]=="Neutral","assignedTeam":assigned,"canKill":can_kill,
            "winnerTeam":describe(role_base,"WinnerTeam"),"teamTag":describe(role_base,"TeamTag"),
            "hat2Id":secondary.and_then(|s|s.0.as_ref()),"visor2Id":secondary.and_then(|s|s.1.as_ref()),
            "abilities":abilities.iter().map(|&a|json!({"name":managed.object_type(a).and_then(|t|managed.runtime.type_name(t)).ok(),"currentTeam":describe(a,"CurrentTeam")})).collect::<Vec<_>>()
        }));
    }
    if managed.runtime.target().pointer(source.slot)? != source.array {
        return Err("SNR array changed during sample".into());
    }
    let jumbo = jumbo_layout(managed, &source);
    let busker = busker_layout(managed, &source);
    let meeting = meeting_layout(managed, &source);
    Ok(
        json!({"status":"ok","pid":pid,"players":players,"secondaryCosmetics":publication,"diagnostics":{"secondaryCosmetics":cosmetic_error,"jumbo":jumbo.as_ref().err(),"busker":busker.as_ref().err(),"meeting":meeting.as_ref().err()},"liveLayout":{
            "pid":pid,"pointerSize":managed.runtime.target().pointer_size,"arraySlot":source.slot,
            "arrayType":source.data.method_table,"playerType":source.player_type,
            "arrayLengthOffset":managed.runtime.target().pointer_size,"arrayDataOffset":source.data.array_data-source.array,
            "jumbo":jumbo.ok(),"busker":busker.ok(),"meeting":meeting.ok(),
            "fields":{"playerId":descriptor("PlayerId"),"role":descriptor("Role"),"modifier":descriptor("ModifierRole"),"ghostRole":descriptor("GhostRole")}
        }}),
    )
}
fn ability_list(managed: &Managed<'_>, source: &Source) -> Result<(u64, u64, u64), String> {
    let field = managed.field(source.player_type, "_playerAbilities")?;
    let list_type = field.data.field_type;
    for &player in &source.players {
        if player == 0 {
            continue;
        }
        let list = managed.object_field(player, "_playerAbilities")?;
        if list == 0 {
            continue;
        }
        if managed.object_type(list)? != list_type {
            return Err("SNR ability list type mismatch".into());
        }
        let items = managed.object_field(list, "_items")?;
        if items != 0 {
            let data = managed.runtime.object_data(items)?;
            if data.kind == 3 {
                return Ok((
                    list_type,
                    data.method_table,
                    field.data.offset as u64 + managed.runtime.target().pointer_size as u64,
                ));
            }
        }
    }
    Err("Live SNR ability array unavailable".into())
}
fn jumbo_layout(m: &Managed<'_>, s: &Source) -> Result<Value, String> {
    let ability = m
        .type_by_name(
            s.module.address,
            "SuperNewRoles.Roles.Modifiers.JumboAbility",
        )?
        .ok_or("Jumbo ability unavailable")?;
    let data = m
        .type_by_name(s.module.address, "SuperNewRoles.Roles.Modifiers.JumboData")?
        .ok_or("Jumbo data unavailable")?;
    if m.runtime.collectible(ability)?
        || m.runtime.collectible(data)?
        || m.field(ability, "_currentSize")?.data.element != 12
        || m.field(data, "MaxSize")?.data.element != 12
    {
        return Err("Unsupported Jumbo fields".into());
    }
    let (list, items, offset) = ability_list(m, s)?;
    Ok(
        json!({"abilityType":ability,"dataType":data,"listType":list,"itemsType":items,"abilitiesOffset":offset,
        "itemsOffset":m.offset(list,"_items")?,"countOffset":m.offset(list,"_size")?,"currentOffset":m.offset(ability,"_currentSize")?,"dataOffset":m.offset(ability,"Data")?,"maxOffset":m.offset(data,"MaxSize")?}),
    )
}
fn busker_layout(m: &Managed<'_>, s: &Source) -> Result<Value, String> {
    let ability = m
        .type_by_name(
            s.module.address,
            "SuperNewRoles.Roles.Ability.BuskerPseudocideAbility",
        )?
        .ok_or("Busker ability unavailable")?;
    if m.runtime.collectible(ability)? || m.field(ability, "isEffectActive")?.data.element != 2 {
        return Err("Unsupported Busker fields".into());
    }
    let (list, items, offset) = ability_list(m, s)?;
    Ok(
        json!({"abilityType":ability,"listType":list,"itemsType":items,"abilitiesOffset":offset,"itemsOffset":m.offset(list,"_items")?,"countOffset":m.offset(list,"_size")?,"activeOffset":m.offset(ability,"isEffectActive")?}),
    )
}
fn meeting_layout(m: &Managed<'_>, s: &Source) -> Result<Value, String> {
    let manager = m
        .type_by_name(
            s.module.address,
            "SuperNewRoles.Patches.MeetingPagingManager",
        )?
        .ok_or("Meeting manager unavailable")?;
    let areas_slot = m.static_named_slot(manager, "AllPlayerVoteAreas")?;
    let list = m.runtime.target().pointer(areas_slot)?;
    let list_type = m.object_type(list)?;
    let items = m.object_field(list, "_items")?;
    let (data, array) = m.array(items, 4096)?;
    let first = *array.first().ok_or("Empty meeting array")?;
    let vote = m.object_type(first)?;
    if m.runtime.type_name(vote)? != "PlayerVoteArea" {
        return Err("Unexpected vote area type".into());
    }
    let field = m
        .field(vote, "NativeFieldInfoPtr__PlayerId_k__BackingField")
        .or_else(|_| m.field(vote, "NativeFieldInfoPtr_TargetPlayerId"))?;
    let info = m.runtime.target().pointer(
        m.static_slot(&field)?
            .ok_or("Native FieldInfo uninitialized")?,
    )?;
    let ptr = m.runtime.target().pointer_size as u64;
    let name = m.c_string(m.runtime.target().pointer(info)?, 64)?;
    if name != "<PlayerId>k__BackingField" && name != "TargetPlayerId" {
        return Err("Native vote field name mismatch".into());
    }
    let native_class = m.runtime.target().pointer(info + 2 * ptr)?;
    let player_id_offset = m.number(info + 3 * ptr, 4, true)?;
    if player_id_offset < 2 * ptr as i64 || player_id_offset > 4096 {
        return Err("Invalid native vote ID offset".into());
    }
    Ok(
        json!({"enabledSlot":m.static_named_slot(manager,"IsPagingEnabled")?,"pageSlot":m.static_named_slot(manager,"CurrentPage")?,"areasSlot":areas_slot,
        "listType":list_type,"itemsType":data.method_table,"voteAreaType":vote,"nativeClass":native_class,
        "itemsOffset":m.offset(list_type,"_items")?,"countOffset":m.offset(list_type,"_size")?,"versionOffset":m.offset(list_type,"_version")?,
        "pooledPtrOffset":m.offset(vote,"pooledPtr")?,"playerIdOffset":player_id_offset}),
    )
}
type CosmeticRows = BTreeMap<(u64, u64), (Option<String>, Option<String>)>;
fn cosmetic_publication(m: &Managed<'_>, pid: u32) -> Result<(Value, CosmeticRows), String> {
    let mut modules = Vec::new();
    for module in m.modules()? {
        if !Managed::module_leaf(&module).eq_ignore_ascii_case("SuperNewRoles.dll") {
            continue;
        }
        let Some(owner) = m.type_by_name(
            module.address,
            "SuperNewRoles.CustomCosmetics.CosmeticsPlayer.CustomCosmeticsLayers",
        )?
        else {
            continue;
        };
        if m.static_object(&m.field(owner, "layers")?)?.is_some() {
            modules.push(module);
        }
    }
    if modules.len() != 1 {
        return Err("Unique initialized SNR cosmetic module required".into());
    }
    let rows = secondary_cosmetics(m, modules[0].address)?;
    let mut layouts = Vec::new();
    for module in m.modules()? {
        if !Managed::module_leaf(&module).eq_ignore_ascii_case("Assembly-CSharp.dll") {
            continue;
        }
        let Some(control) = m.type_by_name(module.address, "PlayerControl")? else {
            continue;
        };
        let Some(cosmetics) = m.type_by_name(module.address, "CosmeticsLayer")? else {
            continue;
        };
        let Ok((control_class, cosmetics_offset)) = native_field(m, control, "cosmetics") else {
            continue;
        };
        let Ok((id_class, player_id_offset)) = native_field(m, control, "PlayerId") else {
            continue;
        };
        let Ok((cosmetics_class, _)) = native_field(m, cosmetics, "bodyType") else {
            continue;
        };
        if control_class != id_class {
            continue;
        }
        let layout = (
            control_class,
            cosmetics_class,
            player_id_offset,
            cosmetics_offset,
        );
        if !layouts.contains(&layout) {
            layouts.push(layout);
        }
    }
    if layouts.len() != 1 {
        return Err("Unique initialized native SNR cosmetic layout required".into());
    }
    let (control_class, cosmetics_class, player_id_offset, cosmetics_offset) = layouts[0];
    let layers: Vec<_> = rows.iter().map(|(&(address, class), (hat, visor))|
        json!({"address":address,"class":class,"hat2Id":hat,"visor2Id":visor})).collect();
    Ok((
        json!({"pid":pid,"pointerSize":m.runtime.target().pointer_size,
        "controlClass":control_class,"cosmeticsClass":cosmetics_class,
        "playerIdOffset":player_id_offset,"cosmeticsOffset":cosmetics_offset,"layers":layers}),
        rows,
    ))
}
fn secondary_cosmetics(m: &Managed<'_>, module: u64) -> Result<CosmeticRows, String> {
    let mut result = BTreeMap::new();
    let Some(owner) = m.type_by_name(
        module,
        "SuperNewRoles.CustomCosmetics.CosmeticsPlayer.CustomCosmeticsLayers",
    )?
    else {
        return Ok(result);
    };
    let Some(dictionary) = m.static_object(&m.field(owner, "layers")?)? else {
        return Ok(result);
    };
    let entries = m.dictionary(dictionary, 4096)?;
    for &row in &entries.rows {
        let layer = m.entry_object(&entries, row, "value")?;
        if layer == 0 {
            continue;
        }
        let wrapper = m.object_field(layer, "cosmeticsLayer")?;
        if wrapper == 0 {
            continue;
        }
        let slot = wrapper + m.offset(m.object_type(wrapper)?, "pooledPtr")?;
        let native = m.runtime.target().pointer(slot)?;
        let class = m.runtime.target().pointer(native)?;
        let values = (
            secondary_product(m, layer, "hat2", true)?,
            secondary_product(m, layer, "visor2", false)?,
        );
        verify_native_wrapper(&|at| m.runtime.target().pointer(at), slot, native, class)?;
        if result.insert((native, class), values).is_some() {
            return Err("Duplicate native SNR cosmetics layer".into());
        }
    }
    m.verify_dictionary(&entries)?;
    Ok(result)
}
fn native_field(m: &Managed<'_>, ty: u64, name: &str) -> Result<(u64, u64), String> {
    let info = m
        .runtime
        .target()
        .pointer(m.static_named_slot(ty, &format!("NativeFieldInfoPtr_{name}"))?)?;
    let ps = m.runtime.target().pointer_size as u64;
    if m.c_string(m.runtime.target().pointer(info)?, 64)? != name {
        return Err("SNR native field identity mismatch".into());
    }
    let offset = m.number(info + 3 * ps, 4, true)?;
    if offset < 2 * ps as i64 || offset > 4096 {
        return Err("SNR native field offset out of range".into());
    }
    Ok((m.runtime.target().pointer(info + 2 * ps)?, offset as u64))
}
fn verify_native_wrapper(
    read: &impl Fn(u64) -> Result<u64, String>,
    slot: u64,
    native: u64,
    class: u64,
) -> Result<(), String> {
    if native < 0x10000 || class < 0x10000 || read(slot)? != native || read(native)? != class {
        return Err("SNR native wrapper changed".into());
    }
    Ok(())
}
fn read_native_cosmetics(
    read: &impl Fn(u64) -> Result<u64, String>,
    control_slot: u64,
    control_class: u64,
    offset: u64,
    cosmetics_class: u64,
) -> Result<(u64, u64), String> {
    let control = read(control_slot)?;
    verify_native_wrapper(read, control_slot, control, control_class)?;
    let cosmetics = read(control + offset)?;
    if cosmetics < 0x10000 || cosmetics_class < 0x10000 || read(cosmetics)? != cosmetics_class {
        return Err("SNR native cosmetics class mismatch".into());
    }
    verify_native_wrapper(read, control_slot, control, control_class)?;
    if read(control + offset)? != cosmetics || read(cosmetics)? != cosmetics_class {
        return Err("SNR native cosmetics changed".into());
    }
    Ok((cosmetics, cosmetics_class))
}
fn player_cosmetics(m: &Managed<'_>, player: u64) -> Result<(u64, u64), String> {
    let control = m.object_field(player, "Player")?;
    let ty = m.object_type(control)?;
    if m.runtime.type_name(ty)? != "PlayerControl" {
        return Err("SNR native PlayerControl required".into());
    }
    let cosmetics_ty = m
        .type_by_name(m.runtime.type_data(ty)?.module, "CosmeticsLayer")?
        .ok_or("SNR CosmeticsLayer type unavailable")?;
    let (control_class, offset) = native_field(m, ty, "cosmetics")?;
    let (cosmetics_class, _) = native_field(m, cosmetics_ty, "bodyType")?;
    read_native_cosmetics(
        &|at| m.runtime.target().pointer(at),
        control + m.offset(ty, "pooledPtr")?,
        control_class,
        offset,
        cosmetics_class,
    )
}
fn selected_outfit(rows: &[(i64, u64)], current: i64) -> Result<Option<u64>, String> {
    if !(0..=3).contains(&current) || rows.len() > 64 {
        return Err("Unsupported SNR outfit selection".into());
    }
    let mut selected = None;
    for &(key, object) in rows {
        if key == current && selected.replace(object).is_some() {
            return Err("Duplicate SNR outfit selection".into());
        }
    }
    Ok(selected.filter(|&object| object != 0))
}
fn secondary_product(
    m: &Managed<'_>,
    layer: u64,
    field: &str,
    hat: bool,
) -> Result<Option<String>, String> {
    let object = m.object_field(layer, field)?;
    if object == 0 {
        return Ok(None);
    }
    let (collection, current_field, legacy) = if hat {
        ("Hats", "CurrentHatType", "Hat")
    } else {
        ("Visors", "CurrentVisorType", "Visor")
    };
    let ty = m.object_type(object)?;
    if m.field(ty, collection).is_err() {
        return product_id(m, m.object_field(object, legacy)?, hat);
    }
    let current = m.number_field(object, current_field)?;
    let dictionary = m.object_field(object, collection)?;
    if dictionary == 0 {
        return Ok(None);
    }
    let entries = m.dictionary(dictionary, 64)?;
    let rows = if entries.rows.is_empty() {
        Vec::new()
    } else {
        let key =
            m.numeric_description(&m.field(entries.data.element_type_handle, "key")?, true)?;
        entries
            .rows
            .iter()
            .map(|&row| {
                Ok((
                    m.number(row + key.offset, key.size, key.signed)?,
                    m.entry_object(&entries, row, "value")?,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let id = match selected_outfit(&rows, current)? {
        Some(value) => product_id(m, value, hat)?,
        None => None,
    };
    m.verify_dictionary(&entries)?;
    if m.number_field(object, current_field)? != current
        || m.object_field(object, collection)? != dictionary
    {
        return Err("SNR active outfit changed".into());
    }
    Ok(id)
}
fn modded_product_id(package: &str, id: &str) -> Result<String, String> {
    let result = format!("Modded_{package}_{id}");
    if package.is_empty() || id.is_empty() || result.encode_utf16().count() > 1024 {
        return Err("Invalid SNR product ID".into());
    }
    Ok(result)
}
fn product_id(m: &Managed<'_>, object: u64, hat: bool) -> Result<Option<String>, String> {
    if object == 0 {
        return Ok(None);
    }
    let ty = m.object_type(object)?;
    if m.field(ty, "ProdId").is_ok() {
        return m.string_field(object, "ProdId", 1024);
    }
    let expected = if hat {
        "SuperNewRoles.CustomCosmetics.UI.ModdedHatDataWrapper"
    } else {
        "SuperNewRoles.CustomCosmetics.UI.ModdedVisorDataWrapper"
    };
    // The live getters expose custom wrappers only. Vanilla/empty outfits must
    // clear the second slot rather than revive the default outfit.
    if m.runtime.type_name(ty)? != expected {
        return Ok(None);
    }
    let data = m.object_field(object, "_data")?;
    let package = m.object_field(data, "package")?;
    let name = m
        .string_field(package, "name", 1024)?
        .ok_or("SNR package name unavailable")?;
    let id = m
        .string_field(data, if hat { "hat_id" } else { "visor_id" }, 1024)?
        .ok_or("SNR cosmetic ID unavailable")?;
    Ok(Some(modded_product_id(&name, &id)?))
}
#[cfg(test)]
mod cosmetic_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn native_cosmetics_bind_player_and_layer_by_native_address() {
        for offset in [0x14, 0x28] {
            let memory = BTreeMap::from([
                (0x10000, 0x20000),
                (0x20000, 0x30000),
                (0x20000 + offset, 0x40000),
                (0x40000, 0x50000),
                (0x60000, 0x40000),
            ]);
            let read = |at| memory.get(&at).copied().ok_or("Unmapped memory".into());
            let player = read_native_cosmetics(&read, 0x10000, 0x30000, offset, 0x50000).unwrap();
            verify_native_wrapper(&read, 0x60000, 0x40000, 0x50000).unwrap();
            let layers = BTreeMap::from([((read(0x60000).unwrap(), 0x50000), "second hat")]);
            assert_eq!(layers.get(&player), Some(&"second hat"));
            // A CLR wrapper's address is not the underlying IL2CPP address.
            assert!(!layers.contains_key(&(0x60000, 0x50000)));
            assert!(read_native_cosmetics(&read, 0x10000, 0x30001, offset, 0x50000).is_err());
            assert!(read_native_cosmetics(&read, 0x10000, 0x30000, offset, 0x50001).is_err());
            assert!(verify_native_wrapper(&read, 0x60000, 0x40001, 0x50000).is_err());
        }
    }
    #[test]
    fn native_cosmetics_reject_moved_control_and_changed_cosmetics() {
        for changed in [0x10000, 0x20020] {
            let reads = Cell::new(0);
            let read = |at| {
                if at == changed {
                    reads.set(reads.get() + 1);
                }
                match at {
                    0x10000 => Ok(if changed == at && reads.get() > 2 {
                        0x20001
                    } else {
                        0x20000
                    }),
                    0x20000 => Ok(0x30000),
                    0x20020 => Ok(if changed == at && reads.get() > 1 {
                        0x40001
                    } else {
                        0x40000
                    }),
                    0x40000 => Ok(0x50000),
                    _ => Err("Unmapped memory".into()),
                }
            };
            assert!(read_native_cosmetics(&read, 0x10000, 0x30000, 0x20, 0x50000).is_err());
        }
    }
    #[test]
    fn current_outfit_selects_both_secondary_slots_without_default_fallback() {
        let outfits = [(1, 0x10000), (2, 0), (3, 0x30000)];
        assert_eq!(selected_outfit(&outfits, 1).unwrap(), Some(0x10000));
        assert_eq!(selected_outfit(&outfits, 3).unwrap(), Some(0x30000));
        assert_eq!(selected_outfit(&outfits, 2).unwrap(), None);
        assert_eq!(selected_outfit(&outfits, 0).unwrap(), None);
        assert_eq!(selected_outfit(&[], 1).unwrap(), None);
        assert!(selected_outfit(&outfits, 4).is_err());
        assert!(selected_outfit(&[(1, 0x10000), (1, 0x20000)], 1).is_err());
    }
    #[test]
    fn computed_custom_product_ids_match_snr_and_enforce_utf16_limit() {
        assert_eq!(
            modded_product_id("Package", "hat").unwrap(),
            "Modded_Package_hat"
        );
        assert_eq!(
            modded_product_id("Package", "visor").unwrap(),
            "Modded_Package_visor"
        );
        assert!(modded_product_id("", "hat").is_err());
        assert!(modded_product_id("Package", "").is_err());
        assert!(modded_product_id(&"p".repeat(1015), "h").is_ok());
        assert!(modded_product_id(&"p".repeat(1016), "h").is_err());
        assert!(modded_product_id(&"😀".repeat(510), "h").is_err());
    }
}
#[derive(Default)]
pub struct PushState {
    completed: BTreeSet<u8>,
    previous: BTreeSet<u8>,
}
impl PushState {
    pub fn read(&mut self, managed: &Managed<'_>) -> Result<Vec<u8>, String> {
        let source = source(managed)?;
        let Some(animation) = managed.type_by_name(
            source.module.address,
            "SuperNewRoles.CustomObject.PushedPlayerDeadbody",
        )?
        else {
            return Ok(Vec::new());
        };
        let status = managed
            .field(source.player_type, "FinalStatus")
            .or_else(|_| managed.field(source.player_type, "_finalStatus"))?;
        let mut by_address = BTreeMap::new();
        for (id, &player) in source.players.iter().enumerate() {
            if player == 0 {
                self.completed.remove(&(id as u8));
                self.previous.remove(&(id as u8));
                continue;
            }
            if managed.object_type(player)? != source.player_type {
                return Err("SNR player type mismatch".into());
            }
            let status = managed.optional_enum(player, &status)?;
            let pushed = status.is_some_and(|(value, names)| {
                names.get(&value).is_some_and(|n| n == "Push")
                    && names.values().filter(|&n| n == "Push").count() == 1
            });
            if !pushed {
                self.completed.remove(&(id as u8));
                self.previous.remove(&(id as u8));
                continue;
            }
            if managed.number_field(player, "PlayerId")? != id as i64 {
                return Err("SNR push player ID mismatch".into());
            }
            let native = managed.object_field(player, "Player")?;
            if native != 0 && !self.completed.contains(&(id as u8)) {
                by_address.insert(native, id as u8);
            }
        }
        if by_address.is_empty() {
            return Ok(Vec::new());
        }
        let mut found = BTreeSet::new();
        for handle in managed.runtime.handles()? {
            if handle.strong == 0 || handle.handle == 0 {
                continue;
            }
            let object = managed.runtime.target().pointer(handle.handle)?;
            if object == 0 || managed.object_type(object)? != animation {
                continue;
            }
            let player = managed.object_field(object, "Player")?;
            let Some(&id) = by_address.get(&player) else {
                continue;
            };
            let stage = managed.number_field(object, "pushAnimation")?;
            let timer = managed.float_field(object, "AnimationTimer")?;
            if !(0..=2).contains(&stage) || timer < 0.0 {
                continue;
            }
            if managed.object_field(object, "Player")? == player {
                found.insert(id);
            }
        }
        if managed.runtime.target().pointer(source.slot)? != source.array {
            return Err("SNR source changed during push sample".into());
        }
        for id in &self.previous {
            if !found.contains(id) {
                self.completed.insert(*id);
            }
        }
        self.previous = found.clone();
        Ok(found.into_iter().collect())
    }
}
pub fn watch(
    runtime: &crate::runtime::Runtime,
    pid: u32,
    parent: Option<u32>,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    struct Parent(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for Parent {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let parent = match parent {
        Some(pid) => {
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return Err("Parent process unavailable".into());
            }
            Some(Parent(handle))
        }
        None => None,
    };
    let mut state = PushState::default();
    while runtime.target().alive()
        && parent
            .as_ref()
            .is_none_or(|p| unsafe { WaitForSingleObject(p.0, 0) == WAIT_TIMEOUT })
    {
        let start = Instant::now();
        // Object addresses are never cached across a GC/scene sample.
        let sample = runtime
            .flush()
            .and_then(|_| state.read(&Managed::new(runtime)));
        let (available, ids) = match sample {
            Ok(ids) => (true, ids),
            Err(_) => (false, Vec::new()),
        };
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "System clock before epoch")?
            .as_millis() as u64;
        writeln!(
            io::stdout().lock(),
            "{}",
            json!({"pid":pid,"available":available,"playerIds":ids,"capturedAt":stamp})
        )
        .map_err(|e| e.to_string())?;
        io::stdout().flush().map_err(|e| e.to_string())?;
        std::thread::sleep(
            Duration::from_millis(100)
                .saturating_sub(start.elapsed())
                .max(Duration::from_millis(1)),
        );
    }
    Ok(())
}
