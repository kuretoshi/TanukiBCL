using Microsoft.Diagnostics.Runtime;
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

// Inspect a snapshot, never write to or execute code in the game process.
var diagnostics = new List<object>();
try
{
    int pid = int.Parse(args[0]);
    using var process = Process.GetProcessById(pid);
    if (process.ProcessName != "Among Us") throw new InvalidOperationException("Among Us process required");
    long started = process.StartTime.ToUniversalTime().Ticks;
    using var target = DataTarget.CreateSnapshotAndAttach(pid);
    var info = target.ClrVersions.FirstOrDefault() ?? throw new InvalidOperationException("CoreCLR not found");
    using var runtime = info.CreateRuntime();
    if (args.Length > 1 && args[1] == "--toh") {
        var layout = TohRoleLayout.Resolve(runtime, pid, target.DataReader.PointerSize, ReadEnums);
        using var liveProcess = Process.GetProcessById(pid);
        if (liveProcess.StartTime.ToUniversalTime().Ticks != started) throw new InvalidOperationException("Process changed");
        Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, layout }));
        return;
    }
    var source = SnrPlayerSource.Resolve(runtime, diagnostics);
    var module = source.Module;
    var array = source.Array.AsArray();
    // Decode names using the DLL belonging to the selected live module.
    if (string.IsNullOrEmpty(module.Name) || !File.Exists(module.Name))
        throw new InvalidOperationException("Selected SuperNewRoles module has no readable metadata file");
    string snrPath = module.Name;
    var enums = ReadEnums(snrPath);
    var liveLayout = BuildLiveLayout(pid, source, target.DataReader.PointerSize, enums);
    var rows = new List<object>();
    for (int i = 0; i < array.Length; i++)
    {
        var player = array.GetObjectValue(i);
        if (player.IsNull) continue;
        if (player.Type?.MethodTable != source.PlayerType.MethodTable)
            throw new InvalidOperationException("Player type does not belong to the selected SNR module");
        var playerId = ReadNumber(player, "PlayerId");
        if (playerId != i) throw new InvalidOperationException("Player ID mismatch");
        var roleBase = ReadObject(player, "roleBase");
        var abilities = ReadList(player, "_playerAbilities");
        var assignedTeam = Describe(roleBase, "AssignedTeam", enums);
        rows.Add(new {
            playerId, role = Describe(player, "Role", enums), modifier = Describe(player, "ModifierRole", enums),
            ghostRole = Describe(player, "GhostRole", enums), roleClass = roleBase.Type?.Name,
            assignedTeam, isNeutral = DescribeName(roleBase, "AssignedTeam", enums) == "Neutral", canKill = ResolveCanKill(abilities),
            winnerTeam = Describe(roleBase, "WinnerTeam", enums),
            teamTag = Describe(roleBase, "TeamTag", enums),
            abilities = abilities.Select(a => new { name = a.Type?.Name, currentTeam = Describe(a, "CurrentTeam", enums) }).ToArray()
        });
    }
    using var current = Process.GetProcessById(pid);
    if (current.StartTime.ToUniversalTime().Ticks != started) throw new InvalidOperationException("Process changed");
    Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, capturedAt = DateTimeOffset.UtcNow.ToString("O"),
        version = FileVersionInfo.GetVersionInfo(snrPath).FileVersion, diagnostics, liveLayout, players = rows }));
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { status = "error", message = error.Message, diagnostics }));
    Environment.ExitCode = 1;
}

