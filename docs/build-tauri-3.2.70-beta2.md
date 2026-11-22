# タヌキのベタクル Tauri 3.2.70 ベータ2

通常版v3.2.70（4c01d7d9c2b772b48ee5fa40a8102149fbe26e81）を基準とした修正版です。InnerNetClientの終了状態（Ended）を先に読み、破棄済みのプレイヤー・会議画面を追わず待機表示へ戻します。Joined／Started時の読み取り異常は従来どおり報告します。

Node.js、Rust MSVC、C++ Build Tools、WebView2を用意し、npm ci、npm exec -- tauri buildの順でビルドします。既存の作業ディレクトリと依存・Cargoキャッシュを再利用してください。Rust/WASMのビルドが完了してからネイティブ側をビルドします。共有音声モデルはベータ1と共通で、再導入は不要です。

検証記録はvalidation-match-end-3.2.70-beta2.jsonとvalidation-rust-package-3.2.70-beta2.jsonを参照してください。破棄されたポインターを模擬した実メモリ読み取りテストを使用します。実試合終了画面での修正後の確認・インストーラーの実行は行っていません。
