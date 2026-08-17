# 詳細設計書

対象ブランチ: `main`  
対象アプリ: タヌキのベタクル / タヌキのベタクルLite  
対象バージョン: 3.1.95  
作成日: 2026-08-18

## 1. 概要

本アプリは、Among Us の実行プロセスからプレイヤー状態やロビー状態を読み取り、同一ロビーの参加者同士をボイスサーバー経由で WebRTC 接続する近接ボイスチャットアプリである。

Electron のメインプロセスが OS / ゲームプロセス / ネイティブアドオンとの連携を担当し、レンダラープロセスが React UI、音声入出力、WebRTC ピア接続、オーバーレイ表示を担当する。

主な機能は以下の通り。

- Among Us プロセス検出とメモリ読取
- ロビーコード、ゲーム状態、プレイヤー情報、位置、死亡/インポスター/ベント状態の取得
- Socket.IO と simple-peer による WebRTC 音声接続
- 距離、壁、カメラ、死亡状態、会議状態、サボタージュ状態に応じた音量制御
- キノコカオス/カモフラージュ系の見た目変化に応じたボイスエフェクト
- グローバルキーによるミュート、デafen、プッシュトゥトーク、インポスター無線
- ゲーム上オーバーレイ、会議 HUD オーバーレイ
- 設定永続化、自動アップデート、問い合わせ投稿
- 通常版と Lite 版のランタイム切替

3.1.95 では、ボイスサーバー上では相手を認識しているが WebRTC 音声ストリームが届かない `novoice` 状態、いわゆるオレンジ表示が残り続けるケースを減らすため、相手 peer 単位の自動修復を強化している。

## 2. 技術構成

| 項目 | 内容 |
| --- | --- |
| ランタイム | Electron 11 |
| UI | React 17, MUI 5 |
| 言語 | TypeScript |
| 音声 | Web Audio API, MediaDevices, VAD, simple-peer |
| 通信 | Socket.IO Client v4 / v2.4.0 互換接続 |
| ネイティブ連携 | memoryjs, node-keyboard-watcher, electron-overlay-window |
| 設定保存 | electron-store |
| ビルド | electron-webpack, electron-builder |
| 主対象 | Windows |

## 3. 全体アーキテクチャ

```text
Among Us.exe
   |
   | memoryjs
   v
Electron Main Process
   - src/main/index.ts
   - src/main/hook.ts
   - src/main/GameReader.ts
   - src/main/ipc-handlers.ts
   |
   | Electron IPC
   v
Electron Renderer Process
   - src/renderer/App.tsx
   - src/renderer/Voice.tsx
   - src/renderer/Overlay.tsx
   - src/renderer/settings/*
   |
   | Socket.IO signaling
   v
Voice Server
   |
   | WebRTC peer connection
   v
Other Clients
```

メインプロセスはゲーム状態の取得と OS 連携に集中し、レンダラープロセスは取得済みの `AmongUsState` をもとに UI と音声を制御する。オーバーレイは別 BrowserWindow として生成され、メイン画面から IPC 経由でゲーム状態、音声状態、設定、プレイヤーカラーを受け取る。

## 4. ディレクトリ構成

| パス | 役割 |
| --- | --- |
| `src/main` | Electron メインプロセス、ゲームメモリ読取、IPC、キーボードフック、自動更新 |
| `src/renderer` | React UI、音声制御、WebRTC、オーバーレイ、設定画面 |
| `src/common` | メイン/レンダラー共有の型、IPC 名、マップ、設定、Mod 定義 |
| `static` | 画像、音声、ローカライズ JSON |
| `resources` | Electron Builder / NSIS 用リソース |
| `vendor` | ネイティブアドオンの vendored copy |

## 5. 起動設計

### 5.1 メインプロセス初期化

`src/main/index.ts` が Electron アプリの起点である。

起動時に以下を決定する。

- 開発/本番判定
- 通常版/Lite 版判定
- アプリ表示名、内部名、AppUserModelId
- DevTools 表示可否
- オーバーレイ対象ウィンドウ名
- 複数起動許可
- ボイスデバッグ有効化
- ハードウェアアクセラレーション有効可否