static object? BuildLiveLayout(int pid, SnrPlayerSource source, int pointerSize, Dictionary<string, Dictionary<long,string>> enums)
{
    // The native live reader currently supports the x86 CoreCLR used by SNR.
    if (pointerSize != 4 || source.PlayerType.IsCollectible) return null;
    object? DescribeField(string name)
    {
        var field = source.PlayerType.Fields.FirstOrDefault(f => f.Name == name || f.Name == $"<{name}>k__BackingField");
        if (field == null) return null;
        var element = field.Type?.IsEnum == true ? field.Type.GetFieldByName("value__")?.ElementType : field.ElementType;
        var (size, signed) = element switch {
            ClrElementType.UInt8 => (1, false), ClrElementType.Int8 => (1, true),
            ClrElementType.UInt16 => (2, false), ClrElementType.Int16 => (2, true),
            ClrElementType.UInt32 => (4, false), ClrElementType.Int32 => (4, true),
            _ => (0, false)
        };
        if (size == 0) return null;
        enums.TryGetValue(field.Type?.Name ?? "", out var names);
        return new { offset = field.GetAddress(0x1000, false) - 0x1000, size, signed, names };
    }
    return new {
        pid, pointerSize,
        arraySlot = source.PlayerType.GetStaticFieldByName("_exPlayerControlsArray")!.GetAddress(source.Module.AppDomain),
        arrayType = source.Array.Type!.MethodTable, playerType = source.PlayerType.MethodTable,
        arrayLengthOffset = pointerSize,
        arrayDataOffset = source.Array.Type.GetArrayElementAddress(source.Array.Address, 0) - source.Array.Address,
        jumbo = BuildJumboLayout(source),
        fields = new { playerId = DescribeField("PlayerId"), role = DescribeField("Role"),
            modifier = DescribeField("ModifierRole"), ghostRole = DescribeField("GhostRole") }
    };
}

static object? BuildJumboLayout(SnrPlayerSource source)
{
    var ability = source.Module.GetTypeByName("SuperNewRoles.Roles.Modifiers.JumboAbility");
    var data = source.Module.GetTypeByName("SuperNewRoles.Roles.Modifiers.JumboData");
    var abilities = source.PlayerType.GetFieldByName("_playerAbilities");
    var list = abilities?.Type;
    var items = list?.GetFieldByName("_items");
    var size = list?.GetFieldByName("_size");
    var current = ability?.GetFieldByName("<_currentSize>k__BackingField");
    var dataField = ability?.GetFieldByName("<Data>k__BackingField");
    var max = data?.GetFieldByName("<MaxSize>k__BackingField");
    // Array field metadata can have MethodTable=0; use a live list's actual array type.
    ulong itemsType = 0;
    var players = source.Array.AsArray();
    for (int i = 0; i < players.Length && itemsType == 0; i++) {
        var player = players.GetObjectValue(i);
        if (player.IsNull) continue;
        var liveItems = ReadObject(ReadObject(player, "_playerAbilities"), "_items");
        if (!liveItems.IsNull && liveItems.IsArray) itemsType = liveItems.Type!.MethodTable;
    }
    if (ability == null || data == null || abilities == null || list == null || items?.Type == null || size == null ||
        current?.ElementType != ClrElementType.Float || dataField == null || max?.ElementType != ClrElementType.Float ||
        ability.IsCollectible || data.IsCollectible || itemsType == 0) return null;
    ulong Offset(ClrInstanceField field) => field.GetAddress(0x1000, false) - 0x1000;
    return new {
        abilityType = ability.MethodTable, dataType = data.MethodTable, listType = list.MethodTable,
        itemsType,
        abilitiesOffset = Offset(abilities), itemsOffset = Offset(items), countOffset = Offset(size),
        currentOffset = Offset(current), dataOffset = Offset(dataField), maxOffset = Offset(max)
    };
}

