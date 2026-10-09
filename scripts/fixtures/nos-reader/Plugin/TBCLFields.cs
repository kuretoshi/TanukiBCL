using System.Runtime.InteropServices;

namespace Nebula.Collab;

public static unsafe class TBCLFields
{
    public const int Version = 20261009;
    private static int nextIndex;
    public static Snapshot* Latest;
    static TBCLFields() { nextIndex = 0; Latest = null; }
    public struct Snapshot {
        public float LocalMicPositionX, LocalMicPositionY;
        public int PlayersLength;
        public PlayerData* Players;
        public int RadiosLength;
        public RadioData* Radios;
    }
    public struct CostumeData {
        public byte NameLength;
        public fixed char Name[128];
    }
    public struct PlayerData {
        public byte PlayerId;
        public bool IsKiller, IsImpostor, IsCrewmate, IsNeutral, IsImpostorlike, IsJammed;
        public float SpeakerPositionX, SpeakerPositionY;
        public float BodyRateX, BodyRateY;
        public byte NameLength;
        public fixed char Name[32];
        public float ColorR, ColorG, ColorB;
        public CostumeData Skin, Hat, Visor;
        public int BodyType;
        public float NeckLength;
    }
    public enum RadioKind { Impostor, Jackal, Lovers }
    public struct RadioData {
        public RadioKind Kind;
        public int HearableMask;
        public byte NameLength;
        public fixed char Name[32];
    }
    public static void Initialize() { _ = typeof(Snapshot).TypeHandle; _ = typeof(PlayerData).TypeHandle; _ = typeof(RadioData).TypeHandle; }
    public static void Publish(bool neutral = true, bool empty = false, int bodyType = 3, float neckLength = 5) {
        var player = (PlayerData*)Marshal.AllocHGlobal(sizeof(PlayerData));
        *player = new PlayerData { PlayerId = 3, IsNeutral = neutral, IsImpostor = !neutral, IsKiller = true, IsJammed = neutral,
            SpeakerPositionX = 2.5f, SpeakerPositionY = -1.25f, BodyRateX = 1.25f, BodyRateY = .75f, BodyType = bodyType, NeckLength = neckLength,
            ColorR = .25f, ColorG = .5f, ColorB = .75f, NameLength = 3 };
        var name = "テスト"; for (int i = 0; i < name.Length; i++) player->Name[i] = name[i];
        player->Skin.NameLength = 4;
        var costumeName = "Test"; for (int i = 0; i < costumeName.Length; i++) player->Skin.Name[i] = costumeName[i];
        var snapshot = (Snapshot*)Marshal.AllocHGlobal(sizeof(Snapshot));
        var radio = (RadioData*)Marshal.AllocHGlobal(sizeof(RadioData));
        *radio = new RadioData { Kind = RadioKind.Jackal, HearableMask = 0xB, NameLength = 6 };
        var radioName = "Jackal"; for (int i = 0; i < radioName.Length; i++) radio->Name[i] = radioName[i];
        *snapshot = new Snapshot { LocalMicPositionX = 1f, LocalMicPositionY = -1f,
            PlayersLength = empty ? 0 : 1, Players = player, RadiosLength = 1, Radios = radio };
        Latest = snapshot;
        nextIndex++;
    }
}
