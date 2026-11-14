# Tauri 3.2.65 ベータ1のビルド

Electronの基準ソースはv3.2.65、コミット2933dc09462d88b1cebfd2485d66b0d905c38dddです。Rust側と互換モード側のOBS送信に代替色を追加しました。

Windows x64、Node.js 24、Rust stable MSVCとwasm32-unknown-unknown、wasm-bindgen CLI 0.2.130、Visual Studio C++ Build Tools、WebView2を使用します。既存の依存関係・ビルドキャッシュがあれば再利用できます。

```powershell
npm ci
npm run test:obs-overlay
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml -p tanuki-bcl-tauri voice::bridge::tests
npm run tauri:build
node scripts/verify-rust-package.mjs
```

インストーラーはdist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.65-tauri-beta.1.exeです。Electron版とは別のアプリID・インストール先・設定フォルダーを使用します。
