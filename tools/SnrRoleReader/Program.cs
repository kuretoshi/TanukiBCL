using Microsoft.Diagnostics.Runtime;
using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

// Inspect a snapshot, never write to or execute code in the game process.
try
{
    int pid = int.Parse(args[0]);
    using var process = Process.GetProcessById(pid);
    if (process.ProcessName != "Among Us") throw new InvalidOperationException("Among Us process required");
    long started = process.StartTime.ToUniversalTime().Ticks;
    string snrPath = process.Modules.Cast<ProcessModule>().First(m => string.Equals(m.ModuleName, "SuperNewRoles.dll", StringComparison.OrdinalIgnoreCase)).FileName;
    using var target = DataTarget.CreateSnapshotAndAttach(pid);
    var info = target.ClrVersions.FirstOrDefault() ?? throw new InvalidOperationException("CoreCLR not found");
    using var runtime = info.CreateRuntime();
    var module = runtime.EnumerateModules().FirstOrDefault(m => string.Equals(Path.GetFileName(m.Name), "SuperNewRoles.dll", StringComparison.OrdinalIgnoreCase))
        ?? throw new InvalidOperationException("SuperNewRoles managed module not found");
    var enums = ReadEnums(snrPath);
    var type = module.GetTypeByName("SuperNewRoles.Modules.ExPlayerControl") ?? throw new InvalidOperationException("ExPlayerControl type not found");
    var field = type.GetStaticFieldByName("_exPlayerControlsArray") ?? throw new InvalidOperationException("Player array field not found");
    var arrayObject = field.ReadObject(module.AppDomain);
    if (arrayObject.IsNull || !arrayObject.IsArray) throw new InvalidOperationException("Player array is not initialized");
    var array = arrayObject.AsArray();
    if (array.Length > 256) throw new InvalidOperationException("Unexpected player array length");
    var rows = new List<object>();
    for (int i = 0; i < array.Length; i++)
    {
        var player = array.GetObjectValue(i);
        if (player.IsNull) continue;
        var playerId = ReadNumber(player, "PlayerId");
        if (playerId != i) throw new InvalidOperationException("Player ID mismatch");
        var roleBase = ReadObject(player, "roleBase");
        var abilities = ReadList(player, "_playerAbilities");
        rows.Add(new {
            playerId, role = Describe(player, "Role", enums), modifier = Describe(player, "ModifierRole", enums),
            ghostRole = Describe(player, "GhostRole", enums), roleClass = roleBase.Type?.Name,
            assignedTeam = Describe(roleBase, "AssignedTeam", enums), winnerTeam = Describe(roleBase, "WinnerTeam", enums),
            teamTag = Describe(roleBase, "TeamTag", enums),
            abilities = abilities.Select(a => new { name = a.Type?.Name, currentTeam = Describe(a, "CurrentTeam", enums) }).ToArray()
        });
    }
    using var current = Process.GetProcessById(pid);
    if (current.StartTime.ToUniversalTime().Ticks != started) throw new InvalidOperationException("Process changed");
    Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, capturedAt = DateTimeOffset.UtcNow.ToString("O"),
        version = FileVersionInfo.GetVersionInfo(snrPath).FileVersion, players = rows }));
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { status = "error", message = error.Message }));
    Environment.ExitCode = 1;
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
