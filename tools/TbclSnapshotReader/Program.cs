using Microsoft.Diagnostics.Runtime;
using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class Program
{
    const string NebulaModuleName = "Nebula.dll";
    const string TbclTypeName = "Nebula.Collab.TBCLFields";
    const string SnapshotTypeName = "Nebula.Collab.TBCLFields+Snapshot";
    const string PlayerDataTypeName = "Nebula.Collab.TBCLFields+PlayerData";
    const int ExpectedSchemaVersion = 20260918;
    const int PlayersCapacity = 24;
    const int NameCapacity = 32;

    static readonly JsonSerializerOptions jsonOptions = new JsonSerializerOptions
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static void Main(string[] args)
    {
        try
        {
            if (args.Length < 2)
                throw new ArgumentException(
                    "Usage: TbclSnapshotReader resolve <pid> [metadata.json] | read <pid> <metadata.json>");

            string command = args[0].ToLowerInvariant();
            int pid = int.Parse(args[1]);

            switch (command)
            {
                case "palette":
                {
                    var metadata = ResolvePalette(pid);
                    Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, metadata }, jsonOptions));
                    break;
                }
                case "layout":
                {
                    var metadata = Resolve(pid);
                    EnableContinuousUpdates(pid, metadata);
                    Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, metadata }, jsonOptions));
                    break;
                }
                case "resolve":
                {
                    string outputPath = args.Length >= 3 ? args[2] : "tbcl-metadata.json";
                    ResolvedMetadata metadata = Resolve(pid);
                    EnableContinuousUpdates(pid, metadata);
                    File.WriteAllText(outputPath, JsonSerializer.Serialize(metadata, jsonOptions), Encoding.UTF8);

                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        status = "ok",
                        mode = "resolve",
                        pid,
                        metadata = Path.GetFullPath(outputPath),
                        requireUpdateAddress = Hex(metadata.RequireUpdateAddress),
                        latestSlotAddress = Hex(metadata.LatestSlotAddress),
                        playerDataSize = metadata.PlayerData.Size,
                        continuousUpdatesEnabled = true
                    }, jsonOptions));
                    break;
                }

                case "read":
                {
                    if (args.Length < 3)
                        throw new ArgumentException(
                            "read requires metadata: TbclSnapshotReader read <pid> <metadata.json>");

                    ResolvedMetadata metadata = JsonSerializer.Deserialize<ResolvedMetadata>(
                        File.ReadAllText(args[2]), jsonOptions)
                        ?? throw new InvalidOperationException("Invalid metadata JSON");

                    object result = ReadSnapshot(pid, metadata);
                    Console.WriteLine(JsonSerializer.Serialize(result, jsonOptions));
                    break;
                }

                default:
                    throw new ArgumentException($"Unknown command '{args[0]}'. Use resolve or read.");
            }
        }
        catch (Exception error)
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                status = "error",
                message = error.Message
            }, jsonOptions));
            Environment.ExitCode = 1;
        }
    }

    static object ResolvePalette(int pid)
    {
        using Process process = ValidateProcess(pid);
        long started = process.StartTime.ToUniversalTime().Ticks;
        using DataTarget target = DataTarget.CreateSnapshotAndAttach(pid);
        using ClrRuntime runtime = (target.ClrVersions.FirstOrDefault()
            ?? throw new InvalidOperationException("CoreCLR not found")).CreateRuntime();
        var candidates = runtime.EnumerateModules()
            .Where(m => string.Equals(Path.GetFileName(m.Name), NebulaModuleName, StringComparison.OrdinalIgnoreCase))
            .Select(m => (module: m, field: m.GetTypeByName("Nebula.Modules.Cosmetics.DynamicPalette")?.GetStaticFieldByName("PlayerColors")))
            .Where(x => x.field != null)
            .Select(x => (x.module, field: x.field!, array: x.field!.ReadObject(x.module.AppDomain)))
            .Where(x => x.array.IsArray && x.array.AsArray().Length == 32).ToArray();
        if (candidates.Length != 1) throw new InvalidOperationException("NoS color palette is not initialized or is ambiguous");
        var source = candidates[0];
        var type = source.array.Type!;
        var color = type.ComponentType ?? throw new InvalidOperationException("NoS color component type missing");
        int Channel(ClrType valueType, string name, int depth = 0)
        {
            if (depth > 2) throw new InvalidOperationException("Unsupported NoS color fields");
            var direct = valueType.Fields.FirstOrDefault(f => f.ElementType == ClrElementType.Float &&
                (f.Name?.Equals(name, StringComparison.OrdinalIgnoreCase) == true || f.Name == $"<{name}>k__BackingField"));
            if (direct != null) return direct.Offset;
            var nested = valueType.Fields.Where(f => f.ElementType == ClrElementType.Struct && f.Type != null).ToArray();
            if (nested.Length == 1) return nested[0].Offset + Channel(nested[0].Type!, name, depth + 1);
            throw new InvalidOperationException($"NoS color channel {name} is unavailable");
        }
        var metadata = new {
            pid, pointerSize = target.DataReader.PointerSize,
            arraySlot = source.field.GetAddress(source.module.AppDomain),
            arrayType = type.MethodTable, arrayLengthOffset = target.DataReader.PointerSize,
            arrayDataOffset = type.GetArrayElementAddress(source.array.Address, 0) - source.array.Address,
            stride = type.ComponentSize, r = Channel(color, "R"), g = Channel(color, "G"), b = Channel(color, "B")
        };
        ValidateProcessUnchanged(pid, started);
        return metadata;
    }

    static ResolvedMetadata Resolve(int pid)
    {
        using Process process = ValidateProcess(pid);
        long started = process.StartTime.ToUniversalTime().Ticks;

        using DataTarget target = DataTarget.CreateSnapshotAndAttach(pid);
        ClrInfo info = target.ClrVersions.FirstOrDefault()
            ?? throw new InvalidOperationException("CoreCLR not found");
        using ClrRuntime runtime = info.CreateRuntime();

        var candidates = runtime.EnumerateModules()
            .Where(m => string.Equals(Path.GetFileName(m.Name), NebulaModuleName, StringComparison.OrdinalIgnoreCase)).ToArray();
        var modules = candidates
            .Where(m => m.GetTypeByName(TbclTypeName)?.GetStaticFieldByName("RequireUpdate") != null)
            .ToArray();
        if (modules.Length != 1) throw new InvalidOperationException($"Expected one {TbclTypeName} module, found {modules.Length}. " +
            string.Join("; ", candidates.Select(m => $"{m.Name}: type={m.GetTypeByName(TbclTypeName) != null}, initialized={m.GetTypeByName(TbclTypeName)?.GetStaticFieldByName("RequireUpdate")?.IsInitialized(m.AppDomain)}")));
        ClrModule module = modules[0];

        ClrType tbcl = module.GetTypeByName(TbclTypeName)
            ?? throw new InvalidOperationException($"{TbclTypeName} type not found");

        ClrStaticField requireUpdate = tbcl.GetStaticFieldByName("RequireUpdate")
            ?? throw new InvalidOperationException("RequireUpdate static field not found");
        ClrStaticField latest = tbcl.GetStaticFieldByName("Latest")
            ?? throw new InvalidOperationException("Latest static field not found");
        if (tbcl.IsCollectible || requireUpdate.ElementType != ClrElementType.Boolean ||
            latest.ElementType != ClrElementType.Pointer)
            throw new InvalidOperationException("Unsupported TBCL static fields");

        // ClrMD classifies a pointer-typed static (Snapshot* Latest) as an object reference and
        // resolves it against the GC static base, which yields an unrelated address.
        // RequireUpdate is a primitive, so it resolves against the correct non-GC static base;
        // derive that base from it and apply Latest's own offset.
        ulong requireUpdateAddress = requireUpdate.GetAddress(module.AppDomain);
        if (requireUpdateAddress == 0)
            throw new InvalidOperationException("Failed to resolve TBCLFields.RequireUpdate address");
        if (requireUpdate.Offset < 0 || latest.Offset < 0)
            throw new InvalidOperationException("Failed to resolve TBCL static field offsets");
        if (requireUpdateAddress <= (ulong)requireUpdate.Offset)
            throw new InvalidOperationException("Unexpected TBCL non-GC static base");

        ulong nonGcStaticBase = requireUpdateAddress - (ulong)requireUpdate.Offset;
        ulong latestSlotAddress = nonGcStaticBase + (ulong)latest.Offset;

        ClrType snapshot = ResolveNestedType(module, SnapshotTypeName, "Snapshot");
        ClrType playerData = ResolveNestedType(module, PlayerDataTypeName, "PlayerData");

        var snapshotLayout = new SnapshotLayout
        {
            LocalMicPositionX = RequiredField(snapshot, "LocalMicPositionX").Offset,
            LocalMicPositionY = RequiredField(snapshot, "LocalMicPositionY").Offset,
            PlayersLength = RequiredField(snapshot, "PlayersLength").Offset,
            Players = RequiredField(snapshot, "Players").Offset
        };

        var playerLayout = new PlayerDataLayout
        {
            PlayerId = RequiredField(playerData, "PlayerId").Offset,
            IsKiller = RequiredField(playerData, "IsKiller").Offset,
            IsImpostor = RequiredField(playerData, "IsImpostor").Offset,
            IsCrewmate = RequiredField(playerData, "IsCrewmate").Offset,
            IsNeutral = RequiredField(playerData, "IsNeutral").Offset,
            IsImpostorlike = RequiredField(playerData, "IsImpostorlike").Offset,
            SpeakerPositionX = RequiredField(playerData, "SpeakerPositionX").Offset,
            SpeakerPositionY = RequiredField(playerData, "SpeakerPositionY").Offset,
            NameLength = RequiredField(playerData, "NameLength").Offset,
            Name = RequiredField(playerData, "Name").Offset,
            ColorR = RequiredField(playerData, "ColorR").Offset,
            ColorG = RequiredField(playerData, "ColorG").Offset,
            ColorB = RequiredField(playerData, "ColorB").Offset
        };

        // ColorB is the last field and is a float.  The current PlayerData ABI has max alignment 4.
        // Deriving size from the resolved last-field offset keeps read mode independent from ClrMD.
        playerLayout.Size = AlignUp(checked(playerLayout.ColorB + sizeof(float)), 4);

        ValidateLayout(snapshotLayout, playerLayout, target.DataReader.PointerSize);
        ValidateProcessUnchanged(pid, started);

        return new ResolvedMetadata
        {
            Pid = pid,
            ProcessStartUtcTicks = started,
            PointerSize = target.DataReader.PointerSize,
            SchemaVersion = ExpectedSchemaVersion,
            RequireUpdateAddress = requireUpdateAddress,
            LatestSlotAddress = latestSlotAddress,
            Snapshot = snapshotLayout,
            PlayerData = playerLayout
        };
    }

    static void EnableContinuousUpdates(int pid, ResolvedMetadata metadata)
    {
        using Process process = ValidateProcess(pid);
        long started = process.StartTime.ToUniversalTime().Ticks;
        ValidateMetadata(pid, started, metadata);

        using SafeProcessHandle handle = Native.OpenProcess(
            Native.ProcessAccess.QueryInformation |
            Native.ProcessAccess.VmWrite |
            Native.ProcessAccess.VmOperation,
            false,
            pid);

        if (handle.IsInvalid)
            throw new InvalidOperationException($"OpenProcess for update enable failed: Win32 error {Marshal.GetLastWin32Error()}");

        // TBCLFields treats RequireUpdate as a persistent enable flag.
        // Set it once for this Among Us process lifetime; read mode never touches it.
        WriteByte(handle, metadata.RequireUpdateAddress, 1);
        ValidateProcessUnchanged(pid, started);
    }

    static object ReadSnapshot(int pid, ResolvedMetadata metadata)
    {
        using Process process = ValidateProcess(pid);
        long started = process.StartTime.ToUniversalTime().Ticks;

        ValidateMetadata(pid, started, metadata);

        using SafeProcessHandle handle = Native.OpenProcess(
            Native.ProcessAccess.QueryInformation |
            Native.ProcessAccess.VmRead,
            false,
            pid);

        if (handle.IsInvalid)
            throw new InvalidOperationException($"OpenProcess failed: Win32 error {Marshal.GetLastWin32Error()}");

        // RequireUpdate is a persistent enable flag and was set by resolve.
        // read is intentionally read-only: it simply consumes the latest published slot.
        ulong snapshotAddress = ReadPointer(handle, metadata.LatestSlotAddress, metadata.PointerSize);
        if (snapshotAddress == 0)
            throw new InvalidOperationException(
                "TBCL Latest is null. The first snapshot may not have been published yet, or resolve was not run for this process.");

        // Latest is published only after the selected unmanaged slot has been fully written.
        // The implementation uses a 64-slot ring, so the selected slot remains stable long
        // enough for this small read operation under normal update rates.
        float localX = ReadSingle(handle, checked(snapshotAddress + (ulong)metadata.Snapshot.LocalMicPositionX));
        float localY = ReadSingle(handle, checked(snapshotAddress + (ulong)metadata.Snapshot.LocalMicPositionY));
        int length = ReadInt32(handle, checked(snapshotAddress + (ulong)metadata.Snapshot.PlayersLength));
        ulong playersAddress = ReadPointer(handle, checked(snapshotAddress + (ulong)metadata.Snapshot.Players), metadata.PointerSize);

        if (length < 0 || length > PlayersCapacity)
            throw new InvalidOperationException($"Unexpected PlayersLength: {length}");
        if (length > 0 && playersAddress == 0)
            throw new InvalidOperationException("Snapshot.Players is null while PlayersLength is non-zero");

        int byteCount = checked(length * metadata.PlayerData.Size);
        byte[] payload = byteCount == 0
            ? Array.Empty<byte>()
            : ReadBytes(handle, playersAddress, byteCount);

        var players = new List<object>(length);
        for (int i = 0; i < length; i++)
            players.Add(ParsePlayer(payload, i * metadata.PlayerData.Size, metadata.PlayerData));

        ValidateProcessUnchanged(pid, started);

        return new
        {
            status = "ok",
            pid,
            capturedAt = DateTimeOffset.UtcNow.ToString("O"),
            schemaVersion = metadata.SchemaVersion,
            snapshotAddress = Hex(snapshotAddress),
            playersAddress = Hex(playersAddress),
            localMicPosition = new { x = localX, y = localY },
            players
        };
    }

    static object ParsePlayer(byte[] bytes, int start, PlayerDataLayout layout)
    {
        byte U8(int offset) => bytes[start + offset];
        bool Bool(int offset) => U8(offset) != 0;
        float F32(int offset) => BitConverter.ToSingle(bytes, start + offset);

        int nameLength = Math.Min((int)U8(layout.NameLength), NameCapacity);
        int nameBytes = checked(nameLength * sizeof(char));

        if (layout.Name < 0 || layout.Name + nameBytes > layout.Size)
            throw new InvalidOperationException("Name buffer exceeds PlayerData element size");

        string name = nameBytes == 0
            ? string.Empty
            : Encoding.Unicode.GetString(bytes, start + layout.Name, nameBytes);

        return new
        {
            playerId = U8(layout.PlayerId),
            isKiller = Bool(layout.IsKiller),
            isImpostor = Bool(layout.IsImpostor),
            isCrewmate = Bool(layout.IsCrewmate),
            isNeutral = Bool(layout.IsNeutral),
            isImpostorlike = Bool(layout.IsImpostorlike),
            speakerPositionX = F32(layout.SpeakerPositionX),
            speakerPositionY = F32(layout.SpeakerPositionY),
            name,
            colorR = F32(layout.ColorR),
            colorG = F32(layout.ColorG),
            colorB = F32(layout.ColorB)
        };
    }

    static void ValidateMetadata(int pid, long started, ResolvedMetadata metadata)
    {
        if (metadata.Pid != pid)
            throw new InvalidOperationException($"Metadata was resolved for PID {metadata.Pid}, not {pid}");
        if (metadata.ProcessStartUtcTicks != started)
            throw new InvalidOperationException("The Among Us process has restarted. Run resolve again.");
        if (metadata.PointerSize is not (4 or 8))
            throw new InvalidOperationException("Invalid pointer size in metadata");
        if (metadata.SchemaVersion != ExpectedSchemaVersion)
            throw new InvalidOperationException($"Unsupported TBCL schema version {metadata.SchemaVersion}");

        ValidateLayout(metadata.Snapshot, metadata.PlayerData, metadata.PointerSize);
    }

    static void ValidateLayout(SnapshotLayout snapshot, PlayerDataLayout player, int pointerSize)
    {
        int[] snapshotOffsets =
        [
            snapshot.LocalMicPositionX,
            snapshot.LocalMicPositionY,
            snapshot.PlayersLength,
            snapshot.Players
        ];
        if (snapshotOffsets.Any(x => x < 0))
            throw new InvalidOperationException("Invalid Snapshot layout metadata");

        int[] playerOffsets =
        [
            player.PlayerId, player.IsKiller, player.IsImpostor, player.IsCrewmate,
            player.IsNeutral, player.IsImpostorlike, player.SpeakerPositionX,
            player.SpeakerPositionY, player.NameLength, player.Name,
            player.ColorR, player.ColorG, player.ColorB
        ];
        if (playerOffsets.Any(x => x < 0) || player.Size <= 0)
            throw new InvalidOperationException("Invalid PlayerData layout metadata");

        if (player.Name + NameCapacity * sizeof(char) > player.Size)
            throw new InvalidOperationException("Resolved Name[32] does not fit inside PlayerData");
        if (snapshot.Players % pointerSize != 0)
            throw new InvalidOperationException("Snapshot.Players is unexpectedly unaligned");
    }

    static ClrType ResolveNestedType(ClrModule module, string fullName, string shortName)
    {
        ClrType? type = module.GetTypeByName(fullName);
        if (type is not null)
            return type;

        // Some ClrMD/runtime combinations can spell nested types differently.
        string alternate = fullName.Replace('+', '.');
        type = module.GetTypeByName(alternate);
        if (type is not null)
            return type;

        throw new InvalidOperationException($"Could not resolve nested TBCL type {shortName}");
    }

    static Process ValidateProcess(int pid)
    {
        Process process = Process.GetProcessById(pid);
        if (!string.Equals(process.ProcessName, "Among Us", StringComparison.OrdinalIgnoreCase))
        {
            process.Dispose();
            throw new InvalidOperationException("Among Us process required");
        }

        return process;
    }

    static void ValidateProcessUnchanged(int pid, long started)
    {
        using Process current = Process.GetProcessById(pid);
        if (current.StartTime.ToUniversalTime().Ticks != started)
            throw new InvalidOperationException("Process changed while reading");
    }

    static ClrInstanceField RequiredField(ClrType type, string name) =>
        type.GetFieldByName(name)
        ?? throw new InvalidOperationException($"Field {type.Name}.{name} not found");

    static int AlignUp(int value, int alignment) =>
        checked((value + alignment - 1) / alignment * alignment);

    static string Hex(ulong address) => $"0x{address:X}";

    static byte[] ReadBytes(SafeProcessHandle process, ulong address, int count)
    {
        if (count < 0)
            throw new ArgumentOutOfRangeException(nameof(count));
        if (count == 0)
            return Array.Empty<byte>();

        byte[] buffer = new byte[count];
        if (!Native.ReadProcessMemory(process, (nint)address, buffer, (nuint)buffer.Length, out nuint read)
            || read != (nuint)buffer.Length)
        {
            throw new InvalidOperationException(
                $"ReadProcessMemory(0x{address:X}, {count}) failed: Win32 error {Marshal.GetLastWin32Error()}, read={read}");
        }

        return buffer;
    }

    static int ReadInt32(SafeProcessHandle process, ulong address) =>
        BitConverter.ToInt32(ReadBytes(process, address, sizeof(int)), 0);

    static float ReadSingle(SafeProcessHandle process, ulong address) =>
        BitConverter.ToSingle(ReadBytes(process, address, sizeof(float)), 0);

    static ulong ReadPointer(SafeProcessHandle process, ulong address, int pointerSize)
    {
        byte[] bytes = ReadBytes(process, address, pointerSize);
        return pointerSize == 4
            ? BitConverter.ToUInt32(bytes, 0)
            : BitConverter.ToUInt64(bytes, 0);
    }

    static void WriteByte(SafeProcessHandle process, ulong address, byte value)
    {
        byte[] buffer = [value];
        if (!Native.WriteProcessMemory(process, (nint)address, buffer, 1, out nuint written)
            || written != 1)
        {
            throw new InvalidOperationException(
                $"WriteProcessMemory(0x{address:X}) failed: Win32 error {Marshal.GetLastWin32Error()}, written={written}");
        }
    }

    sealed class ResolvedMetadata
    {
        public int Pid { get; set; }
        public long ProcessStartUtcTicks { get; set; }
        public int PointerSize { get; set; }
        public int SchemaVersion { get; set; }
        public ulong RequireUpdateAddress { get; set; }
        public ulong LatestSlotAddress { get; set; }
        public SnapshotLayout Snapshot { get; set; } = new();
        public PlayerDataLayout PlayerData { get; set; } = new();
    }

    sealed class SnapshotLayout
    {
        public int LocalMicPositionX { get; set; }
        public int LocalMicPositionY { get; set; }
        public int PlayersLength { get; set; }
        public int Players { get; set; }
    }

    sealed class PlayerDataLayout
    {
        public int Size { get; set; }
        public int PlayerId { get; set; }
        public int IsKiller { get; set; }
        public int IsImpostor { get; set; }
        public int IsCrewmate { get; set; }
        public int IsNeutral { get; set; }
        public int IsImpostorlike { get; set; }
        public int SpeakerPositionX { get; set; }
        public int SpeakerPositionY { get; set; }
        public int NameLength { get; set; }
        public int Name { get; set; }
        public int ColorR { get; set; }
        public int ColorG { get; set; }
        public int ColorB { get; set; }
    }

    static class Native
    {
        [Flags]
        internal enum ProcessAccess : uint
        {
            VmOperation = 0x0008,
            VmRead = 0x0010,
            VmWrite = 0x0020,
            QueryInformation = 0x0400
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeProcessHandle OpenProcess(
            ProcessAccess dwDesiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
            int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadProcessMemory(
            SafeProcessHandle hProcess,
            nint lpBaseAddress,
            [Out] byte[] lpBuffer,
            nuint nSize,
            out nuint lpNumberOfBytesRead);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool WriteProcessMemory(
            SafeProcessHandle hProcess,
            nint lpBaseAddress,
            byte[] lpBuffer,
            nuint nSize,
            out nuint lpNumberOfBytesWritten);
    }
}