通常版は `TanukiBCL`、Lite 版は `TanukiBCLLite` として扱われる。Lite 判定は環境変数、実行ファイル名、アプリ名、URL クエリから行う。

### 5.2 BrowserWindow

| Window | 生成関数 | 用途 |
| --- | --- | --- |
| メイン画面 | `createMainWindow` | アプリ本体、設定、音声状態表示 |
| ロビーブラウザ | `createLobbyBrowser` | 公開ロビー表示。Lite では無効 |
| オーバーレイ | `createOverlay` | Among Us ウィンドウ上に重ねる透過表示 |

本番時は `index.html` を `file://` で読み込み、クエリ `view` によりレンダラー側エントリを切り替える。開発時は webpack dev server を読み込む。

### 5.3 レンダラーエントリ

`src/renderer/index.ts` は URL クエリから表示対象を分岐する。

- `view=app&lite=1`: `LiteApp`
- `view=app`: `App`
- `view=lobbies`: `LobbyBrowserContainer`
- その他: `Overlay`

## 6. IPC 設計

IPC 名は `src/common/ipc-messages.ts` に集約される。

### 6.1 Renderer から Main への send/on

| メッセージ | 用途 |
| --- | --- |
| `SHOW_ERROR_DIALOG` | エラーダイアログ表示 |
| `OPEN_AMONG_US_GAME` | Among Us 起動 |
| `RESTART_CREWLINK` | アプリ再起動 |
| `QUIT_CREWLINK` | アプリ終了 |
| `SEND_TO_OVERLAY` | メイン画面からオーバーレイへ転送 |
| `SEND_TO_MAINWINDOW` | オーバーレイからメイン画面へ転送 |
| `REQUEST_MOD` | 現在 Mod の要求 |

### 6.2 Renderer から Main への invoke/handle

| メッセージ | 用途 |
| --- | --- |
| `START_HOOK` | ゲーム読取ループとキーボードフック開始 |
| `RESET_KEYHOOKS` | ショートカット再登録 |
| `JOIN_LOBBY` | ゲームロビー参加。現状は実質無効 |
| `OPEN_LOBBYBROWSER` | ロビーブラウザ表示 |
| `SELECT_INQUIRY_ATTACHMENTS` | 問い合わせ添付ファイル選択 |
| `SUBMIT_INQUIRY` | Discord Forum Webhook へ問い合わせ投稿 |

### 6.3 Main から Renderer への通知

| メッセージ | 用途 |
| --- | --- |
| `NOTIFY_GAME_OPENED` | Among Us プロセス検出状態 |
| `NOTIFY_GAME_STATE_CHANGED` | `AmongUsState` 更新 |
| `TOGGLE_DEAFEN` | デafen切替ショートカット |
| `TOGGLE_MUTE` | ミュート切替ショートカット |
| `PUSH_TO_TALK` | プッシュトゥトーク状態 |
| `IMPOSTOR_RADIO` | インポスター無線状態 |
| `ERROR` | ゲーム読取/初期化エラー |
| `AUTO_UPDATER_STATE` | 自動更新状態 |

### 6.4 Overlay 向け通知

| メッセージ | 用途 |
| --- | --- |
| `NOTIFY_GAME_STATE_CHANGED` | ゲーム状態 |
| `NOTIFY_VOICE_STATE_CHANGED` | 音声接続/発話状態 |
| `NOTIFY_SETTINGS_CHANGED` | オーバーレイ設定 |
| `NOTIFY_PLAYERCOLORS_CHANGED` | プレイヤーカラー |
| `REQUEST_INITVALUES` | オーバーレイ初期値要求 |

## 7. ゲーム状態読取設計

### 7.1 開始フロー

`App.tsx` は起動後 `START_HOOK` を invoke する。`src/main/hook.ts` は初回のみ以下を開始する。

1. `GameReader` の生成
2. キーボードショートカット登録
3. `keyboardWatcher.start()`
4. `GameReader.loop()` を約 5 FPS で繰り返し実行
5. エラー時は `ERROR` を通知し、7.5 秒後に再試行

