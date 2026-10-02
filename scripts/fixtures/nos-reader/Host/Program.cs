using Nebula.Collab;
using Nebula.Modules.Cosmetics;

DynamicPalette.Initialize();
TBCLFields.Initialize();
Console.WriteLine("ready");
TBCLFields.Publish();
Console.WriteLine("published");
while (Console.ReadLine() is string command) {
    if (command == "color") DynamicPalette.Change();
    if (command == "gc") { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
    if (command == "team") TBCLFields.Publish(false);
    if (command == "clear") TBCLFields.Publish(empty: true);
    Console.WriteLine(command);
}
