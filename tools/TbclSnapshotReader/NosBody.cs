using Microsoft.Diagnostics.Runtime;
using System.Text;

internal static class NosBody
{
    internal record Layout(int PointerSize, ulong ControlAddress, ulong ControlClass, ulong CosmeticsClass,
        int PlayerIdOffset, int CosmeticsOffset, int BodyTypeOffset);

    // IL2CPP FieldInfo is name/type/parent pointers, followed by its int32 field offset.
    // Validate field names and parent classes before publishing a native read layout.
    internal static Layout? Resolve(DataTarget target, ClrObject player, byte id)
    {
        try
        {
            var control = player.ReadObjectField("<MyControl>k__BackingField");
            int size = target.DataReader.PointerSize;
            ulong address = size == 8 ? control.ReadField<ulong>("pooledPtr") : control.ReadField<uint>("pooledPtr");
            if (address == 0) return null;
            var module = control.Type!.Module;
            var cosmeticsType = module.GetTypeByName("CosmeticsLayer")!;
            (ulong parent, int offset) Field(ClrType type, string name)
            {
                var field = type.GetStaticFieldByName("NativeFieldInfoPtr_" + name)!;
                ulong info = size == 8 ? field.Read<ulong>(module.AppDomain) : field.Read<uint>(module.AppDomain);
                var bytes = new byte[64];
                int read = target.DataReader.Read(Pointer(info), bytes);
                int end = Array.IndexOf(bytes, (byte)0, 0, read);
                if (end < 0 || Encoding.UTF8.GetString(bytes, 0, end) != name)
                    throw new InvalidOperationException("Unexpected IL2CPP field");
                int offset = Integer(info + (ulong)(3 * size));
                if (offset < 2 * size || offset > 4096) throw new InvalidOperationException("Invalid IL2CPP field offset");
                return (Pointer(info + (ulong)(2 * size)), offset);
            }
            var cosmetics = Field(control.Type!, "cosmetics");
            var identity = Field(control.Type!, "PlayerId");
            var body = Field(cosmeticsType, "bodyType");
            ulong nativeCosmetics = Pointer(address + (ulong)cosmetics.offset);
            var identityBytes = new byte[1];
            if (Pointer(address) != cosmetics.parent || identity.parent != cosmetics.parent ||
                Pointer(nativeCosmetics) != body.parent ||
                target.DataReader.Read(address + (ulong)identity.offset, identityBytes) != 1 || identityBytes[0] != id)
                return null;
            return new Layout(size, address, cosmetics.parent, body.parent, identity.offset, cosmetics.offset, body.offset);

            ulong Pointer(ulong location) => target.DataReader.ReadPointer(location, out ulong value)
                ? value : throw new InvalidOperationException("Unreadable NoS native pointer");
            int Integer(ulong location)
            {
                var bytes = new byte[4];
                if (target.DataReader.Read(location, bytes) != 4) throw new InvalidOperationException("Unreadable NoS native field");
                return BitConverter.ToInt32(bytes);
            }
        }
        catch (Exception)
        {
            // Unsupported native metadata must not prevent reading the managed role name.
            return null;
        }
    }
}