2 回目以降の `START_HOOK` では、既存 `GameReader` の Among Us ハンドルをリセットして再検出させる。

### 7.2 プロセス検出

`GameReader.checkProcessOpen()` は `memoryjs.getProcesses()` から対象プロセスを探す。

既定の対象は `Among Us.exe`。以下の指定で上書き可能である。

- `BETTERCREWLINK_TARGET_PROCESS`
- `--target-exe`
- `--target-process`
- `BETTERCREWLINK_TARGET_PID`
- `--target-pid`
- `BETTERCREWLINK_TARGET_INDEX`
- `--target-index`

プロセス発見後、`openProcess`、`findModule('GameAssembly.dll')`、`getProcessPath` を実行し、インストール済み Mod とオフセットを初期化する。

### 7.3 オフセット取得

`src/main/offsetStore.ts` が BetterCrewlink-Offsets リポジトリから `lookup.json` と offsets JSON を取得する。

取得元は以下の順でフォールバックする。

1. `https://raw.githubusercontent.com/OhMyGuus/BetterCrewlink-Offsets/main`
2. `https://cdn.jsdelivr.net/gh/OhMyGuus/BetterCrewlink-Offsets@main`

取得結果は `electron-store` にキャッシュされる。ネットワーク取得に失敗し、キャッシュもない場合は `LOOKUP_FETCH_ERROR` または `OFFSETS_FETCH_ERROR` を返す。

### 7.4 読取対象

`GameReader.loop()` は以下を読み取る。

- ゲーム状態: メニュー、ロビー、タスク、会議
- ロビーコード
- ホスト ID / クライアント ID
- プレイヤー一覧
- ローカルプレイヤー
- 位置座標
- 名前、色、装備、現在 Outfit
- 死亡、切断、ベント、ダミー
- インポスター/第三陣営/特殊ロール推定
- マップ種別
- 最大人数
- 視界半径
- 通信サボタージュ
- 見た目入れ替わり/カモフラージュ系状態
- カメラ使用状態
- 閉鎖ドア
- 現在サーバー
- デバッグ情報

読み取り結果は `AmongUsState` としてレンダラーへ通知される。

### 7.5 `AmongUsState`

`src/common/AmongUsState.ts` の `AmongUsState` はアプリ全体の中核データである。

主要フィールド:

- `gameState`: 現在のゲーム状態
- `oldGameState`: 前回ゲーム状態
- `lobbyCode` / `lobbyCodeInt`: ロビー識別子
- `players`: プレイヤー一覧
- `isHost`, `hostId`, `clientId`: ホスト/ローカル識別
- `comsSabotaged`, `mixupSabotaged`, `camouflaged`: 音声制御に影響する状態
- `currentCamera`, `closedDoors`, `lightRadius`, `map`: 近接音声判定に使う環境情報
- `mod`: 読み取った Mod 種別
- `debug`: ボイスデバッグ用追加情報

### 7.6 `Player`

`Player` は音声制御と UI 表示の両方に使われる。

主要フィールド:

- 識別: `id`, `clientId`, `ptr`, `nameHash`
- 表示: `name`, `appearanceName`, `colorId`, `appearanceColorId`, `hatId`, `skinId`, `visorId`
- 状態: `isLocal`, `isDead`, `isImpostor`, `isThirdParty`, `inVent`, `disconnected`, `bugged`
- 座標: `x`, `y`
- ロール: `roleTeam`, `roleName`, `sizeScale`, `specialRole`

`hasVisibleAppearanceChanged()` は通常 Outfit と現在表示 Outfit を比較し、見た目変化を検出する。

## 8. キーボードフック設計

`src/main/hook.ts` は `node-keyboard-watcher` を使ってグローバルキーを監視する。

| 設定 | 既定値 | 用途 |
| --- | --- | --- |
| `pushToTalkShortcut` | `V` | プッシュトゥトーク |
| `deafenShortcut` | `RControl` | デafen切替 |
| `muteShortcut` | `RAlt` | ミュート切替 |
| `impostorRadioShortcut` | `F` | インポスター無線 |