static ClrInstanceField? Field(ClrObject obj, string name) => obj.Type?.Fields.FirstOrDefault(f => f.Name == name || f.Name == $"<{name}>k__BackingField");
static ClrObject ReadObject(ClrObject obj, string name) => Field(obj, name)?.ReadObject(obj.Address, false) ?? default;
static long? ReadNumber(ClrObject obj, string name)
{
    var field = Field(obj, name);
    if (field == null) return null;
    var element = field.Type?.IsEnum == true ? field.Type.GetFieldByName("value__")?.ElementType : field.ElementType;
    return element switch {
        ClrElementType.Int8 => field.Read<sbyte>(obj.Address, false),
        ClrElementType.UInt8 => field.Read<byte>(obj.Address, false),
        ClrElementType.Int16 => field.Read<short>(obj.Address, false),
        ClrElementType.UInt16 => field.Read<ushort>(obj.Address, false),
        ClrElementType.Int32 => field.Read<int>(obj.Address, false),
        ClrElementType.UInt32 => field.Read<uint>(obj.Address, false),
        ClrElementType.Int64 => field.Read<long>(obj.Address, false),
        _ => null
    };
}
static object? Describe(ClrObject obj, string name, Dictionary<string, Dictionary<long,string>> enums)
{
    var value = ReadNumber(obj, name);
    if (value == null) return null;
    var enumType = Field(obj, name)?.Type?.Name ?? "";
    string? label = null;
    if (enums.TryGetValue(enumType, out var names)) {
        names.TryGetValue(value.Value, out label);
        if (label == null && name == "ModifierRole") label = string.Join(" | ", names.Where(n => n.Key > 0 && (n.Key & (n.Key - 1)) == 0 && (value.Value & n.Key) == n.Key).Select(n => n.Value));
    }
    return new { value, name = label };
}
static string? DescribeName(ClrObject obj, string name, Dictionary<string, Dictionary<long,string>> enums)
{
    var field = Field(obj, name);
    var value = ReadNumber(obj, name);
    if (field == null || value == null) return null;
    return enums.TryGetValue(field.Type?.Name ?? "", out var names) && names.TryGetValue(value.Value, out var label)
        ? label
        : null;
}
static bool ResolveCanKill(List<ClrObject> abilities)
{
    foreach (var ability in abilities)
    {
        var decision = ReadNumber(ability, "CanKill") ?? ReadNumber(ability, "<CanKill>k__BackingField");
        if (decision != null) return decision.Value != 0;
    }
    return true;
}
static List<ClrObject> ReadList(ClrObject owner, string name)
{
    var list = ReadObject(owner, name);
    if (list.IsNull) return new();
    int size = (int)(ReadNumber(list, "_size") ?? 0);
    var items = ReadObject(list, "_items");
    if (items.IsNull || !items.IsArray) return new();
    var array = items.AsArray();
    if (size < 0 || size > array.Length || size > 512) throw new InvalidOperationException("Invalid ability list");
    var result = new List<ClrObject>();
    for (int i = 0; i < size; i++) { var item = array.GetObjectValue(i); if (!item.IsNull) result.Add(item); }
    return result;
}
static Dictionary<string, Dictionary<long,string>> ReadEnums(string dll)
{
    using var stream = File.OpenRead(dll);
    using var pe = new PEReader(stream);
    var metadata = pe.GetMetadataReader();
    var result = new Dictionary<string, Dictionary<long,string>>();
    foreach (var handle in metadata.TypeDefinitions) {
        var type = metadata.GetTypeDefinition(handle);
        var values = new Dictionary<long,string>();
        foreach (var fieldHandle in type.GetFields()) {
            var field = metadata.GetFieldDefinition(fieldHandle);
            var constantHandle = field.GetDefaultValue();
            if (constantHandle.IsNil) continue;
            var constant = metadata.GetConstant(constantHandle);
            var blob = metadata.GetBlobReader(constant.Value);
            long? value = constant.TypeCode switch {
                ConstantTypeCode.Byte => blob.ReadByte(), ConstantTypeCode.SByte => blob.ReadSByte(),
                ConstantTypeCode.Int16 => blob.ReadInt16(), ConstantTypeCode.UInt16 => blob.ReadUInt16(),
                ConstantTypeCode.Int32 => blob.ReadInt32(), ConstantTypeCode.UInt32 => blob.ReadUInt32(),
                ConstantTypeCode.Int64 => blob.ReadInt64(), _ => null
            };
            if (value != null) values[value.Value] = metadata.GetString(field.Name);
        }
        if (values.Count > 0) result[metadata.GetString(type.Namespace) + "." + metadata.GetString(type.Name)] = values;
    }
    return result;
}
