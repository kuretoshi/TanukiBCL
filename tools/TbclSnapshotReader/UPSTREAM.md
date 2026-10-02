# TbclSnapshotReader

This helper resolves and reads NoS `Nebula.Collab.TBCLFields` without writing to the Among Us process. NoS v3.5.3 removed `RequireUpdate` and publishes snapshots continuously.

## Commands

```powershell
TbclSnapshotReader.exe layout <PID>
TbclSnapshotReader.exe palette <PID>
TbclSnapshotReader.exe resolve <PID> [tbcl-metadata.json]
TbclSnapshotReader.exe read <PID> tbcl-metadata.json
```

`layout` and `resolve` use ClrMD to find the `Latest` slot and nested structure offsets. ClrMD resolves the pointer-typed `Latest` field against the GC static base, which is incorrect for this field. The primitive `nextIndex` field provides the non-GC static base; its address minus its offset plus `Latest`'s offset yields the correct slot.

`palette` resolves `DynamicPalette.PlayerColors` and its RGB offsets. `read` consumes the published unmanaged snapshot using `PROCESS_VM_READ | PROCESS_QUERY_INFORMATION`. None of these commands requests write access or calls `WriteProcessMemory`.

Metadata is bound to the PID and process start time. Resolve again after the game restarts. The helper is built for both `win-x86` and `win-x64` by `scripts/build-nos-reader.ps1`; the app selects the executable matching the game architecture.
