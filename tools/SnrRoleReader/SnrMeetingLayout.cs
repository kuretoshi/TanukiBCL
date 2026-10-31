using Microsoft.Diagnostics.Runtime;
using System.Text;

internal static class SnrMeetingLayout
{
    // Resolve metadata once through the existing discovery; page changes use live read-only reads.
    internal static object? Resolve(DataTarget target, ClrModule module)
    {
        try
        {
            var manager = module.GetTypeByName("SuperNewRoles.Patches.MeetingPagingManager");
            var areasField = manager?.GetStaticFieldByName("<AllPlayerVoteAreas>k__BackingField");
            if (areasField is null) return null;
            var list = areasField.ReadObject(module.AppDomain);
            if (list.IsNull) return null;
            var itemsField = list.Type!.GetFieldByName("_items")!;
            var items = list.ReadObjectField("_items");
            if (items.IsNull || !items.IsArray) return null;
            var array = items.AsArray();
            if (array.Length == 0) return null;
            var first = array.GetObjectValue(0);
            if (first.IsNull || first.Type?.Name != "PlayerVoteArea") return null;
            var voteType = first.Type;
            var size = target.DataReader.PointerSize;
            var field = voteType.GetStaticFieldByName("NativeFieldInfoPtr__PlayerId_k__BackingField")
                ?? voteType.GetStaticFieldByName("NativeFieldInfoPtr_TargetPlayerId");
            if (field is null) return null;
            var info = size == 8 ? field.Read<ulong>(voteType.Module.AppDomain) : field.Read<uint>(voteType.Module.AppDomain);
            ulong Pointer(ulong address) => target.DataReader.ReadPointer(address, out var value)
                ? value : throw new InvalidOperationException("Unreadable SNR meeting pointer");
            var nameBytes = new byte[64];
            var length = target.DataReader.Read(Pointer(info), nameBytes);
            var end = Array.IndexOf(nameBytes, (byte)0, 0, length);
            if (end < 0 || Encoding.UTF8.GetString(nameBytes, 0, end) is not ("<PlayerId>k__BackingField" or "TargetPlayerId")) return null;
            var offsetBytes = new byte[4];
            if (target.DataReader.Read(info + (ulong)(3 * size), offsetBytes) != 4) return null;
            var playerIdOffset = BitConverter.ToInt32(offsetBytes);
            if (playerIdOffset < 2 * size || playerIdOffset > 4096) return null;
            var nativeClass = Pointer(info + (ulong)(2 * size));
            var pooled = voteType.GetFieldByName("pooledPtr");
            if (pooled is null) return null;
            ulong Offset(ClrInstanceField value) => value.GetAddress(0x1000, false) - 0x1000;
            return new {
                enabledSlot = manager!.GetStaticFieldByName("<IsPagingEnabled>k__BackingField")!.GetAddress(module.AppDomain),
                pageSlot = manager.GetStaticFieldByName("<CurrentPage>k__BackingField")!.GetAddress(module.AppDomain),
                areasSlot = areasField.GetAddress(module.AppDomain),
                listType = list.Type.MethodTable, itemsType = items.Type!.MethodTable,
                voteAreaType = voteType.MethodTable, nativeClass,
                itemsOffset = Offset(itemsField), countOffset = Offset(list.Type.GetFieldByName("_size")!),
                versionOffset = Offset(list.Type.GetFieldByName("_version")!),
                pooledPtrOffset = Offset(pooled), playerIdOffset
            };
        }
        catch
        {
            // Unsupported/uninitialized paging must not prevent ordinary SNR role discovery.
            return null;
        }
    }
}
