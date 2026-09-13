# Native dependency packages

These packages retain the upstream sources and prebuilds, with the following build corrections for TanukiBCL 3.2.0. The source files and upstream license files are included in the archives. `package-lock.json` records each archive's integrity hash.

| Package | Upstream commit | Local correction |
| --- | --- | --- |
| memoryjs 0.0.10-tanuki.1 | OhMyGuus/memoryjs `656f0bf493629f0a098807d6064e7554a933775c` | Rebuild the Windows x64 prebuild from the same source. The upstream prebuild crashes during DLL loading. Retains the upstream `readBuffer` copy fix for Electron's V8 sandbox. |
| node-keyboard-watcher 1.0.6-tanuki.1 | OhMyGuus/node-keyboard-watcher `c5e125084bae1f19d79a0d98b1d8105e74eb328f` | Include CommonJS `dist/index.js` compiled from `src/index.ts`; include that TypeScript source. |
| electron-overlay-window 2.0.5-tanuki.1 | OhMyGuus/electron-overlay-window `645930748db78215448a7cb6f0f2e0f5f26f1f42` | Include CommonJS `dist/index.js` compiled from `src/index.ts`; include that TypeScript source. |

The wrapper packages omit `prepare`, since their generated JavaScript is already present. Native installation still uses upstream `node-gyp-build`. This avoids Git prepare failures and the need to install the upstream packages' development toolchains during `npm ci`.

The memoryjs x64 prebuild was compiled with MSVC 19.44.35228, Windows SDK 10.0.26100.0, Node 24.13.0 headers, and node-addon-api 8.9.2. `scripts/rebuild-memoryjs.ps1` records the compiler options and includes node-gyp's Windows delay-load hook so a renamed Electron executable can load it. Run it with `-MsvcRoot` pointing to a portable MSVC tree and `-NodeHeaders` pointing to the extracted Node headers with `node.lib` at its root. The output is `node_modules/memoryjs/build/Release/memoryjs.node`.

To refresh the archive, copy that output over `prebuilds/win32-x64/memoryjs.node` in the package, then run `npm pack --ignore-scripts --pack-destination <repository>/vendor` from the package directory. To regenerate a wrapper, compile its included `src/index.ts` to `dist/index.js` with TypeScript 6.0.3, target ES2020 and CommonJS, and pack it the same way. Update the lockfile and run `npm run verify:esm` under both Node and Electron before distribution.

Only Windows x64 is validated for this release. The other upstream prebuilds are retained unchanged. The generic memoryjs `callFunction` implementation has upstream compiler warnings; TanukiBCL does not use that API.
