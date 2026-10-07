# BetterCrewLink Changelog

A changelog for BetterCrewLink in case people want to see changes from the new/old versions.

## v3.2.15

- NoSのインポスターラジオも、送信者のRadioData（Kind=0）のHearableMaskにある受信者のPlayerIdビットで受信可否を判定。役職や幽霊状態だけで受信を許可する処理を廃止。
- NoSのラジオ送信可否はチャンネルの存在と設定で判定し、送信者自身のビットが省略されていても送信可能。Radio表示も送信者のマスクから判定。
- マスクの未取得・更新待ちでも相手のラジオ送信中状態を保持し、通常の近距離音声へ戻ってしまう経路を防止。

## v3.2.14

- 通常版からWeb版へNoSのSkin・Hat・Visor・背面画像・体のマスクをPNGとして転送。加工済み画像をハッシュで識別し、通常のプレイヤー情報更新では画像IDだけ送信。
- 初回・装備変更時の画像転送、途中参加や不足画像の再送要求、ロビー・配信元の変更時のキャッシュ切り替えに対応。取得失敗時は自動再試行。
- Lite版は引き続きコスチューム画像を取得・転送しない。
- 表示には対応するWeb側の受信・表示処理の更新も必要。公開済みWeb版3.6単体では表示されない。

## v3.2.13

- Lite版からコスチューム画像と体のマスク表示を削除。色を反映したシンプルなアバターを使用し、通常表示でのコスチューム画像の取得も停止。

- SNRのカスタムコスチューム画像を、起動中のゲームフォルダ内のSuperNewRolesNext/CustomCosmeticsから読み取るよう変更。GitHub上の画像を優先せず、外部の帽子一覧の読み込み完了を待たずにローカル画像を表示。

- 通常版でNoSのロビーの試合用PlayerDataが未取得でも、現在のSkin・Hat・Visor IDとNoSの色からアバター画像を表示。装備変更・解除に追従するよう修正。

## v3.2.12

- インポスターラジオ専用モード以外で、タスク中のラジオの声が近くのクルーに聞こえていた問題を修正。ラジオ使用中の声は、同じチームの生存者と幽霊にのみ届くように変更（ジャッカルのラジオも幽霊に届くように統一）。
- アバターのHat・Visorが発話時の枠からはみ出さないよう、通常画面・オーバーレイとも枠と同じ円で切り取るように変更。
- NoSのSkin・Hat・Visor・色をロビーでもアバターに反映。
- 誤って公開していたv3.2.11から更新できるよう、バージョンを3.2.12に変更。

## v3.2.9

- デバッグ利用の招待コード登録画面を追加。管理者発行の1回限り・期限付きコードで担当者自身がパスワードを登録でき、再発行・失効に対応。

- デバッグのプレイヤー情報をカード形式に整理。役職・状態を先頭に置き、判定・座標/サイズ・外見・Radioを区分。ウィンドウ幅に応じた折り返しとtrue/false/未取得の凡例を追加。
- 各プレイヤーの詳細を個別に最小化・展開できるように変更。最小化中も名前・役職/陣営・生存状態・IDを表示し、自動更新や検索でも開閉状態を保持。
- NoSのプレイヤー情報が未取得の場合、最小化中もカードの赤枠と「NoS未取得」で表示。取得後は通常表示に復帰。
- 未使用のsizeScale・specialRoleと旧サイズ推定処理を削除。NoSのBodyRate、SNRのジャンボサイズは引き続き使用。
- デバッグのプレイヤー一覧にRadio送信状態とNoSのRadioDataを追加。チャンネル名・Kind・HearableMask・声が届くプレイヤー名/IDを常時表示。
- デバッグのプレイヤー一覧に座標・サイズ・元/外見のSkin・Hat・Visor IDを追加。NoSのBodyRate・コスチューム名、SNRのジャンボサイズ・Hat2/Visor2も同じ一覧に表示。
- SNRの詳細取得ボタンを廃止し、既存の約5秒ごとの取得結果から割り当て陣営・勝利陣営・チームを自動表示。初回取得失敗も10秒後に自動再試行。
- デバッグ画面に検索可能な役職一覧を追加。参加者ごとのSNR・NoS・TOH4E固有値とベタクル判定を整理し、未取得とfalseを区別。タブ切り替えを廃止し、NoSのコスチューム・無線・一覧ファイル、SNRの詳細取得、音声接続・ログは同じ画面の折りたたみ項目に整理。
- バージョンが新しい側にも不一致通知を表示。異なるバージョンのプレイヤー名とバージョンを一覧表示。
- デバッグ認証用のSQLite管理APIとRaspberry Pi向けサービス設定を追加。HTTPS認証先を指定したビルドでは、パスワード変更・無効化を次回の認証から反映。
- NoSのSkin・Hat・Visor IDをアバターに反映。LoadedContents.jsonからローカル画像・アドオンZIPの画像を読み取り、Hat・Visorの左上フレーム、追加レイヤー、陣営色に連動する着色、体のマスクを通常版・Lite版に表示。

