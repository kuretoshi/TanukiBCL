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
    let source = source(managed)?;
    let descriptor = |name: &str| {
        managed
            .field(source.player_type, name)
            .and_then(|f| managed.numeric_description(&f, false))
            .ok()
    };
    let mut players = Vec::new();
    let cosmetics = secondary_cosmetics(managed, &source).unwrap_or_default();
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
        let layer = managed
            .object_field(player, "Player")
            .and_then(|p| managed.object_field(p, "cosmetics"))
            .unwrap_or(0);
        let secondary = cosmetics.get(&layer);
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
        json!({"status":"ok","pid":pid,"players":players,"diagnostics":{"jumbo":jumbo.as_ref().err(),"busker":busker.as_ref().err(),"meeting":meeting.as_ref().err()},"liveLayout":{
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
fn secondary_cosmetics(
    m: &Managed<'_>,
    s: &Source,
) -> Result<BTreeMap<u64, (Option<String>, Option<String>)>, String> {
    let mut result = BTreeMap::new();
    let Some(owner) = m.type_by_name(
        s.module.address,
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
        let cosmetics = m.object_field(layer, "cosmeticsLayer")?;
        if cosmetics == 0 {
            continue;
        }
        let product = |field: &str, kind: &str| -> Option<String> {
            let object = m.object_field(layer, field).ok()?;
            let object = m.object_field(object, kind).ok()?;
            m.string_field(object, "ProdId", 1024).ok().flatten()
        };
        result.insert(
            cosmetics,
            (product("hat2", "Hat"), product("visor2", "Visor")),
        );
    }
    m.verify_dictionary(&entries)?;
    Ok(result)
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
