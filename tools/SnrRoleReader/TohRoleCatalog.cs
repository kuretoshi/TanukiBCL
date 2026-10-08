using Microsoft.Diagnostics.Runtime;

internal static class TohRoleCatalog
{
    internal record Entry(int roleId, string roleName, string displayName, string customRoleType, bool? isKiller);

    // Read the loaded DLL's initialized RoleInfo objects. Never invoke MOD methods/getters.
    public static Entry[] Read(ClrModule module, Dictionary<long, string> names,
        Dictionary<long, string> teams, Dictionary<string, bool> killerClasses)
    {
        var manager = module.GetTypeByName("TownOfHostForE.Roles.Core.CustomRoleManager");
        var slot = manager?.GetStaticFieldByName("AllRolesInfo");
        if (slot == null || slot.GetAddress(module.AppDomain) == 0) return [];
        var dictionary = slot.ReadObject(module.AppDomain);
        if (dictionary.IsNull) return [];
        var entries = dictionary.ReadObjectField("_entries");
        if (!entries.IsArray) return [];
        var count = dictionary.ReadField<int>("_count");
        var version = dictionary.ReadField<int>("_version");
        var array = entries.AsArray();
        if (count < 0 || count > 1024 || count > array.Length) throw new InvalidOperationException("Invalid TOH4E RoleInfo registry");
        var killers = ReadClassInfos(module, killerClasses);
        var result = new Dictionary<int, Entry>();
        for (var i = 0; i < count; i++)
        {
            var item = array.GetStructValue(i);
            if (item.ReadField<int>("next") < -1) continue;
            var id = item.ReadField<int>("key");
            var info = item.ReadObjectField("value");
            if (info.IsNull || info.Type?.Name != "TownOfHostForE.Roles.Core.SimpleRoleInfo") continue;
            if (info.ReadField<int>("RoleName") != id) throw new InvalidOperationException("TOH4E RoleInfo identity mismatch");
            var team = info.ReadField<int>("CustomRoleType");
            if (!names.TryGetValue(id, out var name) || !teams.TryGetValue(team, out var faction)) continue;
            var label = info.ReadStringField("ChatCommand", 256);
            // ChatCommand can be an ASCII shorthand (e.g. "ar"), rather than a role label.
            var displayName = !string.IsNullOrWhiteSpace(label) && label.Any(character => character > 127) ? label : name;
            var entry = new Entry(id, name, displayName, faction,
                killers.TryGetValue(info.Address, out var killer) ? killer : null);
            if (!result.TryAdd(id, entry)) throw new InvalidOperationException("Duplicate TOH4E RoleInfo");
        }
        if (dictionary.ReadField<int>("_version") != version || dictionary.ReadField<int>("_count") != count)
            throw new InvalidOperationException("TOH4E RoleInfo registry changed");
        return result.Values.OrderBy(role => role.roleId).ToArray();
    }

    private static Dictionary<ulong, bool> ReadClassInfos(ClrModule module, Dictionary<string, bool> classes)
    {
        var result = new Dictionary<ulong, bool>();
        foreach (var (name, killer) in classes)
        {
            var type = module.GetTypeByName(name);
            var field = type?.GetStaticFieldByName("RoleInfo");
            if (field == null || field.GetAddress(module.AppDomain) == 0) continue;
            var info = field.ReadObject(module.AppDomain);
            if (!info.IsNull) result[info.Address] = killer;
        }
        return result;
    }
}
