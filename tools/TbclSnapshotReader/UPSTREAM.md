# TbclSnapshotReader (unmanaged TBCLFields edition)

This reader targets the current unmanaged `TBCLFields` layout in Nebula.

The important behavior is that `TBCLFields.RequireUpdate` is a **persistent enable flag**. It only needs to be set to `true` once during the lifetime of a particular Among Us process. After that, Nebula continuously publishes new snapshots through `TBCLFields.Latest`.

## Commands

### 1. Resolve metadata and enable continuous updates

```powershell
TbclSnapshotReader.exe resolve <PID> [tbcl-metadata.json]
```

`resolve` uses ClrMD to resolve:

- static storage address of `TBCLFields.RequireUpdate`
- static storage address of `TBCLFields.Latest`
- `Snapshot` field offsets
- `PlayerData` field offsets and element size

After resolution succeeds, the command writes `RequireUpdate = true` **once** with `WriteProcessMemory`, then saves the metadata JSON.

The metadata is bound to that Among Us process lifetime. If Among Us exits/restarts, run `resolve` again for the new PID/process instance.

### 2. Read the latest snapshot

```powershell
TbclSnapshotReader.exe read <PID> tbcl-metadata.json
```

`read` does **not** use ClrMD and does **not** write to `RequireUpdate`.

It opens the target with read access only and performs:

1. read the current `Latest` pointer
2. read the published unmanaged `Snapshot`
3. read `Players` and `PlayersLength`
4. read the contiguous `PlayerData` block in one `ReadProcessMemory` call

There is no request/acknowledgement cycle per read. Repeated `read` invocations simply observe whatever snapshot Nebula most recently published.

## Process lifetime

Typical use is:

```text
Among Us starts
    ↓
resolve   (ClrMD + RequireUpdate=true once)
    ↓
read
read
read
...
    ↓
Among Us exits
```

After a restart, addresses may change even if the executable and mod are unchanged, so the old metadata file is rejected using PID and process start time checks.

## Why `read` is read-only

The current TBCL design keeps updating while `RequireUpdate` remains `true`. Resetting it to `false` after each read would stop that continuous update behavior. Therefore only `resolve` writes the flag; `read` requests only `PROCESS_VM_READ | PROCESS_QUERY_INFORMATION`.

## Build

Requires .NET 8 SDK on Windows:

```powershell
dotnet publish -c Release
```

Project settings match the existing TanukiBCL reader tooling:

- `net8.0`
- `win-x86`
- self-contained
- `Microsoft.Diagnostics.Runtime` 3.1.512801

## Fixes applied after the first build attempt

The project had never been compiled, and two issues showed up once it was.

### 1. `Math.Min` ambiguity (compile error)

`Math.Min(U8(layout.NameLength), NameCapacity)` was ambiguous between
`Math.Min(byte, byte)` and `Math.Min(int, int)`, because the `NameCapacity`
constant is implicitly convertible to `byte`. The first argument is now cast to
`int` explicitly.

### 2. `Latest` resolved to the wrong address (runtime)

`TBCLFields.Latest` is declared as `Snapshot*`. ClrMD reports such a field as
`System.UIntPtr` / `ClrElementType.Pointer` and treats it as an object
reference, so `ClrStaticField.GetAddress` returns *GC* static base + offset
instead of *non-GC* static base + offset. The returned address landed in the
type's object-reference static table, and `read` decoded a GC heap pointer as
`PlayersLength`.

`RequireUpdate` is a primitive and resolves against the correct non-GC static
base, so `resolve` now derives the base from it:

```csharp
ulong nonGcStaticBase = requireUpdateAddress - (ulong)requireUpdate.Offset;
ulong latestSlotAddress = nonGcStaticBase + (ulong)latest.Offset;
```

Verified against a live Among Us process: `Latest` moved from the bogus
`0xE223E90` to the correct `0x331E9338`, and `read` then decoded the snapshot
correctly.

## Build note

A .NET 8 SDK is not strictly required; a .NET 9 or 10 SDK builds the `net8.0`
`win-x86` self-contained output fine (the targeting/runtime packs are restored
from NuGet).
