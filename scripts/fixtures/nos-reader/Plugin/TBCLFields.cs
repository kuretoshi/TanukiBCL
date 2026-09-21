using System.Runtime.InteropServices;

namespace Nebula.Collab;

public static unsafe class TBCLFields
{
    public static bool RequireUpdate;
    public static Snapshot* Latest;
    static TBCLFields() { RequireUpdate = false; Latest = null; }
    public struct Snapshot { public float LocalMicPositionX, LocalMicPositionY; public int PlayersLength; public PlayerData* Players; }
    public struct PlayerData {
        public byte PlayerId;
        public bool IsKiller, IsImpostor, IsCrewmate, IsNeutral, IsImpostorlike;
        public float SpeakerPositionX, SpeakerPositionY;
        public byte NameLength;
        public fixed char Name[32];
        public float ColorR, ColorG, ColorB;
    }
    public static void Initialize() { _ = typeof(Snapshot).TypeHandle; _ = typeof(PlayerData).TypeHandle; }
    public static void Publish(bool neutral = true, bool empty = false) {
        var player = (PlayerData*)Marshal.AllocHGlobal(sizeof(PlayerData));
        *player = new PlayerData { PlayerId = 3, IsNeutral = neutral, IsImpostor = !neutral, IsKiller = true,
            SpeakerPositionX = 2.5f, SpeakerPositionY = -1.25f, ColorR = .25f, ColorG = .5f, ColorB = .75f, NameLength = 3 };
        var name = "テスト"; for (int i = 0; i < name.Length; i++) player->Name[i] = name[i];
        var snapshot = (Snapshot*)Marshal.AllocHGlobal(sizeof(Snapshot));
        *snapshot = new Snapshot { LocalMicPositionX = 1f, LocalMicPositionY = -1f, PlayersLength = empty ? 0 : 1, Players = player };
        Latest = snapshot;
    }
}
