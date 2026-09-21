using Nebula.Collab;
using Nebula.Modules.Cosmetics;

DynamicPalette.Initialize();
TBCLFields.Initialize();
Console.WriteLine("ready");
// The resolver enables only our owned fixture's flag; all subsequent samples are read-only.
while (!TBCLFields.RequireUpdate) Thread.Sleep(10);
TBCLFields.Publish();
Console.WriteLine("published");
while (Console.ReadLine() is string command) {
    if (command == "color") DynamicPalette.Change();
    if (command == "gc") { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
    if (command == "team") TBCLFields.Publish(false);
    if (command == "clear") TBCLFields.Publish(empty: true);
    Console.WriteLine(command);
}
