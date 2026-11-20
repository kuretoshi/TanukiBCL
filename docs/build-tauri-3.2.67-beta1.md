# Tauri 3.2.67 ベータ1の公開準備

アプリとNoSへ通知する互換バージョンは3.2.67、Windows x64版です。NoS側の共通修正は実ゲームのUDP・TCP両経路で確認済みで、公開は通常版・Lite版・.NET版と揃えて行います。

共有ソースの固定基準は通常版3.2.67（`b54e7bf56c467e1d1f29610163566e4172cf247a`）です。前版からの共有137実装ファイルの変更がないことをGit差分とSHA-256で照合し、package.jsonとrelease-baseを3.2.67へ更新しています。この基準にTauriの起動待機・1行表示・認識器維持の修正を重ねてビルドします。

- ゲーム起動時、初回正常読み取り前の既知のメモリ・パレット・DLL準備待ちだけを最大120秒待機表示にします。正常読み取り後やアクセス権・オフセット・シグネチャの異常は従来どおり表示します。
- メニュー・プレイヤー名・コードは1行で表示し、長い名前は省略と全文ツールチップで確認できます。
- ボイスストーン等の認識器は、同じ要求の期限通知だけが更新されても発声を保持します。要求番号・対象・ルールの変更では認識器を更新します。

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml --workspace --bins --lib
npm exec -- tauri build
# 生成されたNSISをdist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.67-tauri-beta.1.exeへ配置し、SHA-256を添付する。
node scripts/verify-tauri-installer.mjs
```

既存の依存・モデル・ビルドキャッシュを使い、ポータブル用リソースは複製しません。ベータ5という仮番号で行った132件のRustテスト、音声の実モデル統合テスト1件、280×390での表示確認の記録は `validation-tauri-startup-layout-3.2.66-beta5.json` に保持します。実ゲーム起動直後と物理マイクによる通話は未確認です。

3.2.67の基準更新後、バージョンに関するRustテスト4件も通過しました。P2Pのapp-version通知とNoSの旧UDP・ホスト中継通知が3.2.67で揃うことを確認しています。基準更新前の不一致を検出した検査は緩めず、そのまま再実行しています。
