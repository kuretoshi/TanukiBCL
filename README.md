# タヌキのベタクル

タヌキのベタクルは、Among Us 向け近接ボイスチャットアプリ [BetterCrewLink](https://github.com/OhMyGuus/BetterCrewLink) をベースに、日本語環境で使いやすいよう調整している非公式フォークです。

元プロジェクトは [CrewLink](https://github.com/ottomated/CrewLink) のフォークで、このリポジトリもその流れを引き継いでいます。Among Us、Innersloth、CrewLink、BetterCrewLink の公式プロジェクトとは別の非公式版です。

## このフォークについて

- 日本語 UI / 日本語説明を中心に調整しています。
- BetterCrewLink の機能をベースにしつつ、国内プレイヤー向けの使いやすさを優先しています。
- キノコカオスやカモフラージュ系の状態に合わせたボイスエフェクト調整を追加しています。
- Windows での利用とビルドを主な対象にしています。

## 主な機能

- Among Us の位置情報に連動した近接ボイスチャット
- 死亡者、インポスター、会議中などの状態に応じた音声制御
- オーバーレイ表示
- マイク / スピーカー選択
- マイク音量、感度、ノイズ抑制、エコーキャンセル設定
- プレイヤーごとの音量調整
- ロビー設定の同期
- キノコカオス / カモフラージュ時のボイスエフェクト(未テストのため、動作確認お願いします！バグがあれば報告をお願いします！)
- ボイスエフェクト強度の調整とテスト再生
- MOD使用時の追加役職ごとの音声制御

## ダウンロード

配布版を使う場合は、このフォークの Releases から最新版をダウンロードしてください。

[Releases](https://github.com/kuretoshi/TanukiBCL/releases)

Windows では `TanukiBCL-Setup-x.x.x.exe` を実行してインストールします。Among Us の状態を読むためにプロセスへアクセスするため、環境によってはセキュリティソフトの警告が出る場合があります。

## 使い方

1. タヌキのベタクル を起動します。
2. Among Us を起動します。
3. 同じロビーにいる参加者も タヌキのベタクル を起動します。
4. 必要に応じてマイク、スピーカー、音量、ボイスエフェクトを設定します。

全員が同じボイスサーバーを使っている必要があります。接続できない場合は、設定のサーバー URL やネットワーク状態を確認してください。

## ボイスエフェクト

このフォークでは、キノコカオスやカモフラージュ系の状態に合わせて声にエフェクトをかけられます。

設定画面の `ボイスエフェクトの強さ` で効果量を調整できます。`ボイスエフェクトテスト` を使うと、実際にどのように聞こえるか確認できます。

## アップデート

設定画面の「アップデート」で「アップデートを確認」を押します。更新があれば「最新バージョンv…」が表示され、「アップデート開始」が有効になります。更新がなければ「最新バージョンです」と表示します。更新は開始ボタンを押した場合だけ行い、ダウンロード完了後にアプリを終了してインストールします。時間経過や通常のアプリ終了による自動インストールは行いません。

Lite版の「ロビー設定」は「現在のロビー」の表示のみで、「自分の設定」は表示しません。

## 不具合報告

アプリ下部の問い合わせボタンから、専用ウィンドウで件名・本文・添付ファイルを入力できます。アプリを起動したまま問い合わせウィンドウを閉じて開き直しても、入力途中の内容は保持されます。

こちらのDiscordサーバーに報告をお願いします。
https://discord.gg/cUX5KUkZPD

## ご支援

開発を応援していただけると励みになります！
よろしくお願いします！

https://ko-fi.com/kuretoshi

## 開発

### 必要なもの

- Windows 64bit
- Node.js 24.13.0（`.node-version` に記載）と付属のnpm
- Git

3.2.0ではElectron 43、React 19、MUI 9、Vite、ES Modulesへ移行しました。依存は`package-lock.json`で固定しています。

### セットアップと確認

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:upstream
npm.cmd run verify:esm
```

Windows用ネイティブ依存のビルド補正は`vendor`に収録しています。通常の依存取得・64bitビルドにVisual StudioやSSH鍵は不要です。由来と再構築手順は[ネイティブ依存の説明](vendor/README.md)を参照してください。

PowerShellの実行ポリシーで`npm`が止まる場合は、上記のように`npm.cmd`を使用します。

### 開発起動

```powershell
npm.cmd run dev
```

Lite版の開発起動では、現在のPowerShellで`$env:BETTERCREWLINK_LITE = '1'`を設定してから実行します。通常版へ戻すときはこの環境変数を削除します。

3.2.1では、設定の「詳細設定」→「デバッグ情報を開く」で開発者用パスワードを入力すると、リアルタイム一覧・ゲーム状態・音声接続・ログを別ウィンドウで確認できます。役職は現在の読み取り処理が判定できる情報を表示します（ミニ・ジャンボの判定は停止中）。開発起動ではデバッグ指定時に自動表示しますが、配布版は認証が必要です。

開発者用パスワードは、ビルド前に次のコマンドで設定します。確認を含め2回入力します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/set-debug-password.ps1
```

照合用ハッシュをGit管理対象外の`.tools/debug-password.json`に保存します。通常版・Lite版に適用するには、その後アプリと両インストーラーを再ビルドしてください。未設定では認証できません。これはローカルアプリの操作制限であり、アプリ自体を改変する利用者まで防ぐものではありません。

### Windows 64bitビルド

```powershell
npm.cmd run build
.\node_modules\.bin\electron-builder.cmd --win --x64 --publish never
.\node_modules\.bin\electron-builder.cmd --win --x64 --config electron-builder-lite.yml --publish never
```

- 通常版: `dist/TanukiBCL-Setup-3.2.2.exe`
- Lite版: `dist-lite/TanukiBCLLite-Setup-3.2.2.exe`

N-API対応の検証済みビルドを使うため、配布設定の`npmRebuild`は無効です。ネイティブ依存を変更した場合は、NodeとElectronの両方で読み込みとメモリ読み取りを再検証してください。今回の配布確認対象はWindows x64です。


## デバッグ確認担当者のパスワード追加

3.2.9の配布版は招待コード方式です。管理者がPiでコードを発行し、担当者に [登録ページ](https://debug-auth.kuretoshi.work/debug-register) とコードを渡します。担当者が自分で設定したパスワードでデバッグ画面を開けます。コードは1回限り・標準72時間有効です。発行・無効化の手順は [server/debug-auth/README.md](server/debug-auth/README.md) を参照してください。

以下はビルド時に `TANUKI_DEBUG_AUTH_URL` を明示的に空文字へ設定した、ローカル認証版の手順です。

開発者は [scripts/add-debug-password.cmd](scripts/add-debug-password.cmd) をダブルクリックして、担当者名と新しいパスワードを2回入力できます。ターミナルでは `npm run debug:password:add` でも起動できます。既存のパスワードは残り、最大16個まで追加できます。

設定はGit管理外の `.tools/debug-password.json` にソルトとハッシュで保存されます。追加後、通常版とLite版を再ビルドして配布してください。確認担当者は配布されたパスワードを設定画面のデバッグ認証で入力して開きます。配布済みアプリには再ビルド前の追加は反映されません。

従来の `scripts/set-debug-password.ps1` を `-Add` なしで実行すると、既存の全パスワードを1個の新しいパスワードに置き換えます。

通常のビルドは公開済みのHTTPS認証APIを使用します。ビルド時に `TANUKI_DEBUG_AUTH_URL` を指定すると接続先を変更できます。このモードではローカルパスワードを組み込まず、通信失敗時にもローカル認証へ切り替えません。

## 貢献

不具合修正、翻訳改善、日本語表現の調整、機能改善の Pull Request を歓迎します。

大きな変更を入れる場合は、先に Issue などで方針を相談してもらえると助かります。

## 元プロジェクト

このリポジトリは以下のプロジェクトをベースにしています。

- [OhMyGuus/BetterCrewLink](https://github.com/OhMyGuus/BetterCrewLink)
- [ottomated/CrewLink](https://github.com/ottomated/CrewLink)

元プロジェクトの開発者、コントリビューター、翻訳者の皆さまに感謝します。

## ライセンス

このプロジェクトは GNU General Public License v3.0 のもとで配布されています。詳細は [LICENSE](LICENSE) を確認してください。

## 免責

この mod は Among Us または Innersloth LLC とは関係ありません。内容は Innersloth LLC によって承認、支援、提供されたものではありません。Among Us に関する権利は Innersloth LLC に帰属します。

## クレジットとリソース

敬称略

### SpecialThanks

アイコンイラスト、Lite版クルーメイトスキンデザイン、宣伝、多方面からのバグ報告
- セオノ

NoS対応
- あつ

デバッグ対応
- まっすー

### 対応MOD
- [SuperNewRoles](https://github.com/SuperNewRoles)
- [Nebula on the Ship](https://github.com/Dolly1016/Nebula)
