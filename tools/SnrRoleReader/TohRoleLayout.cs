using Microsoft.Diagnostics.Runtime;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

internal static class TohRoleLayout
{
    private static bool IsTohModule(string? path)
    {
        var name = Path.GetFileNameWithoutExtension(path) ?? "";
        var normalized = name.Replace("_", "").Replace("-", "");
        return normalized.StartsWith("TownOfHostForE", StringComparison.OrdinalIgnoreCase);
    }

    public static object Resolve(ClrRuntime runtime, int pid, int pointerSize,
        Func<string, Dictionary<string, Dictionary<long,string>>> readEnums)
    {
        if (pointerSize != 4) throw new InvalidOperationException("TOH4E reader currently supports x86 only");
        var sources = runtime.EnumerateModules()
            // Official TOH4E uses TownOfHost_ForE.dll. TOH4E_EM v6180.383 copies the
            // same assembly to TownOfHostForE_EM.dll and removes the original file.
            .Where(m => IsTohModule(m.Name))
            .Select(m => (module: m, type: m.GetTypeByName("TownOfHostForE.PlayerState")))
            .Where(s => s.type != null && !s.type.IsCollectible)
            .Select(s => (s.module, type: s.type!, slot: s.type!.GetStaticFieldByName("allPlayerStates")))
            .Where(s => s.slot != null && s.slot.GetAddress(s.module.AppDomain) != 0)
            .Select(s => (s.module, s.type, slot: s.slot!, dictionary: s.slot!.ReadObject(s.module.AppDomain)))
            .Where(s => !s.dictionary.IsNull).ToArray();
        if (sources.Length != 1) throw new InvalidOperationException($"TOH4E PlayerState dictionary: expected one initialized source, found {sources.Length}. MOD未導入または未初期化の可能性があります。");
        var source = sources[0];
        ClrInstanceField Field(ClrType type, string name) => type.GetFieldByName(name)
            ?? throw new InvalidOperationException($"Missing TOH4E field {type.Name}.{name}");
        ulong Offset(ClrInstanceField field) => field.GetAddress(0x1000, false) - 0x1000;
        var dictType = source.dictionary.Type!;
        var entriesField = Field(dictType, "_entries");
        var entries = entriesField.ReadObject(source.dictionary.Address, false);
        if (!entries.IsArray) throw new InvalidOperationException("TOH4E役職配列が未初期化です。ロビーまたは試合に入ってください。");
        var entryType = entries.Type!.ComponentType!;
        var role = Field(source.type, "MainRole");
        if (role.Type?.GetFieldByName("value__")?.ElementType != ClrElementType.Int32)
            throw new InvalidOperationException("Unsupported TOH4E role enum");
        var enums = readEnums(source.module.Name!);
        if (!enums.TryGetValue(role.Type.Name!, out var names)) throw new InvalidOperationException("TOH4E role names unavailable");
        var opportunist = source.module.GetTypeByName("TownOfHostForE.Roles.Neutral.Opportunist");
        var canKill = opportunist?.GetStaticFieldByName("CanKill");
        // Read interface inheritance from the actual loaded DLL, without executing MOD code.
        var killerRoles = ReadKillerRoles(source.module.Name!);
        var manager = source.module.GetTypeByName("TownOfHostForE.Roles.Core.CustomRoleManager");
        var activeSlot = manager?.GetStaticFieldByName("AllActiveRoles");
        object? killerLayout = null;
        if (activeSlot != null && activeSlot.GetAddress(source.module.AppDomain) != 0)
        {
            var active = activeSlot.ReadObject(source.module.AppDomain);
            if (!active.IsNull)
            {
                var activeEntriesField = Field(active.Type!, "_entries");
                var activeEntries = activeEntriesField.ReadObject(active.Address, false);
                if (activeEntries.IsArray)
                {
                    var activeEntryType = activeEntries.Type!.ComponentType!;
                    var types = new Dictionary<ulong, object>();
                    foreach (var (name, isKiller) in killerRoles)
                    {
                        var type = source.module.GetTypeByName(name);
                        if (type == null || type.MethodTable == 0) continue;
                        types[type.MethodTable] = new { isKiller, stateOffset = Offset(Field(type, "MyState")) };
                    }
                    killerLayout = new {
                        dictionarySlot = activeSlot.GetAddress(source.module.AppDomain),
                        dictionaryType = active.Type!.MethodTable, entriesType = activeEntries.Type.MethodTable,
                        entriesOffset = Offset(activeEntriesField), countOffset = Offset(Field(active.Type, "_count")),
                        versionOffset = Offset(Field(active.Type, "_version")),
                        dataOffset = activeEntries.Type.GetArrayElementAddress(activeEntries.Address, 0) - activeEntries.Address,
                        stride = activeEntries.Type.ComponentSize,
                        nextOffset = Field(activeEntryType, "next").Offset, keyOffset = Field(activeEntryType, "key").Offset,
                        valueOffset = Field(activeEntryType, "value").Offset, types
                    };
                }
            }
        }
        return new {
            pid, pointerSize, dictionarySlot = source.slot.GetAddress(source.module.AppDomain),
            dictionaryType = dictType.MethodTable, playerType = source.type.MethodTable,
            entriesType = entries.Type.MethodTable,
            entriesOffset = Offset(entriesField), countOffset = Offset(Field(dictType, "_count")),
            versionOffset = Offset(Field(dictType, "_version")),
            dataOffset = entries.Type.GetArrayElementAddress(entries.Address, 0) - entries.Address,
            stride = entries.Type.ComponentSize,
            nextOffset = Field(entryType, "next").Offset, keyOffset = Field(entryType, "key").Offset,
            valueOffset = Field(entryType, "value").Offset,
            idOffset = Offset(Field(source.type, "PlayerId")), roleOffset = Offset(role), names, killerLayout,
            opportunistCanKillSlot = canKill?.ElementType == ClrElementType.Boolean
                ? canKill.GetAddress(source.module.AppDomain) : 0
        };
    }

    private static Dictionary<string, bool> ReadKillerRoles(string path)
    {
        using var stream = File.OpenRead(path);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        string FullName(TypeDefinition type) => metadata.GetString(type.Namespace) + "." + metadata.GetString(type.Name);
        bool Inherits(EntityHandle handle, string target, HashSet<EntityHandle> visited)
        {
            if (handle.IsNil || !visited.Add(handle) || handle.Kind != HandleKind.TypeDefinition) return false;
            var type = metadata.GetTypeDefinition((TypeDefinitionHandle)handle);
            if (FullName(type) == target) return true;
            return Inherits(type.BaseType, target, visited) || type.GetInterfaceImplementations().Any(
                implementation => Inherits(metadata.GetInterfaceImplementation(implementation).Interface, target, visited));
        }
        var result = new Dictionary<string, bool>();
        foreach (var handle in metadata.TypeDefinitions)
        {
            var type = metadata.GetTypeDefinition(handle);
            if (!Inherits(handle, "TownOfHostForE.Roles.Core.RoleBase", new())) continue;
            var name = FullName(type);
            var killer = Inherits(handle, "TownOfHostForE.Roles.Core.Interfaces.IKiller", new());
            if (result.TryGetValue(name, out var previous) && previous != killer)
                throw new InvalidOperationException($"Ambiguous TOH4E role class: {name}");
            result[name] = killer;
        }
        return result;
    }
}
