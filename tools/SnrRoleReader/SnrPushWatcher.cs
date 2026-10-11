using Microsoft.Diagnostics.Runtime;
using System.Diagnostics;
using System.Text.Json;

// The injected Unity component has a strong CoreCLR GC handle for its lifetime.
// Follow those handles, rather than scanning stale heap objects or estimating a fall timer.
internal static class SnrPushWatcher
{
    public static void Run(int pid, long started, int? parentPid,
        Func<string, Dictionary<string, Dictionary<long, string>>> readEnums)
    {
        using var target = DataTarget.AttachToProcess(pid, suspend: false);
        using var runtime = (target.ClrVersions.FirstOrDefault()
            ?? throw new InvalidOperationException("CoreCLR not found")).CreateRuntime();
        using var parent = parentPid.HasValue ? Process.GetProcessById(parentPid.Value) : null;
        using var process = Process.GetProcessById(pid);
        var completed = new HashSet<int>();
        var previous = new HashSet<int>();
        var metadata = new Dictionary<string, Dictionary<string, Dictionary<long, string>>>();
        Dictionary<string, Dictionary<long, string>> Enums(string path) {
            if (!metadata.TryGetValue(path, out var names)) metadata[path] = names = readEnums(path);
            return names;
        }
        while (!process.HasExited && !(parent?.HasExited ?? false))
        {
            var clock = Stopwatch.StartNew();
            int[] ids = [];
            bool available = false;
            try
            {
                if (process.StartTime.ToUniversalTime().Ticks != started) break;
                runtime.FlushCachedData();
                ids = Read(runtime, Enums, completed, previous);
                available = true;
            }
            catch
            {
                // Unsuspended CLR reads may race with collection or scene changes.
                // Publish no falling players on failure; never keep a previous sample.
            }
            Console.WriteLine(JsonSerializer.Serialize(new {
                pid, available, playerIds = ids, capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            }));
            Console.Out.Flush();
            Thread.Sleep(Math.Max(1, 100 - (int)clock.ElapsedMilliseconds));
        }
    }

    internal static int[] Read(ClrRuntime runtime,
        Func<string, Dictionary<string, Dictionary<long, string>>> readEnums,
        HashSet<int> completed, HashSet<int> previous)
    {
        var source = SnrPlayerSource.Resolve(runtime, new());
        var animation = source.Module.GetTypeByName("SuperNewRoles.CustomObject.PushedPlayerDeadbody");
        if (animation == null) return [];
        ClrInstanceField? Field(ClrType? type, string name) => type?.Fields.FirstOrDefault(
            f => f.Name == name || f.Name == $"<{name}>k__BackingField");
        var playerField = Field(animation, "Player");
        var stageField = Field(animation, "pushAnimation");
        var timerField = Field(animation, "AnimationTimer");
        var exPlayerField = Field(source.PlayerType, "Player");
        var idField = Field(source.PlayerType, "PlayerId");
        var statusField = Field(source.PlayerType, "FinalStatus") ?? Field(source.PlayerType, "_finalStatus");
        var nullableValue = statusField?.Type?.GetFieldByName("value");
        var statusType = statusField?.Type?.IsEnum == true ? statusField.Type : nullableValue?.Type;
        if (playerField == null || stageField == null || timerField?.ElementType != ClrElementType.Float || exPlayerField == null || idField == null || statusType?.IsEnum != true)
            throw new InvalidOperationException("SNR push animation fields unavailable");
        var names = readEnums(source.Module.Name!);
        if (!names.TryGetValue(statusType.Name!, out var statuses))
            throw new InvalidOperationException("SNR final status names unavailable");
        var pushValues = statuses.Where(p => p.Value == "Push").Select(p => p.Key).ToArray();
        if (pushValues.Length != 1) throw new InvalidOperationException("SNR Push status unavailable");
        long ReadStatus(ClrObject player) {
            ulong address = player.Address;
            bool interior = nullableValue != null;
            var valueField = nullableValue ?? statusField!;
            if (interior) {
                var nullable = statusField!.ReadStruct(player.Address, false);
                if (nullable.Type?.GetFieldByName("hasValue")?.Read<bool>(nullable.Address, true) != true) return -1;
                address = nullable.Address;
            }
            return statusType.GetFieldByName("value__")?.ElementType switch {
                ClrElementType.UInt8 => valueField.Read<byte>(address, interior),
                ClrElementType.Int8 => valueField.Read<sbyte>(address, interior),
                ClrElementType.UInt16 => valueField.Read<ushort>(address, interior),
                ClrElementType.Int16 => valueField.Read<short>(address, interior),
                ClrElementType.UInt32 => valueField.Read<uint>(address, interior),
                ClrElementType.Int32 => valueField.Read<int>(address, interior),
                _ => throw new InvalidOperationException("Unsupported SNR final status")
            };
        }
        var players = source.Array.AsArray();
        var byAddress = new Dictionary<ulong, int>();
        for (int id = 0; id < players.Length; id++)
        {
            var exPlayer = players.GetObjectValue(id);
            if (exPlayer.IsNull || exPlayer.Type?.MethodTable != source.PlayerType.MethodTable || ReadStatus(exPlayer) != pushValues[0]) {
                completed.Remove(id);
                previous.Remove(id);
                continue;
            }
            if (idField.Read<byte>(exPlayer.Address, false) != id)
                throw new InvalidOperationException("SNR push player ID mismatch");
            var player = exPlayerField.ReadObject(exPlayer.Address, false);
            if (!player.IsNull && !completed.Contains(id)) byAddress[player.Address] = id;
        }
        if (byAddress.Count == 0) return [];
        var result = new HashSet<int>();
        foreach (var handle in runtime.EnumerateHandles())
        {
            var obj = handle.Object;
            if (!handle.IsStrong || obj.IsNull || obj.Type?.MethodTable != animation.MethodTable) continue;
            var player = playerField.ReadObject(obj.Address, false);
            if (player.IsNull || !byAddress.TryGetValue(player.Address, out int id)) continue;
            int stage = stageField.Read<int>(obj.Address, false);
            float timer = timerField.Read<float>(obj.Address, false);
            if (stage < 0 || stage > 2 || !float.IsFinite(timer) || timer < 0) continue;
            // OnDestroy clears Player: verify it again before accepting a moving/live sample.
            if (playerField.ReadObject(obj.Address, false).Address == player.Address) result.Add(id);
        }
        foreach (var id in previous) if (!result.Contains(id)) completed.Add(id);
        previous.Clear();
        previous.UnionWith(result);
        return result.Order().ToArray();
    }
}
