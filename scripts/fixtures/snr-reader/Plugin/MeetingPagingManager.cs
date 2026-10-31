using System.Runtime.InteropServices;

// Match the managed wrapper/native FieldInfo boundary used by SNR's vote areas.
public class Il2CppObjectFixture { internal nint pooledPtr; }
public sealed class PlayerVoteArea : Il2CppObjectFixture
{
    private static readonly nint NativeFieldInfoPtr__PlayerId_k__BackingField;
    private static readonly nint NativeClass = Marshal.AllocHGlobal(IntPtr.Size);
    static PlayerVoteArea()
    {
        NativeFieldInfoPtr__PlayerId_k__BackingField = Marshal.AllocHGlobal(4 * IntPtr.Size);
        Marshal.WriteIntPtr(NativeFieldInfoPtr__PlayerId_k__BackingField, Marshal.StringToHGlobalAnsi("<PlayerId>k__BackingField"));
        Marshal.WriteIntPtr(NativeFieldInfoPtr__PlayerId_k__BackingField, 2 * IntPtr.Size, NativeClass);
        Marshal.WriteInt32(NativeFieldInfoPtr__PlayerId_k__BackingField, 3 * IntPtr.Size, 2 * IntPtr.Size);
    }
    public PlayerVoteArea(int id)
    {
        pooledPtr = Marshal.AllocHGlobal(3 * IntPtr.Size);
        Marshal.WriteIntPtr(pooledPtr, NativeClass);
        Marshal.WriteByte(pooledPtr, 2 * IntPtr.Size, (byte)id);
    }
}

namespace SuperNewRoles.Patches
{
    public static class MeetingPagingManager
    {
        public static bool IsPagingEnabled { get; private set; }
        public static int CurrentPage { get; private set; }
        public static List<PlayerVoteArea> AllPlayerVoteAreas { get; private set; }
        public static void Initialize()
        {
            IsPagingEnabled = true;
            CurrentPage = 1;
            // The real HUD order is independent of PlayerId sorting.
            AllPlayerVoteAreas = Enumerable.Range(0, 45).Reverse().Select(id => new PlayerVoteArea(id)).ToList();
        }
        public static void Change(string command)
        {
            if (command.StartsWith("page-")) CurrentPage = int.Parse(command[5..]);
            if (command == "meeting-replace") AllPlayerVoteAreas = new(AllPlayerVoteAreas.AsEnumerable().Reverse());
            if (command == "meeting-off") IsPagingEnabled = false;
        }
    }
}
