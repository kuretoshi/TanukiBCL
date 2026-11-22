# タヌキのベタクル Tauri 3.2.70 ベータ3

配布用の検証ビルドでfrontendDistにD:/...形式のWindows絶対パスを指定すると、ディレクトリではなくURLとして解釈され、UIが埋め込まれずabout:blankのままになる問題を修正します。frontendDistには../out/tauri-rust-uiという相対ディレクトリを使います。試合終了時に破棄されたプレイヤー・会議画面を読まないβ2の修正は維持しています。

Node.js、Rust MSVC、C++ Build Tools、WebView2を用意し、npm ci後にnpm run tauri:buildを実行してください。Tauriを直接呼ぶ場合もnpm exec -- tauri build --features custom-protocolと指定します。releaseビルドでcustom-protocolが欠けている場合、build.rsがコンパイルを停止します。main.rsでも、実際にリンクされるTauriが配布モードであることをconst assertで検査します。URL形式のfrontendDistや空の埋め込みアセットも起動時に検出し、パッケージ監査ではHTML・bootstrap・WASMの埋め込みを確認します。既存の依存・Cargoキャッシュを再利用し、Rust/WASM UIを先にビルドしてください。共有音声モデルの再導入は不要です。

検証はvalidation-startup-3.2.70-beta3.jsonとvalidation-rust-package-3.2.70-beta3.jsonを参照してください。インストーラーから取り出した実行ファイルで、非表示のWebViewを使い、HTML/WASMの読み込みと設定ボタンによる設定画面の開閉を確認します。マウス・キーボードや入力フォーカスは使用しません。