キー押下中は `speaking` カウンタを増減し、プッシュトゥトークとインポスター無線が同時に関与しても発話状態が破綻しないようにしている。インポスター無線はローカルプレイヤーがインポスターの場合のみ有効である。

## 9. 音声通信設計

### 9.1 接続方式

`src/renderer/Voice.tsx` が音声通信の中心である。

接続先は設定 `serverURL` / `serverURLs` から決定し、Socket.IO をシグナリングに使う。音声本体は simple-peer による WebRTC P2P 接続で送受信する。

`src/renderer/socket.ts` の `connectCompatibleSocket()` は Socket.IO v4 で接続を試み、接続初期に失敗した場合は v2.4.0 へフォールバックする。

### 9.2 Socket.IO 互換ラッパー

`CompatibleSocket` は以下を提供する。

- v4 接続を優先
- 一定時間内に接続できない場合 v2.4.0 へフォールバック
- 未接続時の emit をキューイング
- `VAD`, `id`, `join`, `lobby`, `setHost` は最新イベントに畳み込み
- connect/error/disconnect を既存コード互換のイベントとして dispatch

### 9.3 WebRTC ピア接続

ピア接続はロビー参加者ごとに作成される。

主な設計:

- `join` イベント受信側が initiator として peer を生成
- `signal` イベントで SDP/ICE を中継
- 重複 signal は一定時間内に破棄
- ICE/connection state が `failed` / `disconnected` の場合に再接続予約
- 通常 STUN で失敗が続いた場合、TURN relay の利用へフォールバック
- リモート音声 track stall を検出して再接続
- peer 生成後、一定時間内に音声 stream が到着しない場合は同じ相手 peer のみを再接続
- `setClient` / `setClients` で相手一覧だけ更新され、peer 作成が始まらない場合は不足 peer を片側から補修

### 9.4 ICE 設定

既定は Google STUN のみを使う。

TURN フォールバック時は `turn:turn.bettercrewl.ink:3478` を relay 専用で使う。

設定 `natFix` や検証関数 `validateClientPeerConfig` により、必要に応じて relay only 構成を選択する。

## 10. 音声処理設計

### 10.1 入力

レンダラーは `navigator.mediaDevices.getUserMedia()` でマイク入力を取得する。設定に応じて以下を反映する。

- マイクデバイス
- エコーキャンセル
- ノイズ抑制
- マイクゲイン
- VAD
- プッシュトゥトーク / プッシュトゥミュート

発話状態は VAD とショートカット状態を合わせて判定し、Socket.IO の `VAD` イベントで他クライアントへ送る。

### 10.2 出力

リモート音声ストリームごとに Web Audio ノードを作成する。

```text
MediaStreamSource
  -> PannerNode
  -> GainNode
  -> optional: VoiceDisguiseEffect / Reverb / Lowpass
  -> MediaStreamDestination
  -> HTMLAudioElement
```

スピーカー設定が既定以外の場合は `HTMLAudioElement.setSinkId()` で出力先を切り替える。

### 10.3 音量制御

`calculateVoiceAudio()` は `AmongUsState`、設定、自分、相手、音声ノードをもとに最終ゲインを決定する。

主な判定要素:

- メニュー中は無音
- ロビー中は基本的に全員聞こえる
- タスク中は距離、ベント、死亡、壁、カメラ、サボタージュ、ロール設定を考慮
- 会議中は位置音声を中央寄せし、会議用ゴースト制限を適用
- 自分が死亡している場合、生存者音量に `crewVolumeAsGhost` を適用
- インポスターがゴーストを聞く場合、`ghostVolumeAsImpostor` を適用
- プレイヤー個別ミュート/音量と `masterVolume` を最終段で適用
- デafen中は全リモート音声を無音

### 10.4 空間音声

空間音声が有効な場合、相手座標と自分座標の差分を `PannerNode` に反映する。最大距離はロビー設定 `maxDistance` を基準とし、`visionHearing` が有効な場合は視界半径を優先する。

