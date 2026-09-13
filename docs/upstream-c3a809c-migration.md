# BetterCrewLink更新の取り込み：TanukiBCL 3.2.0

## 対象と方針

- 比較開始点：TanukiBCL `87943e1`（3.1.97）。
- [c3a809c](https://github.com/OhMyGuus/BetterCrewLink/commit/c3a809c40d893692fafff3b6c91322c812d92969)：音声コントローラー・WebRTC接続管理、共有AudioContext、ゲーム情報・識別情報、新設定画面、Electron/Vite/ESM/React/MUI更新を取り込む。
- [64a321a](https://github.com/OhMyGuus/BetterCrewLink/commit/64a321a1cda9d4a3fd547874df67b397a0a063f5)：36言語の不足翻訳を追加。既存のTanukiBCLのキーと文言を優先して保持する。
- [d1a4e14](https://github.com/OhMyGuus/BetterCrewLink/commit/d1a4e14)：上流のバージョン番号変更。TanukiBCLの配布番号はユーザー指定の **3.2.0** とする。
- 音声通信・再接続はBetterCrewLinkを優先し、独自のボイスエフェクト等を新構成へ移植する。旧接続タイマーを重複実装しない。
- ユーザーの追加指定により、**問い合わせの動作・送信先、Discord/GitHubのリンク先・案内文・フッターの配置を元のTanukiBCLのまま保持する**。問い合わせの外部送信は検証に使用しない。

## 実装の対応

| 項目 | 移植先と扱い |
| --- | --- |
| WebRTC接続・シグナリング・ICE監視・再接続 | `src/renderer/voice/ConnectionController.ts`、`VoiceController.ts`、`lib/PeerConnection.ts`。上流実装を採用 |
| 音声入出力・共有AudioContext | `voice/AudioController.ts`。相手単位の切断で共有出力を閉じない |
| 変装・サイズ変化のボイスエフェクト | 既存の`voiceEffect.ts`を保持し、発動条件を`voice/voiceEffectRules.ts`へ移植。相手別の音声経路に組み込み、解除時にノードを停止・切断 |
| 強度設定・テスト再生 | `settings/sections/AudioSection.tsx`、`TestVoiceEffectButton.tsx`。通常版・Lite版とも保持 |
| エフェクト有効化・第三陣営の幽霊音声 | `LobbySection.tsx`、`voice/spatialAudio.ts`。ホスト設定の同期と既存の設定値を保持 |
| Airship補正 | `GameReader.ts`のoutfit等による会議判定と、`spatialAudio.ts`・`AudioController.ts`の距離・スポーン補正を保持。対象上流ソースに同等処理を確認できなかったため。実ゲームでの必要性は未確定 |
| Mod対応・外見・サイズ・対象PID・複数起動 | `GameReader.ts`、`offsetStore.ts`、`main/index.ts`、`common/AmongUsState.ts`。既存の読取フィールドと上流の識別情報を統合 |
| アバター | `components/Avatar.tsx`、`LiteAvatar.tsx`。変装時の外見・名前、非表示条件、Liteの簡易描画と独自配色を保持 |
| オーバーレイ | `views/Overlay.tsx`、`state/overlayBridge.ts`。匿名時の名前非表示、透かし、Mod別の位置補正を保持 |
| OBS | Tanuki向けOBS URLを保持。Lite版にも既存のOBS・オーバーレイ設定を残す |
| Lite版 | 簡易アバター、ハードウェアアクセラレーション無効、設定ファイル分離、更新チャンネルを保持。従来どおり公開ロビーの閲覧・公開を抑制 |
| 問い合わせ・サポートリンク | フッターのGitHub・Discord・問い合わせボタンを維持。新Electron/preload・MUIで動かすためのimport/API対応のみ行う |
| 設定保存・移行 | `main/settingsStore.ts`へ移行。`localLobbySettings`を`myLobbySettings`へ引き継ぎ、独自設定・保存済みサーバー一覧・プレイヤー別音量/ミュートを保持 |
| プレイヤー識別方式変更 | 上流のUID方式を採用。旧nameHashの音量/ミュート設定をフォールバック参照し、保存数による一括初期化を廃止 |
| 更新・インストーラー | TanukiBCLのアプリID、実行ファイル名、通常版/Lite版の更新先とチャンネルを保持 |

旧Socket.IO v2フォールバックは、音声通信を上流優先とする指示に従い、上流のSocket.IO v4構成に置き換えた。古いサーバーとの接続互換性は実接続での確認が必要。

## 画像保存の修正

Jimp 1系へ更新し、PNGバッファを`fs.promises.writeFile()`で保存後に置換する。保存ディレクトリ作成、PNG拡張子の一時ファイル、衝突しない一時名、保存・置換エラーの伝播を実装した。

色変更通知は生成成功後に送る。失敗時は次回読み取りで再試行し、色一覧が更新された後に完了した古い生成結果は通知しない。第1段階で適用した修正も新構成へ引き継いでいる。

## 依存取得とネイティブ依存

Node.js 24.13.0、npm、`package-lock.json`へ移行。古いYarn設定とロックファイルは廃止した。

上流の`memoryjs`のWindows x64同梱バイナリは、DLL読み込み時にアクセス違反で終了した。同一コミットのソースから再構築し、ElectronのV8 sandboxに対応する上流の`readBuffer`コピー処理を維持した。キーボード・オーバーレイ依存も、配布に不足していたJavaScriptラッパーを上流ソースから生成した。

補正済みパッケージとソースは`vendor/*.tgz`に収録し、由来・再構築方法は`vendor/README.md`と`scripts/rebuild-memoryjs.ps1`に記録した。N-APIの検証済みバイナリを利用するため、electron-builderの`npmRebuild`は無効。

## 検証

### 追加修正：手動アップデートとLite版の設定

- アップデート欄のカード内に余白を設け、ボタンを同じ幅・高さで配置。補足文を小さくし、狭い画面ではボタンを縦に並べる。
- 追加指定により、問い合わせボタンは独立ウィンドウを開く形式へ変更した。フッターの位置・リンク、問い合わせの送信先と送信処理は維持。ウィンドウは一つだけ開き、閉じた際は非表示にして入力内容を保持する。
- 問い合わせの添付ダイアログは呼び出し元ウィンドウに紐付ける。両版で重複起動防止、入力保持、最小サイズでの操作ボタン表示、模擬送信のエラー・再試行・成功を確認した。外部への問い合わせは送信していない。

- 更新ダイアログを設定画面の「アップデート」へ移動。起動時の自動確認を廃止し、確認ボタンから再確認できるようにした。
- 開始ボタンは更新がある場合だけ有効。確認中・ダウンロード中は重複操作を抑止し、エラー時は再確認できる。確認失敗を「最新版」と誤表示しない。
- `autoDownload`・`autoInstallOnAppQuit`を無効化。開始ボタンで要求した場合だけダウンロードし、完了後にインストールする。時間切れによる強制更新は行わない。
- Lite版では「自分の設定」とそこへのホスト用編集ボタンを非表示にし、常に「現在のロビー」を表示する。保存済みのロビー設定値は削除しない。
- 両版の実画面で更新APIをスタブ化し、更新なし・更新あり・通信エラー・再確認・画面再表示・重複開始の抑止を検証した。開始操作前のダウンロード/インストールは0回、開始操作後は各1回。実際の外部ダウンロードやインストールは実行していない。

### 上流取り込み時の検証

- TypeScript全体の型検査、ESLint、Viteビルド。
- `npm run test:upstream`：変装/サイズエフェクト、会議・死亡・無線・ホスト設定による解除、距離判定、Airship補正、第三陣営の幽霊音声、フィルター復元、相手別の経路破棄、色変更通知、PNG生成と失敗伝播。
- NodeとElectronでネイティブ依存の読み込み、自分自身のプロセスに対する`memoryjs.readBuffer()`を検証。
- 通常版・Lite版の実画面と独立設定画面を起動。使い捨ての設定フォルダで旧設定の引き継ぎを検証。
- 両版で仮想マイクによるボイスエフェクトテストの開始・停止、強度設定・ロビー設定・OBS/オーバーレイ設定の表示を検証。
- 問い合わせの送信・添付構築処理が元の実装と同一であることを比較。外部送信は実施していない。

### 配布ビルド完了（2026-09-13）

Windows x64向けに通常版・Lite版の **3.2.0** を作成した。

| 版 | インストーラー | サイズ |
| --- | --- | --- |
| 通常版 | `dist/TanukiBCL-Setup-3.2.0.exe` | 111,054,431 bytes |
| Lite版 | `dist-lite/TanukiBCLLite-Setup-3.2.0.exe` | 111,054,101 bytes |

新規の`npm ci`が成功し、取得し直した依存環境で`typecheck`、`lint`、`test:upstream`、`verify:esm`、`build`をすべて実行して成功した。その後、以下を実行した。

```powershell
npx electron-builder --win --x64 --config electron-builder.yml --publish never
npx electron-builder --win --x64 --config electron-builder-lite.yml --publish never
```

両インストーラーのバージョン情報が3.2.0であることを確認。両版の`app.asar`をテスト用Electronから読み込み、配布時の設定を模したハーネスで画面表示・設定移行・ボイスエフェクトテストを検証した。実際の`TanukiBCL.exe`・`TanukiBCLLite.exe`のNode実行モードでも、同梱ネイティブモジュールの読み込みと、自プロセスへの`memoryjs.readBuffer()`を確認した。

SHA-256:

```text
82B2A854694694DCDE5BC00FF821C2A0305E57DCBE5B6583603FC5FE5A722781  TanukiBCL-Setup-3.2.0.exe
9602B84AC503D2DDEA4D1E2C865BC5E433DFD7982E0236E15CE876C7765F1978  TanukiBCLLite-Setup-3.2.0.exe
```

未確認：Among Usを使った複数プレイヤー通話、実ゲームでのAirship各状態・Mod状態、実サーバーでの切断復帰、実ゲームへのオーバーレイ接続、OBSブラウザー側の表示、インストール/自動更新の実行。自動テストと起動確認はこれらの実機検証を代替しない。
