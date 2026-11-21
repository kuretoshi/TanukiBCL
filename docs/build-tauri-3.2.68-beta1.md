# Tauri 3.2.68 beta 1

Based on public Tauri source ae63bd2d7d2b77c55a956da3b5861792f6ac8c54 and desktop 3.2.68 fe6a64fa4bd079d4ee66d873b9c1315b19dd97f5.

Tanuki addon features require both NoS and an explicitly detected `tanuki.bcl.roles` addon. Missing addon metadata cannot activate stale bit voice, wall-ear listening or speech-limit muting. No addon means no addon discovery sockets, nonces, role recording buffers or recognition worker. Removing the last recognition job drops the worker, sender and model; inactive incoming voice is not copied into recognition PCM.

The release reuses the existing Vosk model, speech DLLs and CLR reader resources from 3.2.67 beta 2, verified against all 33 resources inside its published installer. It does not include unpublished local neural-recognition development.

The original worktree and its unrelated edits were preserved. The build used source-only staging from the published commit plus this patch, shared Cargo dependencies/target cache, and existing resources. No dependency tree, speech model or portable resource copy was created.

Validation: new regressions reproduced the previous inactive worker, stale bit voice, stale wall-ear listening and absent-addon discovery work before the change. Full native tests and UI tests are recorded in the accompanying validation JSON. Physical microphone and the affected multiplayer room remain unverified.

For a normal source checkout, use the existing documented dependency/resource preparation and run:

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml -p tanuki-bcl-tauri --bin tanuki-bcl-tauri
cargo test --manifest-path src-tauri/Cargo.toml -p tbcl-rust-ui --lib
npm exec -- tauri build
```
