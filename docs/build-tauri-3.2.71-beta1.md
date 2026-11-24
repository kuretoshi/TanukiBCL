# タヌキのベタクル Tauri 3.2.71 ベータ1

SNRの衣装画像を元のSpriteキャンバスへ復元し、サイズ・位置と体色連動を修正します。ロビーで役職配列が空でも、通常プレイヤーの検証済みネイティブオブジェクトと衣装レイヤーを照合してハット2・バイザー2を取得します。画像の一時的な読み込み失敗は最大2回まで再試行し、成功後に表示を復元します。

モバイルホストは7レイヤーの完成PNGを既存の画像転送経路で送り、特殊なSNRバイザーのサイズ補正情報も渡します。モバイル3.69と組み合わせてください。衣装の変更は既存の取得周期により5〜10秒かかる場合があります。

Windows x64、Node.js、Rust MSVC、C++ Build Tools、WebView2、wasm-bindgenを用意してください。既存の依存ライブラリ・Cargoキャッシュ・共有音声リソースを再利用できます。`npm run tauri:prepare` と `npm run tauri:frontend:build` の後、`npm exec -- tauri build --features custom-protocol` でインストーラーを生成します。`frontendDist` は `../out/tauri-rust-ui` の相対ディレクトリを維持してください。共有音声モデルの再導入は不要です。

今回の公開ソースは通常版3.2.71を固定した専用ブランチ `codex/snr-cosmetics-tauri-3.2.71` です。検証は `validation-snr-cosmetics-3.2.71.json` と `validation-rust-package-3.2.71-beta1.json` を参照してください。配布用のHTML・WASM埋め込みとインストーラーの全リソースを検証し、インストーラーから取り出した実行ファイルの起動・設定画面の開閉を確認します。端末実機や多人数の通話を再現した検証ではありません。
