Read-only Rust CoreCLR reader for the Windows Tauri edition. It uses the DAC
shipped beside the target process's CoreCLR, verifies its Microsoft Authenticode
signer, and supplies an `ICLRDataTarget` restricted to process memory reads.
It does not suspend the game, invoke managed methods, or inject a component.

The native ABI declarations follow .NET Runtime's MIT-licensed `clrdata.idl`,
`sospriv.idl`, and `dacprivate.h` from v6.0.36. ECMA-335 metadata is parsed directly
with bounded lengths. x86 CLRDATA addresses are sign-extended only at the COM
boundary. Each reader runs in a separate process matching the game's architecture.

Build with `scripts/build-rust-clr-reader.ps1`. The script reuses the existing
Cargo workspace cache and copies only the two resulting executables into the
Tauri resources. SNR discovery/push animation watching, NoS snapshot/palette/roles,
and TOH4E role/killer/catalog discovery run in Rust. C# projects remain test oracles.

Run `node scripts/test-rust-clr-reader.mjs` and the same command with `--x86`
after building the existing SNR fixture outputs. Tests compare complete role
metadata and live layouts with the prior reader, plus GC, array replacement,
ambiguous-source rejection, and animation completion behavior.
