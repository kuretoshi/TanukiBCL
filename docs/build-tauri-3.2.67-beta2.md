# Tauri 3.2.67 ベータ2

通常版3.2.67（`b54e7bf56c467e1d1f29610163566e4172cf247a`）の共有137実装ファイルを基準とするWindows x64版です。ベータ1の起動待機・音声認識・終了処理等を維持します。

名前とミュートボタンが同じ行の横幅を取り合っていたため、名前を上段全体へ、ロビーコードと操作ボタンを下段へ分けました。「開発者くれとし」は標準280×390で20pxのまま全文が表示されます。さらに長い名前はブラウザーの実測幅を基に縮小し、省略記号を使わず1行に収めます。

同じDOMのまま幅が変わった場合にも再計測し、拡大後は最大20pxへ戻します。名前も幅も変わっていない通常の更新では、文字サイズを書き換えません。日本語フォントや絵文字の幅を文字数から推測せず、実際の描画結果で判断します。

Rust UIテスト16件が通過しました。ビルドしたRust/WASM UIの280×390で、日本語7文字・10文字・長い日本語名・英字名・絵文字入りの名前を確認し、DOM Rangeの文字境界が表示領域内であること、scrollWidthがclientWidthを超えないこと、省略記号がないことを検証しました。410pxへの拡大と280pxへ戻す操作も確認しています。メニューの1行表示と5桁のコード表示も維持します。

結果は `validation-name-layout-3.2.67-beta2.json`、確認用画面は `name-layout-3.2.67-beta2.png` に記録しています。実ゲームの名前変更操作と物理マイクでの通話は未検証です。

```powershell
npm run verify:tauri-base
cargo test --manifest-path src-tauri/Cargo.toml -p tbcl-rust-ui --lib
npm exec -- tauri build
# NSISをdist-tauri/TanukiBCL-Tauri-Beta-Setup-3.2.67-tauri-beta.2.exeへ配置し、SHA-256を添付する。
node scripts/verify-tauri-installer.mjs
```

既存の依存・モデル・ビルドキャッシュを再利用し、ポータブル用リソースやプロジェクト全体のコピーは作成しません。

生成したインストーラーは、同梱33リソース、ビルド済み実行ファイルとの全バイト一致（NSIS識別子の変更部分を除く）、PEのFileVersion/ProductVersion、SHA-256の検証を通過しています。配布物監査は `validation-rust-package-3.2.67-beta2.json` に記録しています。