### 10.5 エフェクト

`src/renderer/voiceEffect.ts` のボイス変換ノードを使い、見た目変化中の相手音声にピッチ/フォルマント系の効果を適用する。強度は `voiceEffectStrength` で調整する。

リバーブやローパスは状況に応じて音声経路へ接続/解除される。経路の復元は `resetAudioRoute()` / `restoreTransientEffects()` が担う。

## 11. ロビー設定同期

ホストはロビー設定を peer data channel 経由で送信する。受信側は `maxDistance` などの値を `defaultLobbySettings` とマージして `HostSettingsContext` に反映する。

`hostRef` は以下を保持する。

- 現在マップ
- モバイルホスト検出状態
- 現在ゲーム状態
- ロビーコード
- Among Us 上の hostId
- サーバーから見た hostId
- 自分がホストかどうか

## 12. UI 設計

### 12.1 メインアプリ

`App.tsx` は以下を管理する。

- アプリ状態: メニュー / ボイス画面
- `AmongUsState`
- 設定画面表示
- 自動更新ダイアログ
- エラー表示
- プレイヤーカラー
- オーバーレイ初期値同期

ゲームが開かれていない場合は `Menu`、開かれている場合は `Voice` を表示する。

### 12.2 ボイス画面

`Voice.tsx` は以下を表示する。

- 自分のアバター
- ロビーコード
- ミュート/デafenボタン
- 他プレイヤーのアバター
- 接続状態アイコン
- 個別音量/ミュート操作
- エラー表示
- デバッグオーバーレイ

通常版では `Avatar` を lazy load し、Lite 版では軽量画像ベースのアバターを使う。

### 12.3 設定

設定は `electron-store` に保存され、`SettingsContext` 経由で参照・更新する。

代表設定:

- 言語
- マイク/スピーカー
- サーバー URL
- ショートカット
- 音量
- VAD / マイク感度
- オーバーレイ表示
- 空間音声
- ロビー音声ルール
- 起動プラットフォーム

## 13. オレンジ状態の自動修復設計

`VoiceAvatar` の `connectionState="novoice"` は、Socket.IO 上では相手の `socketId` と `clientId` を認識しているが、該当 peer の `audioConnected[peer]` が成立していない状態である。

3.1.95 では、この状態を全体再接続ではなく相手 peer 単位で修復する。

主な修復トリガー:

- peer 作成後、`PEER_NO_AUDIO_RECONNECT_MS` 内に `stream` イベントが来ない
- remote audio track が存在しない
- remote audio track が一定時間 `mute` のまま
- remote audio track が `ended` になる
- ICE / peer connection が `failed` または `disconnected` になる
- `setClient` / `setClients` で相手一覧のみが届き、peer が未作成のまま残る

修復時は `schedulePeerReconnect(peer, client, initiator, ...)` により該当 peer のみを再作成する。A、B、C が同じロビーにいて B だけがオレンジ状態になった場合、再接続対象は B の peer のみであり、C との接続は維持する。

例外として、Socket.IO 自体の切断、ロビー変更、MENU 遷移、画面 cleanup 時はローカルが保持する全 peer を破棄する。Socket.IO が復帰した場合は `id` / `join` を再送し、ロビー内 peer を再確立する。

## 14. オーバーレイ設計

### 13.1 ネイティブオーバーレイ

`electron-overlay-window` で Among Us ウィンドウへ透過 BrowserWindow を attach する。オーバーレイ有効化は `enableOverlay` IPC で行い、実際に表示するには `BETTERCREWLINK_ENABLE_OVERLAY=1` または `--enable-overlay` が必要である。

表示失敗時は最大 8 回リトライする。

### 13.2 表示内容

`Overlay.tsx` は以下を表示する。

- ウォーターマーク
- 発話者アバター
- 会議 HUD の発話枠

表示可否は設定とゲーム状態で決まる。

- `enableOverlay=false`: 何も表示しない
- `gameState=MENU`: 何も表示しない
- `meetingOverlay=true` かつ `DISCUSSION`: 会議 HUD 表示
- `overlayPosition !== hidden`: アバター表示

