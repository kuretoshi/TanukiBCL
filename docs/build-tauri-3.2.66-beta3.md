# Tauri 3.2.66 ベータ3のビルド

Electron v3.2.66（`2bacd83f7bcfa2d9d8463c44cdec366e9246cbbb`）を基準とするWindows x64版です。共有ソース137ファイルの照合と、ベータ2の更新確認・ウィンドウ終了の修正を維持します。

NoSアドオンへ送るサンプルの互換バージョンを、固定文字列3.2.62から`crate::compat_version()`へ統一しました。統合AddonLinkと旧UDPの本人・ホスト中継のすべてがビルドの3.2.66を通知します。TCP/UDPの実ループバック通信で送信値を検証し、バージョン通知を要求しない旧受信側の形式も保持します。

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib
npm run tauri:build
node scripts/verify-rust-package.mjs --preservation-manifest .tools/bit-3.2.66-preservation.json --report docs/validation-rust-package-3.2.66-beta3.json
```

配布先は`dist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.3.exe`です。以前の公開インストーラーとElectronのソース・設定は保持し、既存の依存とビルドキャッシュを使います。

物理マイクによる通話と、実ゲームでの修正版バージョン案内の表示は未確認です。

2026-11-18のRust単体テストは本体108件、CLR読み取り補助2件、Rust UI16件の計126件が通過しました。NoSの実ループバックTCP・本人UDP・ホスト中継UDPで、送信バージョンとビルドの互換バージョンが一致することを確認しています。
