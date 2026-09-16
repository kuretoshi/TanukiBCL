# SuperNewRolesの役職・第三陣営の解析

調査日: 2026-09-14。TanukiBCLの判定処理を変更する前のソース解析。

## 対象

- 公開masterを取得時点のコミット [`4225b8a27df1660371d2ef43e81ce87514267a65`](https://github.com/SuperNewRoles/SuperNewRoles/tree/4225b8a27df1660371d2ef43e81ce87514267a65) に固定して確認した。
- ローカルのSNRランチャー配下のDLLのFileVersion/ProductVersionは3.2.0.3。
- タグ3.2.0.3（`5b555eb8824e477f2a6e69828f37610952337724`）のExPlayerControl、AssignRoles、JackalFriendsも確認し、以下の主要な役職・陣営構造があることを確認した。バージョン文字列だけでローカルDLLとソースの完全一致は保証できない。
- 取得したソースとコミット記録はGit管理対象外の`.tools/snr-review`に保存。巨大なリポジトリ全体の取得やゲームメモリへの書き込みは行っていない。

## 結論

「本体ではクルーメイト扱いのプレイヤーに、MOD独自の役職・能力を持たせる」という説明はソースと整合する。ただし「追加情報があれば第三陣営」という判定は誤り。通常のクルー役職、インポスター協力役、第三陣営、追加属性のいずれにも拡張情報がある。

また、SNRのAssignedTeam（割り当て分類）、WinnerTeam（勝利陣営）、TeamTag（チーム分類）、能力が持つ現在の所属は別概念である。TanukiBCLの単一の`isThirdParty`へ直結する前に、どの概念を音声仕様で使うかを決める必要がある。

## 役職の作り方

1. 本体の役職割り当てでCrewmate/Impostorを割り当てる。
2. SNRの第三陣営の割り当ては`AssignTickets(..., false, MaxNeutrals)`で非インポスターの候補から選ぶ。
3. `RpcCustomSetRole`が`ExPlayerControl.SetRole`を呼び、SNR独自のRoleIdを設定する。
4. `CustomRoleManager`でRoleIdから役職定義を引き、その`OnSetRole`で能力インスタンスを生成してプレイヤーへ付ける。

根拠: [AssignRoles.cs](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/AssignRoles.cs#L145-L168)、[候補の選別](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/AssignRoles.cs#L274-L280)、[RPC](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Modules/PlayerControlRpcExtensions.cs#L16-L37)、[能力付与](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/RoleBase.cs#L97-L108)。

`IntroSoundType`はイントロ音の指定であり、本体の実役職や勝利陣営の判定に使ってはいけない。例えばJackalはここにShapeshifterを指定している。

## 本体とは別に保持する情報

`ExPlayerControl`にはPlayer/Dataへの参照とPlayerIdに加え、次が存在する。

- `Role` / `roleBase`: SNRの役職IDとその定義。
- `ModifierRole` / `ModifierRoleBases`: 追加属性。ビットフラグのORで追加され、複数保持できる。
- `GhostRole` / `GhostRoleBase`: 死亡後の役職。
- `_playerAbilities`、`_abilitiesById`: 役職・追加属性などから付けられた能力。
- `_exPlayerControlsArray[256]`: PlayerIdで引けるSNR側のプレイヤー配列。通常のClientIdとは区別する必要がある。

根拠: [ExPlayerControlのフィールド](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Modules/ExPlayerControl.cs#L39-L79)、[追加属性の設定](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Modules/ExPlayerControl.cs#L186-L207)。

## 単純な判定で誤る具体例

| SNR役職 | AssignedTeam | WinnerTeam | 意味 |
| --- | --- | --- | --- |
| DefaultCrewmate | Crewmate | Crewmate | 通常クルー |
| Jackal | Neutral | Neutral | 第三陣営。TeamTagはJackal |
| JackalFriends | Crewmate | Neutral | クルー枠だがジャッカル勝利側 |
| Madmate | Crewmate | Impostor | クルー枠だがインポスター勝利側 |

根拠: [DefaultCrewmate](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/CrewMate/DefaultCrewmate.cs)、[Jackal](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/Neutral/Jackal.cs)、[JackalFriends](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/Neutral/JackalFriends.cs)、[Madmate](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/Madmates/Madmate.cs)。

SNR自身の`IsNeutral()`は`roleBase.AssignedTeam == Neutral`を見る。この条件だけではJackalFriendsは含まれない。`IsCrewmate()`はMad系能力とFriend系能力を除外する。`IsImpostorWinTeam()`、`IsJackalTeamWins()`はそれぞれ協力役を含む別の判定を行っている。

SchrodingersCatは能力の`CurrentTeam`が試合中に変化するため、RoleIdから引いた固定表だけでは所属を決められない。Loversなどの追加属性も存在し、役職の勝利分類だけで全ての勝利条件を表現できない。

根拠: [SNRの各種判定](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Modules/ExPlayerControl.cs#L645-L679)、[SchrodingersCatAbility](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/Ability/SchrodingersCatAbility.cs#L107-L136)、[Lovers](https://github.com/SuperNewRoles/SuperNewRoles/blob/4225b8a27df1660371d2ef43e81ce87514267a65/SuperNewRoles/Roles/Modifiers/Lovers.cs)。

## TanukiBCLへの影響と実装方針

現在のGameReaderは本体のroleTeamを読み、`0/1以外`を第三陣営とする。そのため本体のCrewmate枠にいるSNRの第三陣営は取りこぼす。rolePtrの周囲に追加の数値があるか、能力が1つ以上あるか、といった条件で補正してはいけない。

提案する処理順序:

1. 接続対象のPIDとSNRのバージョンを確認する。
2. 本体のPlayerIdとSNRのExPlayerControlを対応付ける。
3. RoleId、ModifierRole、GhostRole、AssignedTeam、WinnerTeam、TeamTagを個別に取得する。
4. 必要に応じてMadmate/JFriend系能力、SchrodingersCatのCurrentTeamなど動的状態を取得する。
5. 「本体役職」「SNR役職」「割り当て陣営」「勝利側・協力先」「追加属性」「判定可否」をデバッグ表示して検証する。
6. 役職ごとの期待結果が合った後、第三陣営の幽霊音声などへ反映する。

勝利側の分類にWinnerTeamは有用だが、単独で全てを解決するものではない。取得失敗時は「SNR役職未取得」として扱い、本体Crewmateを根拠にSNRでも通常クルーと断定しない。インポスター用無線やキル能力と勝利側も混同しない。

## メモリ取得の課題

SNRはnet6.0の管理コードで、実機でもcoreclr.dllが読み込まれていた。ExPlayerControlは管理オブジェクトなので、本体のIL2CPP側rolePtrの固定オフセットにSNRのRoleIdが必ず続いているとはいえない。

DLLのロード検出と、管理ヒープ上のプレイヤー情報の取得は別の作業。ソースから論理的なフィールドは分かるが、実アドレス・フィールドオフセット・GC移動への対応はまだ確定していない。

取得手段の候補は、SNR側の協力を得て読み取り用のローカル連携データを出す方法、またはCoreCLRのメタデータと管理ヒープを読み取る方法。前者ではPlayerId・セッション識別子・役職・所属をSNR側で解決して渡せる。後者ではランタイムとDLLバージョンに対応した管理オブジェクトの探索が必要になる。いずれも未実装で、現段階で「役職が取得できた」とは扱わない。

検証ケース: Vanilla、通常クルー、クルー特殊役職、Jackal、JackalFriends、Madmate、SchrodingersCatの所属変更、Modifier付与、死亡/会議、ゲーム再起動。ミニ・ジャンボの未完成判定は引き続き無効のままとする。

## 2026-09-15: 管理メモリ読み取りの試作

`tools/SnrRoleReader`にWindows x86用の読み取りツールを追加した。Microsoft.Diagnostics.Runtime (ClrMD) 3.1.512801でプロセスのスナップショットを作り、SNRのExPlayerControlの静的配列からPlayerId・Role・ModifierRole・GhostRole・roleBaseの陣営値・能力のCurrentTeamを読み取る。列挙値の名前は、実際にロードされたSNR DLLのメタデータから取得する。ゲームへのメモリ書き込みやコード注入は行わない。

デバッグウィンドウの「SNR役職」タブで「SNR役職を取得」を押すと、その時点の値を表示する。取得に失敗した場合は古い結果を消してエラーを表示する。既存の音声判定には反映しない。スナップショット取得は短いゲーム停止を伴う可能性があるため、現段階では連続ポーリングしない。[ClrMDのスナップショット説明](https://github.com/microsoft/clrmd/blob/main/doc/GettingStarted.md#attaching-to-a-live-process)

ビルドには.NET 8 SDKを使用する（この環境では`.tools/dotnet-sdk`に導入済み）。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-snr-reader.ps1
npm.cmd run build
```

生成物は`out/debug-reader`。通常版・Lite版ともASARの外に展開する設定を追加した。取得ツールが存在しないビルドでは画面に未ビルドと表示する。

確認済み:

- 型検査、アプリと読み取りツールのビルド。
- 同じ管理オブジェクト構造のテスト用プロセスから、Role=JackalFriends、AssignedTeam=Crewmate、WinnerTeam=Neutralを実際に読み取った。
- Electronのデバッグ画面でその結果を表示し、次の取得が失敗すると古い結果が消えることを確認した。
- 起動中のSNRからCoreCLRとExPlayerControl型を確認できた。ただし現時点の取得結果は「Player array is not initialized」で、実ゲームの役職値は未検証。役職割り当て後の再取得と、実際の役職との照合が必要。

この試作のインストーラーは未作成。テストプロセスでの成功と実ゲームでの成功は区別する。
