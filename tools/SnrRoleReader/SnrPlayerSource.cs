using Microsoft.Diagnostics.Runtime;

internal sealed record SnrPlayerSource(ClrModule Module, ClrType PlayerType, ClrObject Array)
{
    public static SnrPlayerSource Resolve(ClrRuntime runtime, List<object> diagnostics)
    {
        var candidates = new List<SnrPlayerSource>();
        foreach (var module in runtime.EnumerateModules().Where(m =>
            string.Equals(Path.GetFileName(m.Name), "SuperNewRoles.dll", StringComparison.OrdinalIgnoreCase)))
        {
            // SNR can load an inactive in-memory copy before the actual plugin. Never
            // select by enumeration order, or scan the heap for potentially stale players.
            var type = module.GetTypeByName("SuperNewRoles.Modules.ExPlayerControl");
            var field = type?.GetStaticFieldByName("_exPlayerControlsArray");
            bool initialized = field?.IsInitialized(module.AppDomain) == true;
            var array = initialized ? field!.ReadObject(module.AppDomain) : default;
            diagnostics.Add(new {
                module = module.Name, moduleAddress = module.Address.ToString("X"),
                typeFound = type != null, fieldFound = field != null, initialized,
                arrayAddress = array.Address.ToString("X"),
                arrayLength = !array.IsNull && array.IsArray ? (int?)array.AsArray().Length : null
            });
            if (!initialized || array.IsNull) continue;
            if (!array.IsArray || array.AsArray().Length != 256 ||
                array.Type?.ComponentType?.MethodTable != type!.MethodTable)
                throw new InvalidOperationException("Unexpected SNR player array structure");
            candidates.Add(new(module, type!, array));
        }

        return candidates.Count switch {
            1 => candidates[0],
            0 => throw new InvalidOperationException("SNRのプレイヤー配列を取得できませんでした。役職割り当て後に再取得してください。詳細は取得診断を確認してください。"),
            _ => throw new InvalidOperationException("初期化済みのSNRが複数見つかり、取得対象を特定できませんでした。")
        };
    }
}
