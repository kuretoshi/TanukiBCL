using TownOfHostForE;
using TownOfHostForE.Roles.Neutral;
PlayerState.Initialize(); Opportunist.CanKill = false;
Console.WriteLine("ready");
while (Console.ReadLine() is string command) {
    switch(command) {
        case "change": PlayerState.Change(); break;
        case "sheriff": PlayerState.Sheriff(); break;
        case "impostor": PlayerState.Impostor(); break;
        case "kill": Opportunist.CanKill = true; break;
        case "remove": PlayerState.Remove(); break;
        case "replace": PlayerState.Replace(); break;
        case "unknown": PlayerState.Unknown(); break;
        case "gc": GC.Collect(2, GCCollectionMode.Forced, true, true); break;
    }
    Console.WriteLine(command);
}
