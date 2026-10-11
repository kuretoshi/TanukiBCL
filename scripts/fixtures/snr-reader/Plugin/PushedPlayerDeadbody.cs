using System.Runtime.InteropServices;

namespace SuperNewRoles.CustomObject;

public sealed class PushedPlayerDeadbody
{
    public object Player { get; private set; }
    private int pushAnimation = 1;
    private float AnimationTimer = 0.1f;
    private static GCHandle handle;

    public static void Start(object player)
    {
        End();
        if (handle.IsAllocated) handle.Free();
        handle = GCHandle.Alloc(new PushedPlayerDeadbody { Player = player }, GCHandleType.Normal);
    }

    public static void End()
    {
        // Keep the old object and its handle alive, as Unity can do until native finalization.
        if (handle.IsAllocated) ((PushedPlayerDeadbody)handle.Target).Player = null;
    }
}