- NoSの読み取り失敗・更新停止が5秒続いた場合、読み取り位置を自動再取得。読み取りツールの異常終了後も5～30秒の間隔で自動再試行。

- 既存のデバッグ用パスワードを残したまま、確認担当者用のパスワードを追加するツールを追加。
- ホストとのバージョン差を検出し、古い側に更新通知を表示（双方が3.2.9以降の通知機能に対応している場合）。
- NoSデータが試合中に未取得・更新停止・読み取り失敗となった場合、右下のMOD表示を暗い赤色に変更。通常画面・オーバーレイの赤いMOD表示に失敗理由を表示し、自動再取得中も直前の理由を保持。デバッグ画面にも表示。
- NoS TBCLFields 20261005のSkin・Hat・Visorに対応。デバッグ画面にコスチューム名、定義バージョン、LoadedContents.jsonの内容と読み取り状態を表示。

## v2.8.6 - [2021-11-14]

### Added

- Added support for v2021.6.15.
- Added support up to 300 colors (to support certain mods).
- Small performance improvement (cached hats).

### Changed

- Changed the original hat system towards the mod hat system.

### Fixed

- Fixed hats for the new Among Us version (v2021.6.15).

## v2.8.5 - [2021-11-10]

### Added

- Support for new Among Us version: v2021.11.9.2 (hats not supported yet will be soon).
- Added support for the old version of Among Us (v2021.6.30s) so people with other mods can still play.

### Changed

- The position of the ping have been changed.
- The size of the ping have been decreased.

### Fixed

- Small performance fixes.
- Fixed issue with reading some states which could of be the cause of loss of audio.

## v2.8.0 - [2021-09-10]

### Added

- Added the version of BCL that you are using in the ping tracker.
- Added Custom Launches.
- Added Hungarian (not complete), Korean and Norwegian translations.
- Added Support to Polus.gg and Submerged. (it's at the beginning, there might be some bugs)
- Added Platform Detection for Linux.
- Added Support for 15 players in the Overlay.

### Changed

- Decreased the Ping Tracker Size.
- Reworked all of the Collider Maps & Doors.

### Fixed

- Fixed the Impostor Radio when it is disabled but it still works.
- Fixed the bug of Hearing Everyone from Anywhere on the map on Disconnects.
- Fixed the Doors not working with the Wall Blocks Audio enabled.

### Removed

- Removed the Extra Roles in Public Lobby Settings.

## [v2.7.5](https://github.com/OhMyGuus/BetterCrewLink/releases/tag/v2.7.5) - [2021-07-07]

### Added

- Support for new version of Among Us.

### Fixed

- Fixes in the overlay (thanks to [JKohlman](https://github.com/JKohlman)).
- Fixed Public Lobby List.
- Other small fixes.
