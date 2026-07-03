# Pake / Tauri investigation

Branch: `future/tauri-pake-investigation`

## Result

The current app cannot be launched by Pake/Tauri as-is.

Pake is a Tauri/Rust wrapper for turning a web page into a desktop app. It does not provide Electron's renderer APIs, Electron's main process, Node `require`, or this app's native Node modules.

## Environment check

- Node: `v16.14.2`
- Yarn: `1.22.22`
- `pnpm`: not installed
- `rustc`: not installed
- `cargo`: not installed

Pake local development requires the Tauri/Rust toolchain, so building Pake itself is not currently possible in this environment without installing Rust and pnpm.

## Compatibility blockers found

The generated renderer HTML includes a CommonJS require call:

```html
<script>require("source-map-support/source-map-support.js").install()</script>
```

The generated renderer bundle also externalizes Electron and Node modules:

```js
e.exports=require("electron")
e.exports=require("path")
e.exports=require("fs")
e.exports=require("buffer")
e.exports=require("process")
```

These are available in Electron with Node integration, but not in a normal Tauri WebView/Pake page.

Source dependencies that block a direct Pake launch include:

- `ipcRenderer` and `shell` in renderer files
- `ipcMain`, `BrowserWindow`, `app`, `protocol`, and `session` in main files
- `memoryjs` for reading Among Us memory
- `node-keyboard-watcher` for global key hooks
- `electron-overlay-window` for overlay behavior
- `electron-store`, `electron-updater`, and `electron-window-state`

## Practical options

1. Keep Electron and optimize packaging/runtime.
   - Lowest risk.
   - Can reduce installer size and runtime cost without replacing the platform.

2. Create a Tauri/Pake proof-of-concept for a UI-only Lite shell.
   - Needs Rust and pnpm.
   - Renderer must remove all direct Electron imports and use an abstraction layer.
   - Main native features would be stubbed or disabled.

3. Full Tauri migration.
   - Large rewrite.
   - Requires Rust replacements for memory reading, keyboard hooks, overlay windows, updater, window state, and IPC.

## Recommendation

Do not merge Pake directly into the current Electron app.

The next safe step is to add a platform abstraction layer around renderer native calls (`ipcRenderer`, `shell`, settings store) while keeping Electron as the production runtime. Once renderer code can run without importing `electron` directly, a Tauri/Pake Lite proof-of-concept becomes realistic.
