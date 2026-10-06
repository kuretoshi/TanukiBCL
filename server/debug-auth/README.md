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
