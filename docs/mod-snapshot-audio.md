# MOD snapshots and voice settings

Lobby settings show `【MOD】SNR設定` only when SNR is detected and `【MOD】NoS設定` only when NoS is detected. All MOD options default to off and use the existing host-owned lobby settings synchronization. Lite follows the host's settings.

- `snrJumboVoice`: SNR `ModifierRoleId.JumboModifier`, including composite modifier flags. Reads the actual `JumboAbility.<_currentSize>k__BackingField` and `JumboData.<MaxSize>k__BackingField` via the player's live ability list. No property getter is executed. Growth is clamped to 0–100%; zero uses normal voice, maximum lowers pitch to 0.4 of the original. Meetings, dead speakers, invalid sizes, and unavailable data remove the effect. Independent of the disguise toggle.
- `jackalHaunting`: Jackal and WaveCannonJackal listeners can hear ghosts during tasks, respecting task mute/distance rules. Uses the existing ghost volume setting.
- `jackalHearOutsideVents`: living Jackal listeners inside a vent can hear outside speakers. This does not enable outside listeners to hear vented Jackals.
- `jackalTalkInVents`: two Jackal teammates inside vents can hear each other, within the normal voice distance.
- `sidekickHaunting` and `sidekickHearOutsideVents`: the corresponding independent permissions for Sidekick and SidekickWaveCannon.
- `sidekickTalkInVents`: enables Sidekick↔Sidekick and Sidekick↔Jackal conversations in both directions. Jackal↔Jackal still follows `jackalTalkInVents`.
- `nosNeutralKillerHaunting`: NoS listeners with exactly `IsNeutral=true`, `IsKiller=true`, and `IsImpostor=false` can hear ghosts during tasks. Other lobby audio restrictions still apply.
- `nosVoicePositions`: opt-in use of NoS's speaker and local microphone coordinates for voice distance, panning and wall checks. Off by default; off or unavailable data uses ordinary player coordinates. This replaces the previous unconditional NoS coordinate override.

The game overlay's NoS avatars use the game state's MOD detection; meeting speaker highlights use the latest NoS RGB while retaining the fixed meeting slot order.

SNR `ExPlayerControl.IsKiller()` exists in the installed DLL, but it is executable logic, not a stored boolean: it checks impostor/Pavlov/Jackal/Hitman cases and invokes `CustomKillButtonAbility.CanKill` delegates. `IsNeutral()` reads the `AssignedTeam` getter and `IsImpostor()` also checks the current Schrodinger's Cat team. The requested exact three-flag ghost predicate cannot be read as fields with the current SNR protocol. Pending SNR-published flags, the existing Jackal/Sidekick ghost settings retain their original behavior and labels rather than claiming broader support.

The SNR Jackal group is exactly `Jackal` and `WaveCannonJackal`; the separate Sidekick group is `Sidekick` and `SidekickWaveCannon`. `JackalFriends` is excluded from both groups. IDs are decoded from the active SNR module rather than hardcoded. SNR sampling works with the debug window closed.

## NoS

NoS uses its own `Nebula.Collab.TBCLFields` publication protocol, not SNR's role or modifier identifiers. The developer-provided reader is preserved in `tools/TbclSnapshotReader`, with its original notes in `UPSTREAM.md`. The integration adds a `layout` command returning metadata on stdout. It enables `RequireUpdate` once, then the app reads the unmanaged `Latest` snapshot directly without spawning a process or taking a ClrMD snapshot every frame.

The supplied schema (20260918) contains `PlayerId`, UTF-16 `Name[32]`, RGB color, speaker position, and `IsKiller`, `IsImpostor`, `IsCrewmate`, `IsNeutral`, `IsImpostorlike`. It has no role name/ID or cosmetic/skin fields. These cannot be inferred from faction flags. The app retains the NoS payload separately as `nosPlayer`, maps the authoritative team flags for audio, and uses the published microphone/speaker coordinates. The debug view shows the published name, RGB, and the three exact flags used by the NoS ghost setting, and labels faction information as `NoS: …`. Normal avatars directly recolor the body/ghost mask with the published RGB; Lite uses the same RGB for its body fill. Palette matching is only used for existing cosmetic assets, not for the main body color.

Lobby RGB is read directly from `Nebula.Modules.Cosmetics.DynamicPalette.PlayerColors`, indexed by player ID as in NoS's color RPC. The `palette` helper command resolves the managed static array slot and `Virial.Color` field offsets without requiring TBCL initialization or evaluating getters. Live reads follow the slot across GC and validate the array type, length, finite channels and stable contents. Normal and Lite avatars use the separate `nosLobbyColor` value only in the lobby; this does not manufacture team flags. Palette initialization retries after 30 seconds if unavailable.

Role/position snapshot sampling starts during a game, when the current NoS publisher is available. Resolution retries after 30 seconds if initialization has not completed. Each new round waits for a new ring publication; a publication stalled for over three seconds is discarded. Returning to the menu resets the trackers. On process reset, MOD switch, invalid memory, or missing player entries, old snapshot values are not reused. Player count is capped at 24. The selected ring slot and payload are reread to detect concurrent modification. Unsupported or absent TBCL layouts produce a diagnostic instead of treating vanilla substitute roles as known NoS factions.

## Validation

2026-09-22 SNR ghost-audio correction: Jackal and WaveCannonJackal eligibility now comes from the current decoded role, even if discovery-time flags are absent or false. The installed WaveCannonJackal definition has `AssignedTeam=Neutral` and constructs `JackalAbility` with `canKill:true`; SNR's `IsKiller()` recognizes that ability. Snapshot flags are bound to the captured role ID and discarded after role changes rather than carried by PlayerId alone. The realtime debug table shows SNR flags and ghost-setting eligibility. Other roles still require valid acquired metadata; this change does not claim full external evaluation of arbitrary SNR `CanKill` delegates.

```powershell
powershell -File scripts/test-snr-reader.ps1
node scripts/test-snr-live.mjs
powershell -File scripts/build-nos-reader.ps1
node scripts/test-nos-reader.mjs
node scripts/test-jumbo-audio.mjs
node scripts/test-nos-avatar.mjs
node scripts/test-mod-settings.mjs
node scripts/test-upstream-fixes.mjs
npm run typecheck
```

Process tests launch and terminate their own x86 fixtures. The NoS test writes only its fixture's publication flag. The audio test renders a 1 kHz tone in Chromium and checks normal/half/max growth at 1000/700/400 Hz. These checks do not replace multiplayer listening tests.

Live verification on 2026-09-20: NoS Snapshot 26.09.19b, freeplay Jackal. The actual `PlayerData` size is 96 bytes. Five consecutive 200 ms samples showed changing ring publications, a valid name/RGB/position, `IsNeutral=true`, `IsKiller=true`, and `IsImpostor=false`. The initial lobby had no static storage address yet; resolving after entering freeplay succeeded. Individual role names and cosmetics are absent from this DLL's `TBCLFields.PlayerData` definition.