匿名/見た目変化状態では名前表示を抑制する。

## 15. 設定・永続化設計

`src/renderer/settings/SettingsStore.tsx` が設定スキーマとマイグレーションを定義する。通常版は `config`、Lite 版は `config-lite` のように store 名を分離する。

オフセット関連も `getVariantStoreName()` により通常版/Lite 版で store を分ける。

`playerConfigMap` は肥大化防止のため、起動時に 50 件を超えている場合は `hook.ts` でクリアされる。

## 16. 問い合わせ投稿設計

`ipc-handlers.ts` は問い合わせフォーム用に以下を提供する。

- 添付ファイル選択
- 入力文字列のトリムと長さ制限
- 添付合計 24 MB 制限
- ログファイルの添付
- 大きいログは末尾 1 MB の一時ファイル化
- Discord Forum Webhook への JSON / multipart 投稿
- Forum tag の適用

Webhook URL は環境変数 `BETTERCREWLINK_DISCORD_FORUM_WEBHOOK_URL` を優先し、なければ `inquiryConfig` を使う。

## 17. 自動更新設計

`electron-updater` を使用する。本番のみ更新確認する。

状態は `AutoUpdaterState` としてレンダラーへ送る。

| 状態 | 意味 |
| --- | --- |
| `unavailable` | 更新なし、またはメタデータなし |
| `available` | 新しいバージョンあり |
| `downloading` | ダウンロード中 |
| `downloaded` | ダウンロード完了 |
| `error` | 更新エラー |

リモートバージョンが現在バージョンより新しい場合のみ更新対象とする。Lite 版は `lite` channel を使う。

## 18. ビルド・配布設計

### 17.1 通常版

`electron-builder.yml` を使用する。

- `appId`: `net.ottomated.crewlinkkai.beta.local`
- `productName`: `Better-CrewLinkKai`
- 出力先: `dist`
- Windows 実行ファイル名: `TanukiBCL`
- インストーラー名: `TanukiBCL-Setup-${version}.${ext}`
- GitHub Releases へ publish

### 17.2 Lite 版

`electron-builder-lite.yml` を使用する。

- `appId`: `net.ottomated.crewlinkkai.lite`
- `productName`: `BetterCrewLinkKaiLite`
- 出力先: `dist-lite`
- Windows 実行ファイル名: `TanukiBCLLite`
- インストーラー名: `TanukiBCLLite-Setup-${version}.${ext}`
- GitHub Releases の `lite` channel へ publish

## 19. エラー処理設計

| 領域 | 処理 |
| --- | --- |
| ゲームプロセス未検出 | `NOTIFY_GAME_OPENED=false` を通知 |
| 権限不足 | 管理者起動を促すエラー |
| オフセット取得失敗 | キャッシュへフォールバック。なければエラー |
| メモリ読取失敗 | プロセスハンドルをリセットし再検出。連続失敗でエラー通知 |
| マイク取得失敗 | `Voice` 画面にエラー表示 |
| Socket 接続失敗 | 一時的エラーは再試行/フォールバック |
| Peer 接続失敗 | 再接続、必要に応じて TURN へフォールバック |
| 更新メタデータ 404 | 更新なし扱い |
| 問い合わせ投稿失敗 | HTTP status と本文を含むエラー |

## 20. セキュリティ・権限制約

- Renderer は `nodeIntegration=true`, `contextIsolation=false` で動作する。Electron 11 世代の構成であり、外部コンテンツ読み込みには注意が必要である。
- Among Us のプロセスへアクセスするため、環境によっては管理者権限やセキュリティソフトの許可が必要になる。
- メモリ書き込み機能は一部実装されているが、ロビー参加機能は現状 `joinGame()` が `false` を返す。
- オーバーレイは対象ウィンドウへの attach が必要で、環境や起動順に依存する。
- WebRTC はネットワーク環境により P2P 接続できない場合があり、TURN relay へフォールバックする。

## 21. 現行実装上の注意点

