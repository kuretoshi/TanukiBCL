# Tauri3.2.66 ベータ1のビルド

Electronの基準はv3.2.66、コミット`2bacd83f7bcfa2d9d8463c44cdec366e9246cbbb`。`release-base.json`の137個の共有ソースを照合する。

bitキャラクターの段階を統合AddonLinkから取り込み、Rustの各話者用DSPで6段階のサンプル保持・量子化を行う。会議・死亡・切断・最終段階では解除する。録音・音声認識は元のPCMを使用し、ロクロクビの両方の再生経路へ同じ加工済みPCMを渡す。

Windows x64、Node24、Rust MSVC、wasm32-unknown-unknown、wasm-bindgen0.2.130、Visual Studio C++ Build Tools、WebView2を使う。既存の依存・モデル・ビルドキャッシュを再利用する。

```powershell
npm run verify:tauri-base
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib
npm run tauri:build
node scripts/verify-rust-package.mjs
```

Rustテストはネイティブ102件、CLR2件、UI16件が通過。追加テストは6段階のPCM品質、64bit→元音声、会議・死亡・重複・不正状態の解除、任意のbitsチャンネルと旧アドオン互換を確認する。実機・物理マイクは未確認。

配布インストーラーは`dist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.1.exe`。Electron版とは別ID・設定・インストール先を使う。
