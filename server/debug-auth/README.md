# Raspberry Pi用デバッグ認証

Python 3.9以降、SQLite、Flask、Gunicornで動作します。パスワードはソルト付きPBKDF2-SHA256で保存します。管理者はSSHで招待コードを発行し、担当者はWeb画面でパスワードを登録できます。変更・無効化はSSHから行います。

## 配置

既存サービス・HTTPS設定を確認してから、専用ユーザー `tanuki-debug-auth` を作成し、このディレクトリのファイルを `/opt/tanuki-debug-auth` に配置します。

```sh
sudo useradd --system --home /var/lib/tanuki-debug-auth --shell /usr/sbin/nologin tanuki-debug-auth
sudo install -d -m 755 /opt/tanuki-debug-auth
sudo install -d -o tanuki-debug-auth -g tanuki-debug-auth -m 700 /var/lib/tanuki-debug-auth
sudo python3 -m venv /opt/tanuki-debug-auth/.venv
sudo /opt/tanuki-debug-auth/.venv/bin/pip install -r /opt/tanuki-debug-auth/requirements.txt
sudo install -m 644 /opt/tanuki-debug-auth/tanuki-debug-auth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tanuki-debug-auth
curl http://127.0.0.1:8765/health
```

APIはループバックだけで待ち受けます。`nginx-location.conf` を既存のHTTPSサーバー設定に追加し、`nginx -t` で確認してから再読み込みしてください。公開用HTTPSのURLは、LAN外からもアクセスできることを確認してください。SQLiteファイルは公開しません。

## 招待コードでの担当者登録

担当者にはHTTPSの `/debug-register` と招待コードを渡します。担当者が12文字以上のデバッグ用パスワードを自分で設定できます。コードは一度限りで、標準72時間有効です。登録名は発行時に固定され、既存登録の上書きはできません。

```sh
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py invite 担当者名
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py invite 担当者名 --hours 24
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py revoke-invite 担当者名
```

同じ名前のコードを再発行すると以前の未使用コードは失効します。DBにはコードのハッシュだけを保存します。登録上限は従来と共通で16名です。公開時は `nginx-location.conf` の登録APIと画面の設定も含めてください。配置には `registration` ディレクトリも必要です。

## SSHからのパスワード管理

```sh
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py set 担当者名
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py list
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py disable 担当者名
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py remove 担当者名
```

`set` は非表示の入力でパスワードを2回尋ねます。同じ名前なら更新し、無効化済みの場合は再び有効になります。最大16件です。アプリ再配布やサービス再起動は不要です。パスワードが同じ担当者は区別できないため、それぞれ別のパスワードを使ってください。

失効は次回のデバッグ画面を開く操作から適用されます。すでに開いている画面を遠隔で閉じる機能はありません。通常の通話機能は認証APIの停止に影響されません。

## お問い合わせのDiscord送信先

デバッグパスワードとは別のSQLiteテーブル `inquiry_webhooks` に、本家用 `tanuki` と.NET用 `net` のWebhookを1件ずつ保存します。アプリにはWebhook URLを含めず、両アプリは `https://debug-auth.kuretoshi.work/v1/inquiries` に報告を送ります。製品識別子は送信先の選択用であり、認証情報ではありません。公開APIは1送信元あたり毎時10件・全体で毎時120件に制限します。

新版ベタクルと3.2.28以降の.NET版は、それぞれの公開GitHub Issueを先に作成し、そのURL付きで各Discordフォーラムへ投稿します。Discordスレッドの返信・編集・削除・件名変更はBotが対応するIssueへ反映します。公開確認を送らない旧版の問い合わせは従来のDiscord直送を維持します。新版の画面には、本文・手動添付・自動添付ログが公開される旨と確認チェックを表示します。添付ファイルは受付サーバーのSQLiteに保存し、推測困難な公開ダウンロードURLをIssueに掲載します。公開ファイルは現状自動削除しないため、DBとバックアップ容量を監視してください。

`INQUIRY_DISCORD_FORUM_ID_TANUKI` を設定すると、ベタクル用フォーラムに人が直接作成した投稿も公開GitHub Issueに登録します。有効化後の新規投稿だけが対象で、開始時刻はSQLiteに保存されるためBot停止中の投稿も再起動時に取得できます。元投稿・返信・件名・タグの編集や削除もIssueに反映します。BotやWebhookが作成した投稿、.NET用フォーラム、過去の投稿は取り込みません。Discordのフォーラム案内文にも、投稿と添付が公開Issueになることを明記してください。

GitHub側では `kuretoshi/TanukiBCL` と `kuretoshi/BetterCrewLink_Net` のIssuesを有効にします。リポジトリごとにIssuesの読み書き権限を持つトークンをサーバーだけに設定し、Discord Botを両製品のフォーラムがあるサーバーへ追加してチャンネル閲覧・履歴閲覧権限を付け、Bot設定でMessage Content Intentを有効にします。Botには返信の送信権限は不要です。両トークンはPiの `/etc/tanuki-inquiry-bridge.env` に保存し、所有者root・権限0600にします。

```ini
INQUIRY_GITHUB_REPO_TANUKI=kuretoshi/TanukiBCL
INQUIRY_GITHUB_REPO_NET=kuretoshi/BetterCrewLink_Net
INQUIRY_GITHUB_TOKEN=...
INQUIRY_GITHUB_TOKEN_NET=...
INQUIRY_DISCORD_BOT_TOKEN=...
INQUIRY_DISCORD_FORUM_ID_TANUKI=ベタクル用フォーラムのチャンネルID
INQUIRY_PUBLIC_BASE=https://debug-auth.kuretoshi.work
```

