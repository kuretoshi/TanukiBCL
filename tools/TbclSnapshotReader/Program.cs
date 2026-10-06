using Microsoft.Diagnostics.Runtime;
using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

internal static class Program
{
    const string NebulaModuleName = "Nebula.dll";
    const string TbclTypeName = "Nebula.Collab.TBCLFields";
    const string SnapshotTypeName = "Nebula.Collab.TBCLFields+Snapshot";
    const string PlayerDataTypeName = "Nebula.Collab.TBCLFields+PlayerData";
    const string RadioDataTypeName = "Nebula.Collab.TBCLFields+RadioData";
    const int ExpectedSchemaVersion = 20260918;
    const int CostumeSchemaVersion = 20261005;
    const int PlayersCapacity = 24;
    const int RadiosCapacity = 8;
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
                    Console.WriteLine(JsonSerializer.Serialize(new { status = "ok", pid, metadata }, jsonOptions));
                    break;
                }
                case "resolve":
                {
                    string outputPath = args.Length >= 3 ? args[2] : "tbcl-metadata.json";
                    ResolvedMetadata metadata = Resolve(pid);
                    File.WriteAllText(outputPath, JsonSerializer.Serialize(metadata, jsonOptions), Encoding.UTF8);

                    Console.WriteLine(JsonSerializer.Serialize(new
                    {
                        status = "ok",
                        mode = "resolve",
                        pid,
                        metadata = Path.GetFullPath(outputPath),
                        latestSlotAddress = Hex(metadata.LatestSlotAddress),
                        playerDataSize = metadata.PlayerData.Size
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
            .Where(m => m.GetTypeByName(TbclTypeName)?.GetStaticFieldByName("Latest") != null)
            .ToArray();
        if (modules.Length != 1) throw new InvalidOperationException($"Expected one {TbclTypeName} module, found {modules.Length}. " +
            string.Join("; ", candidates.Select(m => $"{m.Name}: type={m.GetTypeByName(TbclTypeName) != null}, initialized={m.GetTypeByName(TbclTypeName)?.GetStaticFieldByName("Latest")?.IsInitialized(m.AppDomain)}")));
        ClrModule module = modules[0];

        ClrType tbcl = module.GetTypeByName(TbclTypeName)
            ?? throw new InvalidOperationException($"{TbclTypeName} type not found");

        ClrStaticField nextIndex = tbcl.GetStaticFieldByName("nextIndex")
            ?? throw new InvalidOperationException("TBCLFields.nextIndex static field not found");
        ClrStaticField latest = tbcl.GetStaticFieldByName("Latest")
            ?? throw new InvalidOperationException("Latest static field not found");
        if (tbcl.IsCollectible || nextIndex.ElementType != ClrElementType.Int32 || latest.ElementType != ClrElementType.Pointer)
            throw new InvalidOperationException("Unsupported TBCL static fields");

        // ClrMD classifies a pointer-typed static (Snapshot* Latest) as an object reference and
        // resolves it against the GC static base, which yields an unrelated address.
        // nextIndex is a primitive and resolves against the correct non-GC static base.
        ulong anchorAddress = nextIndex.GetAddress(module.AppDomain);
        if (anchorAddress == 0)
            throw new InvalidOperationException("Failed to resolve TBCLFields.nextIndex address");
        if (nextIndex.Offset < 0 || latest.Offset < 0)
            throw new InvalidOperationException("Failed to resolve TBCL static field offsets");
        if (anchorAddress <= (ulong)nextIndex.Offset)
            throw new InvalidOperationException("Unexpected TBCL non-GC static base");

        ulong nonGcStaticBase = anchorAddress - (ulong)nextIndex.Offset;
        ulong latestSlotAddress = nonGcStaticBase + (ulong)latest.Offset;

        ClrType snapshot = ResolveNestedType(module, SnapshotTypeName, "Snapshot");
        ClrType playerData = ResolveNestedType(module, PlayerDataTypeName, "PlayerData");
        ClrType? radioData = TryResolveNestedType(module, RadioDataTypeName);

        ClrInstanceField? radiosLength = snapshot.GetFieldByName("RadiosLength");
        ClrInstanceField? radios = snapshot.GetFieldByName("Radios");
        if ((radiosLength is null) != (radios is null) || (radiosLength is not null && radioData is null))
            throw new InvalidOperationException("Incomplete NoS radio snapshot layout");

        var snapshotLayout = new SnapshotLayout
        {
            LocalMicPositionX = RequiredField(snapshot, "LocalMicPositionX").Offset,
            LocalMicPositionY = RequiredField(snapshot, "LocalMicPositionY").Offset,
            PlayersLength = RequiredField(snapshot, "PlayersLength").Offset,
            Players = RequiredField(snapshot, "Players").Offset,
            RadiosLength = radiosLength?.Offset,
            Radios = radios?.Offset
        };

        var playerLayout = new PlayerDataLayout
        {
            Skin = ResolveCostumeLayout(playerData, "Skin"),
            Hat = ResolveCostumeLayout(playerData, "Hat"),
            Visor = ResolveCostumeLayout(playerData, "Visor"),
            PlayerId = RequiredField(playerData, "PlayerId").Offset,
            IsKiller = RequiredField(playerData, "IsKiller").Offset,
            IsImpostor = RequiredField(playerData, "IsImpostor").Offset,
            IsCrewmate = RequiredField(playerData, "IsCrewmate").Offset,
            IsNeutral = RequiredField(playerData, "IsNeutral").Offset,
            IsImpostorlike = RequiredField(playerData, "IsImpostorlike").Offset,
            SpeakerPositionX = RequiredField(playerData, "SpeakerPositionX").Offset,
            SpeakerPositionY = RequiredField(playerData, "SpeakerPositionY").Offset,
            BodyRateX = playerData.GetFieldByName("BodyRateX")?.Offset,
            BodyRateY = playerData.GetFieldByName("BodyRateY")?.Offset,
            IsJammed = playerData.GetFieldByName("IsJammed")?.Offset,
            NameLength = RequiredField(playerData, "NameLength").Offset,
            Name = RequiredField(playerData, "Name").Offset,
            ColorR = RequiredField(playerData, "ColorR").Offset,
            ColorG = RequiredField(playerData, "ColorG").Offset,
            ColorB = RequiredField(playerData, "ColorB").Offset
        };
		if ((playerLayout.BodyRateX is null) != (playerLayout.BodyRateY is null))
			throw new InvalidOperationException("Incomplete NoS BodyRate layout");

		playerLayout.Size = AlignUp(new[]
		{
			playerLayout.Name + NameCapacity * sizeof(char),
			playerLayout.ColorB + sizeof(float),
			(playerLayout.BodyRateX ?? 0) + sizeof(float),
			(playerLayout.BodyRateY ?? 0) + sizeof(float),
			(playerLayout.IsJammed ?? 0) + sizeof(byte),
            playerLayout.Skin is { } skin ? skin.Offset + skin.Size : 0,
            playerLayout.Hat is { } hat ? hat.Offset + hat.Size : 0,
            playerLayout.Visor is { } visor ? visor.Offset + visor.Size : 0
		}.Max(), 4);

		RadioDataLayout? radioLayout = null;
		if (radioData is not null)
		{
			radioLayout = new RadioDataLayout
			{
				Kind = RequiredField(radioData, "Kind").Offset,
				HearableMask = RequiredField(radioData, "HearableMask").Offset,
				NameLength = RequiredField(radioData, "NameLength").Offset,
				Name = RequiredField(radioData, "Name").Offset
			};
			radioLayout.Size = AlignUp(new[]
			{
				radioLayout.Kind + sizeof(int),
				radioLayout.HearableMask + sizeof(int),
				radioLayout.NameLength + sizeof(byte),
				radioLayout.Name + NameCapacity * sizeof(char)
			}.Max(), 4);
		}

        ValidateLayout(snapshotLayout, playerLayout, radioLayout, target.DataReader.PointerSize);
        ValidateProcessUnchanged(pid, started);

        return new ResolvedMetadata
        {
            Pid = pid,
            ProcessStartUtcTicks = started,
            PointerSize = target.DataReader.PointerSize,
            SchemaVersion = ReadSchemaVersion(playerData.Module, playerLayout.Skin is not null),
            LatestSlotAddress = latestSlotAddress,
            Snapshot = snapshotLayout,
            PlayerData = playerLayout,
            RadioData = radioLayout
        };
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

        // NoS publishes continuously; read only consumes the latest published slot.
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

		int radioLength = metadata.Snapshot.RadiosLength is int radioLengthOffset
			? ReadInt32(handle, checked(snapshotAddress + (ulong)radioLengthOffset))
			: 0;
		ulong radiosAddress = metadata.Snapshot.Radios is int radiosOffset
			? ReadPointer(handle, checked(snapshotAddress + (ulong)radiosOffset), metadata.PointerSize)
			: 0;
		if (radioLength < 0 || radioLength > RadiosCapacity || (radioLength > 0 && radiosAddress == 0))
			throw new InvalidOperationException($"Unexpected RadiosLength or Radios pointer: {radioLength}");
		var radios = new List<object>(radioLength);
		if (radioLength > 0 && metadata.RadioData is RadioDataLayout radioLayout)
		{
			byte[] radioPayload = ReadBytes(handle, radiosAddress, checked(radioLength * radioLayout.Size));
			for (int i = 0; i < radioLength; i++)
			{
				int start = i * radioLayout.Size;
				int nameLength = Math.Min((int)radioPayload[start + radioLayout.NameLength], NameCapacity);
				radios.Add(new
				{
					kind = BitConverter.ToInt32(radioPayload, start + radioLayout.Kind),
					hearableMask = BitConverter.ToInt32(radioPayload, start + radioLayout.HearableMask),
					name = Encoding.Unicode.GetString(radioPayload, start + radioLayout.Name, nameLength * sizeof(char))
				});
			}
		}

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
            players,
			radios
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
            skin = ParseCostume(bytes, start, layout.Skin),
            hat = ParseCostume(bytes, start, layout.Hat),
            visor = ParseCostume(bytes, start, layout.Visor),
            playerId = U8(layout.PlayerId),
            isKiller = Bool(layout.IsKiller),
            isImpostor = Bool(layout.IsImpostor),
            isCrewmate = Bool(layout.IsCrewmate),
            isNeutral = Bool(layout.IsNeutral),
            isImpostorlike = Bool(layout.IsImpostorlike),
			isJammed = layout.IsJammed is int offset ? Bool(offset) : (bool?)null,
            speakerPositionX = F32(layout.SpeakerPositionX),
            speakerPositionY = F32(layout.SpeakerPositionY),
            name,
            colorR = F32(layout.ColorR),
            colorG = F32(layout.ColorG),
            colorB = F32(layout.ColorB)
        };
    }

    static int ReadSchemaVersion(ClrModule module, bool hasCostumes)
    {
        using var assembly = File.OpenRead(module.Name!);
        using var pe = new PEReader(assembly);
        var reader = pe.GetMetadataReader();
        foreach (var handle in reader.TypeDefinitions) {
            var type = reader.GetTypeDefinition(handle);
            if (reader.GetString(type.Name) != "TBCLFields" || reader.GetString(type.Namespace) != "Nebula.Collab") continue;
            foreach (var fieldHandle in type.GetFields()) {
                var field = reader.GetFieldDefinition(fieldHandle);
                if (reader.GetString(field.Name) != "Version") continue;
                var constantHandle = field.GetDefaultValue();
                if (constantHandle.IsNil) break;
                var constant = reader.GetConstant(constantHandle);
                if (constant.TypeCode == ConstantTypeCode.Int32) return reader.GetBlobReader(constant.Value).ReadInt32();
            }
        }
        return hasCostumes ? CostumeSchemaVersion : ExpectedSchemaVersion;
    }

    static CostumeLayout? ResolveCostumeLayout(ClrType player, string name)
    {
        var field = player.GetFieldByName(name);
        if (field is null) return null;
        var type = field.Type ?? throw new InvalidOperationException($"Missing {name} costume type");
        var buffer = RequiredField(type, "Name");
        var length = RequiredField(type, "NameLength");
        // ClrMD reports only the first char for a fixed buffer field, and StaticSize includes object headers.
        var bufferType = buffer.Type ?? throw new InvalidOperationException("Missing costume name buffer type");
        using var assembly = File.OpenRead(bufferType.Module.Name!);
        using var pe = new PEReader(assembly);
        int bufferSize = pe.GetMetadataReader().GetTypeDefinition(MetadataTokens.TypeDefinitionHandle((int)(bufferType.MetadataToken & 0x00ffffff))).GetLayout().Size;
        int capacity = bufferSize / sizeof(char);
        if (capacity <= 0 || capacity > 1024) throw new InvalidOperationException($"Invalid {name} name capacity");
        return new CostumeLayout { Offset = field.Offset, NameLength = length.Offset, Name = buffer.Offset, Capacity = capacity, Size = Math.Max(length.Offset + 1, buffer.Offset + bufferSize) };
    }

    static object? ParseCostume(byte[] bytes, int start, CostumeLayout? costume)
    {
        if (costume is null) return null;
        int offset = start + costume.Offset;
        int length = bytes[offset + costume.NameLength];
        if (length > costume.Capacity) throw new InvalidOperationException("Invalid costume name length");
        return new { name = Encoding.Unicode.GetString(bytes, offset + costume.Name, length * sizeof(char)) };
    }

    static void ValidateMetadata(int pid, long started, ResolvedMetadata metadata)
    {
        if (metadata.Pid != pid)
            throw new InvalidOperationException($"Metadata was resolved for PID {metadata.Pid}, not {pid}");
        if (metadata.ProcessStartUtcTicks != started)
            throw new InvalidOperationException("The Among Us process has restarted. Run resolve again.");
        if (metadata.PointerSize is not (4 or 8))
            throw new InvalidOperationException("Invalid pointer size in metadata");
        if (metadata.SchemaVersion != ExpectedSchemaVersion && metadata.SchemaVersion != 20260928 && metadata.SchemaVersion != CostumeSchemaVersion)
            throw new InvalidOperationException($"Unsupported TBCL schema version {metadata.SchemaVersion}");

        ValidateLayout(metadata.Snapshot, metadata.PlayerData, metadata.RadioData, metadata.PointerSize);
    }

    static void ValidateLayout(SnapshotLayout snapshot, PlayerDataLayout player, RadioDataLayout? radio, int pointerSize)
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

        var costumes = new[] { player.Skin, player.Hat, player.Visor };
        if (costumes.Any(c => c is not null) && costumes.Any(c => c is null)) throw new InvalidOperationException("Incomplete costume layout");
        foreach (var costume in costumes) {
            if (costume is not null && (costume.Offset < 0 || costume.Capacity <= 0 || costume.Capacity > 1024 || costume.NameLength < 0 || costume.NameLength >= costume.Size || costume.Name < 0 || costume.Name + costume.Capacity * 2 > costume.Size || costume.Offset + costume.Size > player.Size)) throw new InvalidOperationException("Invalid costume layout");
        }
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
		if ((snapshot.RadiosLength is null) != (snapshot.Radios is null) || (snapshot.Radios is not null) != (radio is not null))
			throw new InvalidOperationException("Invalid RadioData layout metadata");
		if (snapshot.Radios is not null && snapshot.Radios.Value % pointerSize != 0)
			throw new InvalidOperationException("Snapshot.Radios is unexpectedly unaligned");
		if (radio is not null && (radio.Size <= 0 || radio.Name + NameCapacity * sizeof(char) > radio.Size))
			throw new InvalidOperationException("Resolved RadioData does not fit its element size");
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

	static ClrType? TryResolveNestedType(ClrModule module, string fullName) =>
		module.GetTypeByName(fullName) ?? module.GetTypeByName(fullName.Replace('+', '.'));

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

    sealed class ResolvedMetadata
    {
        public int Pid { get; set; }
        public long ProcessStartUtcTicks { get; set; }
        public int PointerSize { get; set; }
        public int SchemaVersion { get; set; }
        public ulong LatestSlotAddress { get; set; }
        public SnapshotLayout Snapshot { get; set; } = new();
        public PlayerDataLayout PlayerData { get; set; } = new();
		public RadioDataLayout? RadioData { get; set; }
    }

    sealed class SnapshotLayout
    {
        public int LocalMicPositionX { get; set; }
        public int LocalMicPositionY { get; set; }
        public int PlayersLength { get; set; }
        public int Players { get; set; }
		public int? RadiosLength { get; set; }
		public int? Radios { get; set; }
    }

    sealed class PlayerDataLayout
    {
        public int Size { get; set; }
        public CostumeLayout? Skin { get; set; }
        public CostumeLayout? Hat { get; set; }
        public CostumeLayout? Visor { get; set; }
        public int PlayerId { get; set; }
        public int IsKiller { get; set; }
        public int IsImpostor { get; set; }
        public int IsCrewmate { get; set; }
        public int IsNeutral { get; set; }
        public int IsImpostorlike { get; set; }
        public int SpeakerPositionX { get; set; }
        public int SpeakerPositionY { get; set; }
		public int? BodyRateX { get; set; }
		public int? BodyRateY { get; set; }
        public int? IsJammed { get; set; }
        public int NameLength { get; set; }
        public int Name { get; set; }
        public int ColorR { get; set; }
        public int ColorG { get; set; }
        public int ColorB { get; set; }
    }

    sealed class CostumeLayout
    {
        public int Offset { get; set; }
        public int NameLength { get; set; }
        public int Name { get; set; }
        public int Capacity { get; set; }
        public int Size { get; set; }
    }

	sealed class RadioDataLayout
	{
		public int Size { get; set; }
		public int Kind { get; set; }
		public int HearableMask { get; set; }
		public int NameLength { get; set; }
		public int Name { get; set; }
	}

    static class Native
    {
        [Flags]
        internal enum ProcessAccess : uint
        {
            VmRead = 0x0010,
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

    }
}
