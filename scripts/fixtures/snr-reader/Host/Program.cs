using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;

string mode = args[0];
string plugin = Path.Combine(AppContext.BaseDirectory, "SuperNewRoles.dll");
Assembly inactive = null;
if (mode != "single")
{
    // Reproduce BepInEx's in-memory copy preceding the live plugin module.
    inactive = Assembly.Load(File.ReadAllBytes(plugin));
    _ = inactive.GetType("SuperNewRoles.Modules.ExPlayerControl").TypeHandle;
    if (mode == "ambiguous") Initialize(inactive, mode);
}
var active = AssemblyLoadContext.Default.LoadFromAssemblyPath(plugin);
_ = active.GetType("SuperNewRoles.Modules.ExPlayerControl").TypeHandle;
if (mode != "uninitialized") Initialize(active, mode);
File.WriteAllText(args[1], Environment.ProcessId.ToString());
if (mode == "live") {
    Console.WriteLine("ready");
    string command;
    while ((command = Console.ReadLine()) != null) {
        active.GetType("SuperNewRoles.Modules.ExPlayerControl").GetMethod("Change").Invoke(null, new object[] { command });
        Console.WriteLine(command);
    }
} else Thread.Sleep(Timeout.Infinite);
GC.KeepAlive(inactive);
GC.KeepAlive(active);

[MethodImpl(MethodImplOptions.NoInlining)]
static void Initialize(Assembly assembly, string mode) =>
    assembly.GetType("SuperNewRoles.Modules.ExPlayerControl").GetMethod("Initialize").Invoke(null, new object[] { mode });