Piへ `issue_bridge.py`、`discord_bridge.py`、`tanuki-inquiry-discord.service` も配置します。`tanuki-debug-auth.service` とBotサービスの両方が同じ環境ファイル・SQLiteを使います。Python依存を更新後、サービスファイルをsystemdに配置して `daemon-reload` し、受付APIとBotを再起動・起動します。nginxには `/v1/inquiries/attachments/` のGETルートを追加し、`nginx -t` の後に反映します。Botの起動ログに接続完了が出ること、Issue作成・Discord投稿・返信編集・添付ダウンロードを確認してから新版アプリを配布します。

既存Piの環境ファイルに `INQUIRY_GITHUB_REPO_NET` を追加せずに運用する場合は、`net-issue-repository.conf` を `/etc/systemd/system/tanuki-debug-auth.service.d/` に配置し、`systemctl daemon-reload` とサービス再起動を行えます。GitHubトークンは引き続き環境ファイルにのみ置き、.NET専用トークンには.NETリポジトリのIssues読み書き権限を付けてください。

トークンを設定する際は、Piで `bash /opt/tanuki-debug-auth/configure-inquiry-bridge.sh` を実行します。2つのトークンを非表示入力で受け取り、rootのみ読める環境ファイルを作成して受付APIとBotを起動します。トークンをコマンド引数やチャットに貼らないでください。

既存の通常版GitHubトークンとDiscord Botトークンを変えずに.NET専用トークンを追加・更新する場合は、Piで `sudo /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/update_inquiry_github_token.py` を実行します。.NET用トークンを非表示で入力し、.NETリポジトリのIssues書き込み権限だけを検査してから、既存の環境ファイルを権限0600で原子的に更新します。通常版トークンを単独で更新する場合は `--product tanuki` を付けます。成功後に `sudo systemctl restart tanuki-debug-auth.service tanuki-inquiry-discord.service` を実行してください。トークンはチャットやコマンド引数に貼らないでください。

Piへ `auth.py`、`inquiry.py`、実運用の `nginx-tunnel.conf` を配置し、`nginx -t` 後にnginxの設定を反映してサービスを再起動した後、**Pi上で**以下を実行してください。別のHTTPS構成で `nginx-location.conf` を使っている場合はそちらも更新します。新規チャンネルがDiscordフォーラムなら、そのチャンネル内にWebhookを作り、フォーラムタグのIDを指定します。タグが不要なら `--question-tag` 等は省略できます。通常のテキストチャンネルなら `--kind text` を指定し、タグIDは指定しません。

```sh
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py webhook-set tanuki --kind forum --question-tag 111111111111111111 --bug-tag 222222222222222222 --request-tag 333333333333333333
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py webhook-set net --kind forum --question-tag 444444444444444444 --bug-tag 555555555555555555 --request-tag 666666666666666666
sudo -u tanuki-debug-auth /opt/tanuki-debug-auth/.venv/bin/python /opt/tanuki-debug-auth/auth.py webhook-list
```

上の数字は例なので、**実際の各フォーラムのタグIDに置き換えてください**。各 `webhook-set` はWebhook URLを非表示で2回入力します。URLを引数に渡したり、Gitやチャットに貼ったりしないでください。`webhook-list` は設定済みの製品とチャンネル種別だけを表示し、URLは表示しません。URLを変更するときは同じ `webhook-set` を再実行します。送信先を止めるときは `webhook-remove tanuki` または `webhook-remove net` を使います。DBは平文でWebhookを保持するため、SQLiteファイルとバックアップの権限を限定してください。

公開済みの旧アプリには以前のWebhookが残っています。新しい両アプリの配布と受付APIの確認後、旧WebhookをDiscord側で削除・再発行してください。旧版の報告機能はその時点で使えなくなるため、更新案内も必要です。Git履歴の削除だけでは旧Webhookを無効化できません。

## アプリの設定

現在のPiの公開先は `https://debug-auth.kuretoshi.work` です。担当者には `https://debug-auth.kuretoshi.work/debug-register` と招待コードを渡します。

Piでは `nginx-tunnel.conf` を `/etc/nginx/conf.d/tanuki-debug-auth.conf` に配置し、Cloudflare Tunnelの `debug-auth.kuretoshi.work` を `http://127.0.0.1:8766` に転送しています。既存のPDF用Tunnelと共用し、認証APIは `127.0.0.1:8765` で動きます。

PowerShellで、確認済みのHTTPS URLを指定してビルドします。

```powershell
$env:TANUKI_DEBUG_AUTH_URL = 'https://debug-auth.kuretoshi.work/v1/debug-auth/verify'
npm run build
```

3.2.9の通常ビルドは上記APIを使用します。毎回APIを照合し、通信失敗時にローカルパスワードへ切り替えません。環境変数に別のHTTPS URLを指定すると変更でき、明示的に空文字を指定すると従来のローカル認証を使用します。URLは音声サーバー設定とは別で、ビルド時に固定されます。

## テスト

```sh
python -m unittest discover -s server/debug-auth -p test_auth.py
node scripts/test-remote-debug-auth.mjs
```
