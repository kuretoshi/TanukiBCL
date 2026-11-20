# Tauri 3.2.66 ベータ4のビルド

Electron v3.2.66（`2bacd83f7bcfa2d9d8463c44cdec366e9246cbbb`）を基準とするWindows x64版。ベータ3の互換バージョン通知と、ベータ2の更新確認・終了処理を維持する。

- Tauriが返すWindowsのverbatimパスをVosk用の通常表記へ変換し、日本語モデルの読み込み失敗を修正。
- ロビー退出時は破棄中のプレイヤー一覧を読まずにメニューへ戻し、ゲーム終了・再接続時の読み取りエラーも消去。
- プルダウンの展開項目へ背景色・文字色を指定し、白い背景に白い文字が重なる状態を修正。

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib
npm exec -- tauri build
node scripts/test-native-speech-path.mjs src-tauri/target/release/tanuki-bcl-tauri.exe out/tauri-backend/rust-speech
node scripts/verify-tauri-installer.mjs
```

インストーラーは`dist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.4.exe`。今回の配布にはポータブル用のリソース一式を複製せず、ビルド済みNSISインストーラーをこの配布名にコピーし、SHA-256を添付する。既存の依存・モデル・ビルドキャッシュを再利用する。

実モデルの通常／verbatimパスでの読み込みと無音デコード、退出中のメモリ構造、Rust UIを検証する。プルダウンの複数項目の表示は同じ修正を入れたローカル版で確認済み。物理マイクによる通話と実ゲームの退出操作は未確認。

2026-11-21の全体テストは本体110件、CLR読み取り補助2件、Rust UI16件の計128件が通過。公開GitHubへの接続を行う任意テスト1件は通常の全体テストではスキップする。
