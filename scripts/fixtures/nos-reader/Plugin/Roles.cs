namespace Virial.Assignable
{
    public interface IRoleID { int Id { get; } }
}
namespace Nebula.Roles
{
    public class TestRole : Virial.Assignable.IRoleID
    {
        public string LocalizedName { get; } = "fixtureRole";
        int Virial.Assignable.IRoleID.Id { get; } = 1;
    }
    public class TestRuntime { public TestRole role = new(); }
}
namespace Nebula.Player
{
    public class PlayerModInfo
    {
        public byte PlayerId { get; } = 3;
        public object myRole = new Nebula.Roles.TestRuntime();
        public List<object> myModifiers = new();
    }
}
namespace Nebula.Game
{
    public class NebulaGameManager
    {
        public static NebulaGameManager instance = new();
        public Dictionary<byte, Nebula.Player.PlayerModInfo> allModPlayers = new() { [3] = new() };
        public static void SetStar(string command)
        {
            var player = instance.allModPlayers[3];
            player.myModifiers.Clear();
            if (command == "star-clear") return;
            player.myModifiers.Add(new Hori.Scripts.Role.Modifier.StarU.Instance());
            Hori.Scripts.Role.Modifier.StarU.RainbowStar.val = command == "star-unknown"
                ? new object() : new Nebula.Configuration.BoolConfigurationValue(command == "star-on");
        }
    }
}
namespace Nebula.Modules
{
    public class Language
    {
        public static Language DefaultLanguage = new();
        public static Language CurrentLanguage = DefaultLanguage;
        public static Language GuestLanguage = DefaultLanguage;
        public Dictionary<string, string> translationMap = new() { ["role.fixtureRole.name"] = "Fixture role" };
    }
}
namespace Nebula.Configuration
{
    public class TestValueBase { public bool currentValue; }
    public class BoolConfigurationValue : TestValueBase
    {
        public BoolConfigurationValue(bool value) { currentValue = value; }
    }
    public class TestBoolConfiguration { public object val = new BoolConfigurationValue(false); }
}
namespace Hori.Scripts.Role.Modifier
{
    public class StarU
    {
        public static Nebula.Configuration.TestBoolConfiguration RainbowStar = new();
        public class Instance { }
    }
}
