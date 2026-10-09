using Microsoft.Diagnostics.Runtime;
using System.Diagnostics;

internal static class NosRoles
{
    internal record Role(int? RoleId, string? RoleName, string? DisplayName, string RuntimeClass, bool? IsRainbowStar = null);
    internal record PlayerRole(byte PlayerId, Role Role, NosBody.Layout? BodyLayout);

    // Read managed fields from a process snapshot; never invoke MOD getters or methods.
    internal static PlayerRole[] Read(int pid)
    {
        using var process = Process.GetProcessById(pid);
        if (process.ProcessName != "Among Us") throw new InvalidOperationException("Among Us process required");
        long started = process.StartTime.ToUniversalTime().Ticks;
        using var target = DataTarget.CreateSnapshotAndAttach(pid);
        using var runtime = (target.ClrVersions.FirstOrDefault()
            ?? throw new InvalidOperationException("CoreCLR not found")).CreateRuntime();
        var module = runtime.EnumerateModules().Single(m =>
            string.Equals(Path.GetFileName(m.Name), "Nebula.dll", StringComparison.OrdinalIgnoreCase));
        var managerType = module.GetTypeByName("Nebula.Game.NebulaGameManager")
            ?? throw new InvalidOperationException("NoS player manager unavailable");
        var manager = managerType.GetStaticFieldByName("instance")!.ReadObject(module.AppDomain);
        var result = new List<PlayerRole>();
        if (!manager.IsNull)
        {
            var dictionary = manager.ReadObjectField("allModPlayers");
            var entries = dictionary.ReadObjectField("_entries");
            int count = dictionary.ReadField<int>("_count");
            if (count < 0 || count > 64 || (count > 0 && (!entries.IsArray || count > entries.AsArray().Length)))
                throw new InvalidOperationException("Invalid NoS player registry");
            var translations = Translations(module);
            var ids = new HashSet<byte>();
            for (int i = 0; i < count; i++)
            {
                var entry = entries.AsArray().GetStructValue(i);
                if (entry.ReadField<int>("next") < -1) continue;
                byte id = entry.ReadField<byte>("key");
                var player = entry.ReadObjectField("value");
                if (player.IsNull || player.Type?.Name != "Nebula.Player.PlayerModInfo" ||
                    player.ReadField<byte>("<PlayerId>k__BackingField") != id || !ids.Add(id))
                    throw new InvalidOperationException("Invalid NoS player identity");
                var role = player.ReadObjectField("myRole");
                if (role.IsNull) continue;
                var definition = Definition(role);
                string? name = definition.IsNull ? null : definition.ReadStringField("<LocalizedName>k__BackingField", 256);
                int? roleId = definition.IsNull ? null : definition.ReadField<int>("<Virial.Assignable.IRoleID.Id>k__BackingField");
                translations.TryGetValue($"role.{name}.name", out var label);
                result.Add(new PlayerRole(id, new Role(roleId, name, label, role.Type!.Name!, ReadRainbowStar(runtime, player)),
                    name == "berserker" ? NosBody.Resolve(target, player, id) : null));
            }
        }
        using var current = Process.GetProcessById(pid);
        if (current.StartTime.ToUniversalTime().Ticks != started) throw new InvalidOperationException("NoS process changed");
        return result.ToArray();
    }

    private static bool? ReadRainbowStar(ClrRuntime runtime, ClrObject player)
    {
        // Optional addon state must fail closed without losing the main role.
        try
        {
            var list = player.ReadObjectField("myModifiers");
            int count = list.ReadField<int>("_size");
            var items = list.ReadObjectField("_items");
            if (count < 0 || count > 64 || !items.IsArray || count > items.AsArray().Length) return null;
            for (int i = 0; i < count; i++)
            {
                var modifier = items.AsArray().GetObjectValue(i);
                if (modifier.Type?.Name != "Hori.Scripts.Role.Modifier.StarU+Instance") continue;
                var type = modifier.Type.Module.GetTypeByName("Hori.Scripts.Role.Modifier.StarU");
                var field = type?.GetStaticFieldByName("RainbowStar");
                if (field?.IsObjectReference != true) return null;
                var config = field.ReadObject(modifier.Type.Module.AppDomain);
                var value = config.ReadObjectField("val");
                if (value.Type?.Name != "Nebula.Configuration.BoolConfigurationValue") return null;
                return value.ReadField<bool>("currentValue");
            }
            return false;
        }
        catch { return null; }
    }

    private static ClrObject Definition(ClrObject role)
    {
        foreach (string name in new[] { "role", "<Role>k__BackingField" })
        {
            var field = role.Type!.GetFieldByName(name);
            if (field?.IsObjectReference != true) continue;
            var value = role.ReadObjectField(name);
            if (!value.IsNull && value.Type!.GetFieldByName("<LocalizedName>k__BackingField") != null) return value;
        }
        // Custom Instance implementations return the enclosing role's static MyRole.
        string typeName = role.Type!.Name!;
        int nested = typeName.LastIndexOf('+');
        if (nested > 0)
        {
            var module = role.Type.Module;
            var parent = module.GetTypeByName(typeName[..nested]);
            var field = parent?.GetStaticFieldByName("MyRole");
            if (field?.IsObjectReference == true) return field.ReadObject(module.AppDomain);
        }
        return default;
    }

    private static Dictionary<string, string> Translations(ClrModule module)
    {
        var result = new Dictionary<string, string>();
        var type = module.GetTypeByName("Nebula.Modules.Language")!;
        foreach (string name in new[] { "DefaultLanguage", "CurrentLanguage", "GuestLanguage" })
        {
            var field = type.GetStaticFieldByName(name);
            if (field == null) continue;
            var language = field.ReadObject(module.AppDomain);
            if (language.IsNull) continue;
            var dictionary = language.ReadObjectField("translationMap");
            var entries = dictionary.ReadObjectField("_entries");
            int count = dictionary.ReadField<int>("_count");
            if (count < 0 || count > 100000 || (count > 0 && (!entries.IsArray || count > entries.AsArray().Length)))
                throw new InvalidOperationException("Invalid NoS translations");
            for (int i = 0; i < count; i++)
            {
                var entry = entries.AsArray().GetStructValue(i);
                if (entry.ReadField<int>("next") < -1) continue;
                string? key = entry.ReadObjectField("key").AsString(512);
                if (key == null || !key.StartsWith("role.") || !key.EndsWith(".name")) continue;
                string? value = entry.ReadObjectField("value").AsString(512);
                if (value != null) result[key] = value;
            }
        }
        return result;
    }
}
