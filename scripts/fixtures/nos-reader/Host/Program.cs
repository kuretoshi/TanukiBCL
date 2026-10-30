using Nebula.Collab;
using Nebula.Modules.Cosmetics;

DynamicPalette.Initialize();
TBCLFields.Initialize();
_ = Nebula.Game.NebulaGameManager.instance;
_ = Nebula.Modules.Language.DefaultLanguage;
Console.WriteLine("ready");
TBCLFields.Publish();
Console.WriteLine("published");
CancellationTokenSource? gcStop = null;
Task? gcWorker = null;
int gcCycles = 0;
while (Console.ReadLine() is string command) {
    if (command == "gc-stress-start" && gcStop == null) {
        gcStop = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var token = gcStop.Token;
        gcCycles = 0;
        gcWorker = Task.Run(() => {
            while (!token.IsCancellationRequested) {
                for (int i = 0; i < 32; i++) GC.KeepAlive(new byte[4096]);
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
                Interlocked.Increment(ref gcCycles);
                Thread.Sleep(10);
            }
        });
    }
    if (command == "gc-stress-stop") {
        gcStop?.Cancel();
        gcWorker?.Wait();
        gcStop?.Dispose();
        gcStop = null;
        Console.WriteLine($"gc-stress-stop:{gcCycles}");
        continue;
    }
    if (command.StartsWith("star-")) Nebula.Game.NebulaGameManager.SetStar(command);
    if (command.StartsWith("lang-")) Nebula.Modules.Language.Change(command);
    if (command == "color") DynamicPalette.Change();
    if (command == "gc") { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
    if (command == "team") TBCLFields.Publish(false);
    if (command == "neck") TBCLFields.Publish(bodyType: 3, neckLength: 12);
    if (command == "normal") TBCLFields.Publish(bodyType: 0, neckLength: 0);
    if (command == "berserk") TBCLFields.Publish(bodyType: 2, neckLength: 0);
    if (command == "clear") TBCLFields.Publish(empty: true);
    Console.WriteLine(command);
}
gcStop?.Cancel();
gcWorker?.Wait();
gcStop?.Dispose();
