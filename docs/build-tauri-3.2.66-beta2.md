# Tauri 3.2.66 ベータ2のビルド

Electron v3.2.66（`2bacd83f7bcfa2d9d8463c44cdec366e9246cbbb`）を基準とするWindows x64版です。共有ソース137ファイルの照合を維持します。

- GitHub REST APIの失敗時は、公開リリースのAtomフィードと配布ファイル一覧からTauri版の更新を検索します。インストーラーの正確なサイズはHEADのContent-Lengthから取得します。SHA-256・サイズ・PE形式の検証を維持します。
- 更新確認の成功結果は5分、失敗結果は1分保持します。設定から手動ダウンロード用のリリースページも開けます。
- 主画面の×と終了コマンドはアプリを終了します。最小化・明示的なバックグラウンド操作は通話を継続し、設定などの補助画面を閉じても主画面は終了しません。

既存の依存ライブラリとビルドキャッシュを再利用します。以前の配布物を上書きせず、新しいベータ番号で出力します。

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib
cargo test --manifest-path src-tauri/Cargo.toml -p tanuki-bcl-tauri live_website_fallback -- --ignored --nocapture
npm run tauri:build
node scripts/verify-rust-package.mjs --preservation-manifest .tools/bit-3.2.66-preservation.json --report docs/validation-rust-package-3.2.66-beta2.json
```

ネットワークテストはAPIの403を模擬し、GitHubの公開メタデータとHEAD応答だけを取得します。インストーラーのダウンロード・実行・公開は行いません。

配布先は `dist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.2.exe` です。

2026-11-18の検証では、Rust単体テスト125件と公開GitHubメタデータによる代替経路のテスト1件が通過しました。配布物の構成・ハッシュ・既存Electron側498ファイルの保持も確認しています。

配布用EXEを合成音声・ローカル接続先・実在しないゲーム名で起動し、実画面で更新確認の成功、手動ダウンロードボタンの表示、設定画面だけの閉鎖、主画面の×による終了を確認しました。主画面を閉じた後、検証用の本体とWebViewなどの子プロセス計7件はすべて終了しています。物理マイクによる通話と更新インストーラーの実行は行っていません。
