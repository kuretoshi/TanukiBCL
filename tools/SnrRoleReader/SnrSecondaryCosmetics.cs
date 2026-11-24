using Microsoft.Diagnostics.Runtime;
using System.Text;

// Cosmetic layers are created before ExPlayerControl/roles. Join their native
// addresses to PlayerControl instead of relying on a managed wrapper's identity.
internal sealed class SnrSecondaryCosmetics
{
    private readonly DataTarget target;
    private readonly ulong controlClass, cosmeticsClass, cosmeticsOffset;
    private readonly Dictionary<ulong, (string? hat2Id, string? visor2Id)> layers;
    internal object Layout { get; }

    private SnrSecondaryCosmetics(DataTarget target, int pid, ulong controlClass, ulong cosmeticsClass,
        ulong playerIdOffset, ulong cosmeticsOffset, Dictionary<ulong, (string?, string?)> layers)
    {
        this.target = target;
        this.controlClass = controlClass;
        this.cosmeticsClass = cosmeticsClass;
        this.cosmeticsOffset = cosmeticsOffset;
        this.layers = layers;
        Layout = new { pid, pointerSize = target.DataReader.PointerSize, controlClass, cosmeticsClass,
            playerIdOffset, cosmeticsOffset, layers = layers.Select(row => new {
                address = row.Key, @class = cosmeticsClass, hat2Id = row.Value.Item1, visor2Id = row.Value.Item2 }).ToArray() };
    }