- `Voice.tsx` に UI、Socket.IO、WebRTC、Web Audio、音声ルールが集中している。変更時の影響範囲が大きいため、音声制御変更では回帰確認が重要である。
- `src/renderer/handlers/ConnectionController.ts` と `AudioController.ts` はコメントアウトされた旧設計であり、現行実装の実体ではない。
- `GameReader.ts` は Among Us 本体バージョン、Mod、x86/x64、オフセット定義に強く依存する。
- オフセット JSON の外部取得に依存するため、ネットワーク障害時はキャッシュ有無が動作可否に直結する。
- Lite 版は一部 UI と機能を軽量化しており、ロビーブラウザは無効である。
- 通常版/Lite 版は store 名が分かれるため、設定移行や問い合わせでは対象 variant を意識する必要がある。

## 22. 主要データフロー

### 21.1 ゲーム状態更新

```text
START_HOOK
  -> hook.ts
  -> GameReader.loop()
  -> memoryjs reads Among Us
  -> AmongUsState
  -> NOTIFY_GAME_STATE_CHANGED
  -> App.tsx state update
  -> Voice.tsx audio rule update
  -> SEND_TO_OVERLAY
  -> Overlay.tsx redraw
```

### 21.2 音声接続

```text
AmongUsState has lobbyCode and local player
  -> Voice.tsx connect()
  -> Socket.IO join/id
  -> voice server returns peers
  -> simple-peer signal exchange
  -> WebRTC MediaStream
  -> Web Audio graph
  -> per-frame/game-state-based gain update
```

### 21.3 オーバーレイ

```text
settings.enableOverlay && game opened
  -> ipc enableOverlay
  -> main creates/attaches overlay window
  -> Overlay requests initial values
  -> App sends settings/game/voice/colors
  -> Overlay renders watermark, avatars, meeting HUD
```

## 23. 保守時の確認観点

音声ルールを変更する場合:

- ロビー、タスク、会議、メニューの各状態で音声が意図通りか
- 生存者/死亡者/インポスター/第三陣営の組み合わせ
- ベント、カメラ、通信サボタージュ、壁、視界連動
- 個別ミュート、デafen、マスター音量、ゴースト音量
- VAD とプッシュトゥトークの競合

ゲーム読取を変更する場合:

- x86/x64 両方のオフセット
- vanilla / Mod 導入環境
- ロビーコード変換
- `MENU -> LOBBY -> TASKS -> DISCUSSION -> TASKS -> MENU` の遷移
- プロセス再起動、権限不足、メモリ読取失敗時の復帰

オーバーレイを変更する場合:

- 通常版/Lite 版
- 会議 HUD の新旧レイアウト
- `compactOverlay`
- `overlayPosition`
- 発話者なし、未接続者、切断者、死亡者の表示

## 24. 参照ファイル

| ファイル | 内容 |
| --- | --- |
| `src/main/index.ts` | Electron 起動、Window、自動更新、オーバーレイ |
| `src/main/hook.ts` | START_HOOK、読取ループ、キーボードフック |
| `src/main/GameReader.ts` | Among Us メモリ読取、状態生成 |
| `src/main/offsetStore.ts` | オフセット取得/キャッシュ |
| `src/main/ipc-handlers.ts` | IPC ハンドラ、ゲーム起動、問い合わせ |
| `src/common/AmongUsState.ts` | ゲーム/プレイヤー/音声状態型 |
| `src/common/ipc-messages.ts` | IPC メッセージ定義 |
| `src/common/ISettings.d.ts` | 設定型 |
| `src/renderer/App.tsx` | メイン UI 状態管理 |
| `src/renderer/Voice.tsx` | 音声接続、音声制御、ボイス UI |
| `src/renderer/socket.ts` | Socket.IO v4/v2 互換接続 |
| `src/renderer/Overlay.tsx` | オーバーレイ UI |
| `src/renderer/settings/SettingsStore.tsx` | 設定スキーマ/マイグレーション |
| `electron-builder.yml` | 通常版ビルド設定 |
| `electron-builder-lite.yml` | Lite 版ビルド設定 |
