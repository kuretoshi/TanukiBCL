# TbclSnapshotReader

This helper resolves and reads NoS `Nebula.Collab.TBCLFields` without writing to the Among Us process. NoS v3.5.3 removed `RequireUpdate` and publishes snapshots continuously.

## Commands

```powershell
TbclSnapshotReader.exe layout <PID>
TbclSnapshotReader.exe palette <PID>
TbclSnapshotReader.exe roles <PID>
TbclSnapshotReader.exe resolve <PID> [tbcl-metadata.json]
TbclSnapshotReader.exe read <PID> tbcl-metadata.json
```

`layout` and `resolve` use ClrMD to find the `Latest` slot and nested structure offsets. ClrMD resolves the pointer-typed `Latest` field against the GC static base, which is incorrect for this field. The primitive `nextIndex` field provides the non-GC static base; its address minus its offset plus `Latest`'s offset yields the correct slot.

`palette` resolves `DynamicPalette.PlayerColors` and its RGB offsets. `read` consumes the published unmanaged snapshot using `PROCESS_VM_READ | PROCESS_QUERY_INFORMATION`. None of these commands requests write access or calls `WriteProcessMemory`.

Metadata is bound to the PID and process start time. Resolve again after the game restarts. The helper is built for both `win-x86` and `win-x64` by `scripts/build-nos-reader.ps1`; the app selects the executable matching the game architecture.

`roles` reads `NebulaGameManager.instance.allModPlayers` and each player's `myRole` from a managed process snapshot. It resolves stored role definitions or the enclosing role's static `MyRole`, and reads translated names without invoking MOD getters. Addon roles use their loaded module's metadata. The app requests this command during an active NoS game, with at least two seconds between requests; results expire after five seconds and are cleared on session/process changes. Unknown definitions retain their runtime class without guessing a role name.

For Berserker, `bodyLayout` resolves native PlayerControl identity/cosmetics and CosmeticsLayer bodyType fields using initialized IL2CPP FieldInfo metadata. Field names, parent classes and player ID are validated; no IL2CPP functions are invoked. The app reads bodyType each game tick and requires the role name `berserker` and bodyType 2 to enable the low voice effect. Changed identity/class, read errors or expired role metadata disable that effect. The lobby switch can disable it; meetings/death/lobby also bypass the effect. This is independent of TBCLFields team/voice routing rules.

NoS v3.5.3.6 adds TBCLFields schema `20261009`: `BodyType` (int32) and `NeckLength` (float32) are resolved by field metadata and sampled with the same coherent publication as the remaining PlayerData. Current layouts require both fields; older layouts remain supported. The renderer uses published BodyType in preference to legacy native CosmeticsLayer probing. Rokurokubi requires BodyType 3 plus a finite positive NeckLength; pitch rises smoothly to at most 2x while the source/filter processor preserves the estimated formant envelope. Berserker requires its role plus BodyType 2 and uses a separate distortion / short-room-reverb audio graph. Death, meetings, disconnection and unreadable publications disable these effects. Both abilities have independent lobby switches, and the debug screen displays the published body and neck values.