    internal static SnrSecondaryCosmetics Resolve(ClrRuntime runtime, DataTarget target, int pid)
    {
        var modules = runtime.EnumerateModules().Where(module =>
            string.Equals(Path.GetFileName(module.Name), "SuperNewRoles.dll", StringComparison.OrdinalIgnoreCase))
            .Where(module => module.GetTypeByName("SuperNewRoles.CustomCosmetics.CosmeticsPlayer.CustomCosmeticsLayers")
                ?.GetStaticFieldByName("layers")?.IsInitialized(module.AppDomain) == true).ToArray();
        if (modules.Length != 1) throw new InvalidOperationException("Unique initialized SNR cosmetic module required");
        var layouts = new HashSet<(ulong Control, ulong Cosmetics, ulong IdOffset, ulong CosmeticsOffset)>();
        foreach (var module in runtime.EnumerateModules().Where(module =>
            string.Equals(Path.GetFileName(module.Name), "Assembly-CSharp.dll", StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                var control = module.GetTypeByName("PlayerControl")!;
                var (controlClass, cosmeticsOffset) = NativeField(target, control, "cosmetics");
                var (idClass, idOffset) = NativeField(target, control, "PlayerId");
                var (cosmeticsClass, _) = NativeField(target, module.GetTypeByName("CosmeticsLayer")!, "bodyType");
                if (controlClass == idClass) layouts.Add((controlClass, cosmeticsClass, idOffset, cosmeticsOffset));
            }
            catch { /* Inactive interop assemblies must not win by enumeration order. */ }
        }
        if (layouts.Count != 1) throw new InvalidOperationException("Unique native SNR cosmetic layout required");
        var layout = layouts.Single();
        var owner = modules[0].GetTypeByName("SuperNewRoles.CustomCosmetics.CosmeticsPlayer.CustomCosmeticsLayers")!;
        var dictionary = owner.GetStaticFieldByName("layers")!.ReadObject(modules[0].AppDomain);
        var result = new Dictionary<ulong, (string?, string?)>();
        foreach (var entry in Dictionary(dictionary, 4096, entry =>
        {
            var layer = entry.Type!.GetFieldByName("value")!.ReadObject(entry.Address, true);
            var wrapper = Object(layer, "cosmeticsLayer");
            if (wrapper.IsNull) return (Address: 0UL, Hat: (string?)null, Visor: (string?)null);
            var field = Field(wrapper.Type, "pooledPtr") ?? throw new InvalidOperationException("Native cosmetic wrapper missing");
            var slot = field.GetAddress(wrapper.Address, false);
            var address = Pointer(target, slot);
            var values = (Hat: Product(layer, true), Visor: Product(layer, false));
            if (Pointer(target, slot) != address || Pointer(target, address) != layout.Cosmetics)
                throw new InvalidOperationException("Native SNR cosmetic wrapper changed");
            return (Address: address, values.Hat, values.Visor);
        }))
        {
            if (entry.Address != 0 && !result.TryAdd(entry.Address, (entry.Hat, entry.Visor)))
                throw new InvalidOperationException("Duplicate native SNR cosmetic layer");
        }
        return new(target, pid, layout.Control, layout.Cosmetics, layout.IdOffset, layout.CosmeticsOffset, result);
    }

    internal (string? hat2Id, string? visor2Id) Player(ClrObject player)
    {
        var wrapper = Object(player, "Player");
        var field = Field(wrapper.Type, "pooledPtr") ?? throw new InvalidOperationException("Native player wrapper missing");
        var slot = field.GetAddress(wrapper.Address, false);
        var control = Pointer(target, slot);
        var cosmetics = Pointer(target, control + cosmeticsOffset);
        if (Pointer(target, control) != controlClass || Pointer(target, cosmetics) != cosmeticsClass ||
            Pointer(target, slot) != control || Pointer(target, control + cosmeticsOffset) != cosmetics)
            throw new InvalidOperationException("Native SNR cosmetic owner changed");
        return layers.GetValueOrDefault(cosmetics);
    }

    internal static string? Product(ClrObject layer, bool hat)
    {
        var value = Object(layer, hat ? "hat2" : "visor2");
        if (value.IsNull) return null;
        var collection = hat ? "Hats" : "Visors";
        if (Field(value.Type, collection) is null) return ProductId(Object(value, hat ? "Hat" : "Visor"), hat);
        var currentField = hat ? "CurrentHatType" : "CurrentVisorType";
        var current = Number(Field(value.Type, currentField)!, value.Address, false);
        if (current is < 0 or > 3) throw new InvalidOperationException("Unsupported SNR outfit selection");
        var dictionary = Object(value, collection);
        var rows = Dictionary(dictionary, 64, entry => (
            Key: Number(entry.Type!.GetFieldByName("key")!, entry.Address, true),
            Value: entry.Type!.GetFieldByName("value")!.ReadObject(entry.Address, true))).Where(row => row.Key == current).ToArray();
        if (rows.Length > 1) throw new InvalidOperationException("Duplicate SNR outfit selection");
        var result = rows.Length == 0 ? null : ProductId(rows[0].Value, hat);
        if (Number(Field(value.Type, currentField)!, value.Address, false) != current || Object(value, collection).Address != dictionary.Address)
            throw new InvalidOperationException("SNR outfit changed");
        return result;
    }

    private static string? ProductId(ClrObject value, bool hat)
    {
        if (value.IsNull) return null;
        if (Field(value.Type, "ProdId") is not null) return String(value, "ProdId");
        var expected = "SuperNewRoles.CustomCosmetics.UI.Modded" + (hat ? "Hat" : "Visor") + "DataWrapper";
        if (value.Type?.Name != expected) return null;
        var data = Object(value, "_data");
        var package = String(Object(data, "package"), "name");
        var id = String(data, hat ? "hat_id" : "visor_id");
        if (string.IsNullOrEmpty(package) || string.IsNullOrEmpty(id)) throw new InvalidOperationException("Invalid SNR product ID");
        var result = $"Modded_{package}_{id}";
        return result.Length <= 1024 ? result : throw new InvalidOperationException("Invalid SNR product ID");
    }

    private static List<T> Dictionary<T>(ClrObject dictionary, int maximum, Func<ClrValueType, T> read)
    {
        if (dictionary.IsNull) return new();
        var entries = Object(dictionary, "_entries");
        var count = Number(Field(dictionary.Type, "_count")!, dictionary.Address, false);
        var version = Number(Field(dictionary.Type, "_version")!, dictionary.Address, false);
        if (entries.IsNull && count == 0) return new();
        if (!entries.IsArray || count < 0 || count > maximum || count > entries.AsArray().Length)
            throw new InvalidOperationException("Invalid SNR cosmetic dictionary");
        var result = new List<T>();
        for (var i = 0; i < count; i++)
        {
            var entry = entries.AsArray().GetStructValue(i);
            if (Number(entry.Type!.GetFieldByName("next")!, entry.Address, true) >= -1) result.Add(read(entry));
        }
        if (Object(dictionary, "_entries").Address != entries.Address ||
            Number(Field(dictionary.Type, "_count")!, dictionary.Address, false) != count ||
            Number(Field(dictionary.Type, "_version")!, dictionary.Address, false) != version)
            throw new InvalidOperationException("SNR cosmetic dictionary changed");
        return result;
    }

    private static (ulong Class, ulong Offset) NativeField(DataTarget target, ClrType type, string name)
    {
        var field = type.GetStaticFieldByName($"NativeFieldInfoPtr_{name}") ?? throw new InvalidOperationException("Native SNR field unavailable");
        var info = target.DataReader.PointerSize == 8 ? field.Read<ulong>(type.Module.AppDomain) : field.Read<uint>(type.Module.AppDomain);
        var bytes = new byte[64];
        var length = target.DataReader.Read(Pointer(target, info), bytes);
        var end = Array.IndexOf(bytes, (byte)0, 0, length);
        if (end < 0 || Encoding.UTF8.GetString(bytes, 0, end) != name) throw new InvalidOperationException("Native SNR field mismatch");
        var offsetBytes = new byte[4];
        if (target.DataReader.Read(info + (ulong)(3 * target.DataReader.PointerSize), offsetBytes) != 4)
            throw new InvalidOperationException("Unreadable native SNR field offset");
        var offset = BitConverter.ToInt32(offsetBytes);
        if (offset < 2 * target.DataReader.PointerSize || offset > 4096) throw new InvalidOperationException("Invalid native SNR field offset");
        return (Pointer(target, info + (ulong)(2 * target.DataReader.PointerSize)), (ulong)offset);
    }
    private static ulong Pointer(DataTarget target, ulong address) => target.DataReader.ReadPointer(address, out var value) && value >= 0x10000
        ? value : throw new InvalidOperationException("Unreadable native SNR pointer");
    private static ClrInstanceField? Field(ClrType? type, string name)
    {
        for (; type is not null; type = type.BaseType)
        {
            var field = type.Fields.FirstOrDefault(field => field.Name == name || field.Name == $"<{name}>k__BackingField");
            if (field is not null) return field;
        }
        return null;
    }
    private static ClrObject Object(ClrObject value, string name) => value.IsNull ? default : Field(value.Type, name)?.ReadObject(value.Address, false) ?? default;
    private static string? String(ClrObject value, string name)
    {
        var text = Object(value, name);
        return text.IsNull ? null : text.AsString(1024);
    }
    private static long Number(ClrInstanceField field, ulong address, bool interior)
    {
        var element = field.Type?.IsEnum == true ? field.Type.GetFieldByName("value__")!.ElementType : field.ElementType;
        return element switch {
            ClrElementType.UInt8 => field.Read<byte>(address, interior), ClrElementType.Int8 => field.Read<sbyte>(address, interior),
            ClrElementType.UInt16 => field.Read<ushort>(address, interior), ClrElementType.Int16 => field.Read<short>(address, interior),
            ClrElementType.UInt32 => field.Read<uint>(address, interior), ClrElementType.Int32 => field.Read<int>(address, interior),
            _ => throw new InvalidOperationException("Invalid SNR numeric field")
        };
    }
}
