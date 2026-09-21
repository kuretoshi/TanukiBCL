namespace SuperNewRoles.Modules;

public enum RoleId { Jackal = 11, Frankenstein = 137 }
[Flags]
public enum ModifierRoleId { None = 0, JumboModifier = 16, TestModifier = 32 }

public sealed class ExPlayerControl
{
    private static ExPlayerControl[] _exPlayerControlsArray;
    // Explicit constructor keeps the metadata-only copy uninitialized.
    static ExPlayerControl() => _exPlayerControlsArray = new ExPlayerControl[256];

    public byte PlayerId { get; private set; }
    public RoleId Role { get; private set; }
    public ModifierRoleId ModifierRole { get; private set; }
    public object roleBase { get; } = new();
    private readonly List<object> _playerAbilities = new();

    public static void Initialize(string mode)
    {
        if (mode == "empty") return;
        _exPlayerControlsArray[3] = new() {
            PlayerId = (byte)(mode == "mismatch" ? 4 : 3), Role = RoleId.Jackal,
            ModifierRole = ModifierRoleId.JumboModifier
        };
        _exPlayerControlsArray[2] = new() {
            PlayerId = 2, Role = RoleId.Frankenstein,
            ModifierRole = ModifierRoleId.JumboModifier | ModifierRoleId.TestModifier
        };
        _exPlayerControlsArray[3]._playerAbilities.Add(new SuperNewRoles.Roles.Modifiers.JumboAbility());
    }

    public static void Change(string command)
    {
        switch (command)
        {
            case "grow":
                ((SuperNewRoles.Roles.Modifiers.JumboAbility)_exPlayerControlsArray[3]._playerAbilities[0])._currentSize = 4f;
                break;
            case "invalid-size":
                ((SuperNewRoles.Roles.Modifiers.JumboAbility)_exPlayerControlsArray[3]._playerAbilities[0])._currentSize = float.NaN;
                break;
            case "role":
                _exPlayerControlsArray[3].Role = RoleId.Frankenstein;
                _exPlayerControlsArray[3].ModifierRole = ModifierRoleId.None;
                break;
            case "replace":
                _exPlayerControlsArray = new ExPlayerControl[256];
                Initialize("live");
                break;
            case "clear": _exPlayerControlsArray = new ExPlayerControl[256]; break;
            case "gc":
                GC.Collect(2, GCCollectionMode.Forced, true, true);
                GC.WaitForPendingFinalizers();
                break;
        }
    }
}
