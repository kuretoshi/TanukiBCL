using Nebula.Collab;
using Nebula.Modules.Cosmetics;

DynamicPalette.Initialize();
TBCLFields.Initialize();
_ = Nebula.Game.NebulaGameManager.instance;
_ = Nebula.Modules.Language.DefaultLanguage;
Console.WriteLine("ready");
TBCLFields.Publish();
Console.WriteLine("published");
while (Console.ReadLine() is string command) {
    if (command.StartsWith("star-")) Nebula.Game.NebulaGameManager.SetStar(command);
    if (command == "color") DynamicPalette.Change();
    if (command == "gc") { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
    if (command == "team") TBCLFields.Publish(false);
    if (command == "neck") TBCLFields.Publish(bodyType: 3, neckLength: 12);
    if (command == "normal") TBCLFields.Publish(bodyType: 0, neckLength: 0);
    if (command == "berserk") TBCLFields.Publish(bodyType: 2, neckLength: 0);
    if (command == "clear") TBCLFields.Publish(empty: true);
    Console.WriteLine(command);
}
