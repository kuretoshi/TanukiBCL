namespace TownOfHostForE {
    public enum CustomRoles { Crewmate = 3, Jackal = 900, Opportunist = 901, Egoist = 902, DarkHide = 903, Arsonist = 904, Sheriff = 905, Impostor = 906, NotAssigned = 999 }
    public class PlayerState {
        byte PlayerId;
        public CustomRoles MainRole;
        private static Dictionary<byte, PlayerState> allPlayerStates = new();
        public PlayerState(byte id, CustomRoles role) { PlayerId = id; MainRole = role; }
        public static void Initialize() {
            allPlayerStates[2] = new(2, CustomRoles.Jackal); allPlayerStates[5] = new(5, CustomRoles.Opportunist);
            // Load all fixture role types, but deliberately use a class name different from the enum.
            _ = new Roles.Neutral.Arsonist(allPlayerStates[2]);
            _ = new Roles.Neutral.DarkHide(allPlayerStates[2]);
            _ = new Roles.Neutral.SheriffImplementation(allPlayerStates[2]);
            _ = new Roles.Neutral.Impostor(allPlayerStates[2]);
            Roles.Core.CustomRoleManager.AllActiveRoles = new() {
                [2] = new Roles.Neutral.Jackal(allPlayerStates[2]), [5] = new Roles.Neutral.Opportunist(allPlayerStates[5]) };
        }
        public static void Change() {
            allPlayerStates[2].MainRole = CustomRoles.Arsonist;
            Roles.Core.CustomRoleManager.AllActiveRoles[2] = new Roles.Neutral.Arsonist(allPlayerStates[2]);
        }
        public static void Sheriff() {
            allPlayerStates[2].MainRole = CustomRoles.Sheriff;
            Roles.Core.CustomRoleManager.AllActiveRoles[2] = new Roles.Neutral.SheriffImplementation(allPlayerStates[2]);
        }
        public static void Impostor() {
            allPlayerStates[2].MainRole = CustomRoles.Impostor;
            Roles.Core.CustomRoleManager.AllActiveRoles[2] = new Roles.Neutral.Impostor(allPlayerStates[2]);
        }
        public static void Remove() { allPlayerStates.Remove(2); Roles.Core.CustomRoleManager.AllActiveRoles.Remove(2); }
        public static void Replace() {
            allPlayerStates = new() { [7] = new(7, CustomRoles.DarkHide) };
            Roles.Core.CustomRoleManager.AllActiveRoles = new() { [7] = new Roles.Neutral.DarkHide(allPlayerStates[7]) };
        }
        public static void Unknown() => allPlayerStates[7].MainRole = (CustomRoles)123456;
    }
}
namespace TownOfHostForE.Roles.Core.Interfaces {
    public interface IKiller { }
    public interface IImpostor : IKiller { }
}
namespace TownOfHostForE.Roles.Core {
    public abstract class RoleBase(PlayerState state) { public readonly PlayerState MyState = state; }
    public static class CustomRoleManager { public static Dictionary<byte, RoleBase> AllActiveRoles = new(); }
}
namespace TownOfHostForE.Roles.Neutral {
    using TownOfHostForE.Roles.Core;
    using TownOfHostForE.Roles.Core.Interfaces;
    public class Jackal(PlayerState state) : RoleBase(state), IKiller { }
    public class Opportunist(PlayerState state) : RoleBase(state), IKiller { public static bool CanKill; }
    public class Arsonist(PlayerState state) : RoleBase(state) { }
    public class DarkHide(PlayerState state) : Jackal(state) { }
    public class SheriffImplementation(PlayerState state) : RoleBase(state), IKiller { }
    public class Impostor(PlayerState state) : RoleBase(state), IImpostor { }
}
