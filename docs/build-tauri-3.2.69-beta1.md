# Tauri 3.2.69 beta 1

Combines the published 3.2.68 inactive-addon fixes with the shared Silero VAD/SenseVoice native worker. The detailed settings panel links to the common per-user model installer. Model files are shared with Electron/Lite/.NET; no model or dependency tree is copied into this source checkout. Missing resources retain Vosk recognition. Hero/NG recognition remains on Vosk.

No detected `tanuki.bcl.roles` means no shared worker startup, even with stale discovery/job data. Detection loss cancels queued/in-flight recognition and releases the model. Recorded PCM remains memory-only and is not sent to a transcription API. Ownership, session/request validity, bounded duration and stale-result checks remain enforced.

Reuses the existing Cargo target, native libraries and resource preparation. Build with `npm exec -- tauri build`; verify the resulting NSIS with `node scripts/verify-tauri-installer.mjs`. Native/UI tests and synthetic speech integration are required. Physical microphone and multiplayer load are not verified.
