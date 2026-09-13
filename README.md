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

### Windows 64bitビルド

```powershell
npm.cmd run build
.\node_modules\.bin\electron-builder.cmd --win --x64 --publish never
.\node_modules\.bin\electron-builder.cmd --win --x64 --config electron-builder-lite.yml --publish never
```

- 通常版: `dist/TanukiBCL-Setup-3.2.0.exe`
- Lite版: `dist-lite/TanukiBCLLite-Setup-3.2.0.exe`

N-API対応の検証済みビルドを使うため、配布設定の`npmRebuild`は無効です。ネイティブ依存を変更した場合は、NodeとElectronの両方で読み込みとメモリ読み取りを再検証してください。今回の配布確認対象はWindows x64です。


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
