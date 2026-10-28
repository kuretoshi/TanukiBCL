"""SQLite-backed debug authentication with administrator-issued invitations."""
import argparse
from contextlib import closing
import getpass
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3
import time

import inquiry
import issue_bridge

MAX_PASSWORDS = 16


def connect(path):
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def initialize(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS passwords (
                name TEXT PRIMARY KEY,
                salt BLOB NOT NULL,
                hash BLOB NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attempts (
                source TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS attempts_timestamp ON attempts(timestamp);
            CREATE TABLE IF NOT EXISTS invitations (
                digest TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS player_bans (
                uid_digest TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                friend_code TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS player_ban_uids (
                uid_digest TEXT PRIMARY KEY,
                player_uid TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pending_player_name_bans (
                player_name TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS player_history (
                uid_digest TEXT PRIMARY KEY,
                player_uid TEXT NOT NULL,
                display_name TEXT NOT NULL,
                friend_code TEXT NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS player_history_last_seen ON player_history(last_seen_at DESC);
        """)
    os.chmod(path, 0o600)
    inquiry.initialize(path)


def derive(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000, 32)


def set_password(path, name, password):
    if not isinstance(name, str) or not name.strip() or len(name) > 128:
        raise ValueError('Name must contain 1 to 128 characters.')
    if not isinstance(password, str) or not password or len(password) > 1024:
        raise ValueError('Password must contain 1 to 1024 characters.')
    salt = secrets.token_bytes(16)
    digest = derive(password, salt)
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT name FROM passwords WHERE name=?', (name,)).fetchone()
        if not existing and db.execute('SELECT COUNT(*) FROM passwords').fetchone()[0] >= MAX_PASSWORDS:
            raise ValueError('At most 16 passwords are supported; remove an unused record first.')
        db.execute("""INSERT INTO passwords(name,salt,hash,enabled,updated_at) VALUES(?,?,?,1,?)
                      ON CONFLICT(name) DO UPDATE SET salt=excluded.salt, hash=excluded.hash,
                      enabled=1, updated_at=excluded.updated_at""", (name, salt, digest, int(time.time())))


def verify(path, password):
    if not isinstance(password, str) or not password or len(password) > 1024:
        return False
    with closing(connect(path)) as db:
        records = db.execute('SELECT salt,hash FROM passwords WHERE enabled=1').fetchall()
    # Evaluate every record rather than exposing the matching record's position.
    results = [hmac.compare_digest(derive(password, row['salt']), row['hash']) for row in records]
    return any(results)


def verify_ban_admin(path, password):
    name = os.environ.get('BAN_ADMIN_NAME', '').strip()
    if not name or not isinstance(password, str) or not password or len(password) > 1024:
        return False
    with closing(connect(path)) as db:
        row = db.execute('SELECT salt,hash FROM passwords WHERE name=? AND enabled=1', (name,)).fetchone()
    return bool(row) and hmac.compare_digest(derive(password, row['salt']), row['hash'])


def uid_digest(uid):
    if not isinstance(uid, str) or not 1 <= len(uid) <= 256 or uid != uid.strip():
        raise ValueError('A valid player UID is required.')
    return hashlib.sha256(uid.encode('utf-8')).hexdigest()


def validate_uid_digest(digest):
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('Ban identifier is invalid.')
    return digest


def list_bans(path):
    with closing(connect(path)) as db:
        return [dict(row) for row in db.execute(
            '''SELECT b.uid_digest,b.display_name,b.friend_code,b.reason,b.created_at,
                      COALESCE(u.player_uid,'') AS player_uid
               FROM player_bans b LEFT JOIN player_ban_uids u ON b.uid_digest=u.uid_digest
               ORDER BY b.created_at DESC''')]


def list_pending_name_bans(path):
    with closing(connect(path)) as db:
        return [dict(row) for row in db.execute(
            'SELECT player_name,reason,created_at FROM pending_player_name_bans ORDER BY created_at DESC')]


def list_player_history(path, name='', from_seen=None, to_seen=None, offset=0, limit=50):
    validate_history_search(name, from_seen, to_seen, offset)
    with closing(connect(path)) as db:
        conditions = []
        params = []
        if name:
            conditions.append('instr(lower(h.display_name), lower(?)) > 0')
            params.append(name)
        if from_seen is not None:
            conditions.append('h.last_seen_at >= ?')
            params.append(from_seen)
        if to_seen is not None:
            conditions.append('h.last_seen_at < ?')
            params.append(to_seen)
        where = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
        total = db.execute('SELECT COUNT(*) FROM player_history h ' + where, params).fetchone()[0]
        rows = db.execute('''SELECT h.uid_digest,h.display_name,h.friend_code,h.first_seen_at,h.last_seen_at,
                                    CASE WHEN b.uid_digest IS NULL THEN 0 ELSE 1 END AS is_banned
                             FROM player_history h LEFT JOIN player_bans b ON h.uid_digest=b.uid_digest
                             ''' + where + ''' ORDER BY h.last_seen_at DESC,h.uid_digest
                             LIMIT ? OFFSET ?''', (*params, limit, offset)).fetchall()
        return [dict(row) for row in rows], total


def validate_history_search(name, from_seen, to_seen, offset):
    valid_timestamp = lambda value: value is None or (type(value) is int and 0 <= value <= 4102444800)
    if (not isinstance(name, str) or len(name) > 80 or type(offset) is not int or
            offset < 0 or offset > 100000 or not valid_timestamp(from_seen) or
            not valid_timestamp(to_seen) or
            (from_seen is not None and to_seen is not None and from_seen >= to_seen)):
        raise ValueError('History search is invalid.')


def validate_player_name(name):
    if not isinstance(name, str) or not name or name != name.strip() or len(name) > 80:
        raise ValueError('A player name of 1 to 80 characters is required.')
    return name


def record_player_history(db, uid, name, friend_code, now):
    digest = uid_digest(uid)
    name = validate_player_name(name)
    if not isinstance(friend_code, str) or len(friend_code) > 80:
        raise ValueError('Friend code is invalid.')
    db.execute('''INSERT INTO player_history VALUES(?,?,?,?,?,?)
                  ON CONFLICT(uid_digest) DO UPDATE SET
                  display_name=excluded.display_name,
                  friend_code=CASE WHEN excluded.friend_code<>'' THEN excluded.friend_code
                                   ELSE player_history.friend_code END,
                  last_seen_at=MAX(player_history.last_seen_at,excluded.last_seen_at)''',
               (digest, uid, name, friend_code.strip(), now, now))
    return digest


def add_pending_name_ban(path, name, reason=''):
    name = validate_player_name(name)
    if not isinstance(reason, str) or len(reason) > 500:
        raise ValueError('Ban details are invalid.')
    with closing(connect(path)) as db, db:
        db.execute('''INSERT INTO pending_player_name_bans VALUES(?,?,?)
                      ON CONFLICT(player_name) DO UPDATE SET reason=excluded.reason''',
                   (name, reason.strip(), int(time.time())))


def remove_pending_name_ban(path, name):
    name = validate_player_name(name)
    with closing(connect(path)) as db, db:
        db.execute('DELETE FROM pending_player_name_bans WHERE player_name=?', (name,))


def add_ban(path, uid, display_name='', friend_code='', reason=''):
    digest = uid_digest(uid)
    for value, limit in ((display_name, 80), (friend_code, 80), (reason, 500)):
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError('Ban details are invalid.')
    with closing(connect(path)) as db, db:
        db.execute('INSERT INTO player_bans VALUES(?,?,?,?,?) ON CONFLICT(uid_digest) DO UPDATE SET '
                   'display_name=excluded.display_name,friend_code=excluded.friend_code,reason=excluded.reason',
                   (digest, display_name.strip(), friend_code.strip(), reason.strip(), int(time.time())))
        db.execute('''INSERT INTO player_ban_uids VALUES(?,?)
                      ON CONFLICT(uid_digest) DO UPDATE SET player_uid=excluded.player_uid''', (digest, uid))
    return digest


def add_ban_from_history(path, digest, reason=''):
    digest = validate_uid_digest(digest)
    if not isinstance(reason, str) or len(reason) > 500:
        raise ValueError('Ban details are invalid.')
    with closing(connect(path)) as db, db:
        record = db.execute('''SELECT player_uid,display_name,friend_code FROM player_history
                               WHERE uid_digest=?''', (digest,)).fetchone()
        if not record:
            raise ValueError('Player history was not found.')
        db.execute('''INSERT INTO player_bans VALUES(?,?,?,?,?)
                      ON CONFLICT(uid_digest) DO UPDATE SET
                      display_name=excluded.display_name,friend_code=excluded.friend_code,
                      reason=excluded.reason''',
                   (digest, record['display_name'], record['friend_code'], reason.strip(), int(time.time())))
        db.execute('''INSERT INTO player_ban_uids VALUES(?,?)
                      ON CONFLICT(uid_digest) DO UPDATE SET player_uid=excluded.player_uid''',
                   (digest, record['player_uid']))


def remove_ban(path, digest):
    digest = validate_uid_digest(digest)
    with closing(connect(path)) as db, db:
        db.execute('DELETE FROM player_bans WHERE uid_digest=?', (digest,))
        db.execute('DELETE FROM player_ban_uids WHERE uid_digest=?', (digest,))


def issue_invitation(path, name, hours=72):
    if not isinstance(name, str) or not name.strip() or len(name) > 128 or not 1 <= hours <= 720:
        raise ValueError('Use a name of 1 to 128 characters and expiry of 1 to 720 hours.')
    code = secrets.token_urlsafe(24)
    digest = hashlib.sha256(code.encode()).hexdigest()
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM passwords WHERE name=?', (name,)).fetchone():
            raise ValueError('This name is already registered; use SSH to change its password.')
        db.execute('DELETE FROM invitations WHERE name=? AND used_at IS NULL', (name,))
        db.execute('INSERT INTO invitations VALUES(?,?,?,NULL)', (digest, name, int(time.time()) + hours * 3600))
    return code


def redeem_invitation(path, code, password):
    if not isinstance(code, str) or not code or len(code) > 128:
        return False
    if not isinstance(password, str) or not 12 <= len(password) <= 1024:
        raise ValueError('Password must contain 12 to 1024 characters.')
    digest = hashlib.sha256(code.encode()).hexdigest()
    salt = secrets.token_bytes(16)
    password_hash = derive(password, salt)
    now = int(time.time())
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        invitation = db.execute('SELECT * FROM invitations WHERE digest=? AND used_at IS NULL AND expires_at>?', (digest, now)).fetchone()
        if not invitation or db.execute('SELECT 1 FROM passwords WHERE name=?', (invitation['name'],)).fetchone():
            return False
        if db.execute('SELECT COUNT(*) FROM passwords').fetchone()[0] >= MAX_PASSWORDS:
            raise ValueError('Registration limit reached; contact the administrator.')
        db.execute('INSERT INTO passwords VALUES(?,?,?,1,?)', (invitation['name'], salt, password_hash, now))
        db.execute('UPDATE invitations SET used_at=? WHERE digest=?', (now, digest))
    return True


def allow_attempt(path, source, now=None):
    now = int(time.time()) if now is None else now
    source = hashlib.sha256(source.encode('utf-8')).hexdigest()
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('DELETE FROM attempts WHERE timestamp<=?', (now - 60,))
        total = db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0]
        personal = db.execute('SELECT COUNT(*) FROM attempts WHERE source=?', (source,)).fetchone()[0]
        if total >= 60 or personal >= 10:
            return False
        db.execute('INSERT INTO attempts VALUES(?,?)', (source, now))
    return True


def create_app(database=None):
    from flask import Flask, jsonify, request, send_file, send_from_directory
    from io import BytesIO
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 8192
    database = database or os.environ.get('DEBUG_AUTH_DB', '/var/lib/tanuki-debug-auth/auth.sqlite3')
    initialize(database)

    @app.after_request
    def prevent_cache(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        if request.path == '/v1/player-bans/check':
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    @app.get('/debug-register')
    def registration_page():
        return send_from_directory(Path(__file__).parent / 'registration', 'index.html')

    @app.get('/debug-register/<any(register.js,register.css):filename>')
    def registration_asset(filename):
        return send_from_directory(Path(__file__).parent / 'registration', filename)

    @app.post('/v1/debug-auth/register')
    def register():
        source = request.remote_addr or 'unknown'
        if source in ('127.0.0.1', '::1'):
            source = request.headers.get('X-Real-IP', source)
        try:
            if not allow_attempt(database, source):
                return jsonify(error='試行回数が多すぎます。1分ほど待って再試行してください。'), 429
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return jsonify(error='入力内容を確認してください。'), 400
            if redeem_invitation(database, data.get('code'), data.get('password')):
                return jsonify(registered=True)
            return jsonify(error='招待コードが無効・期限切れ・使用済みです。管理者に確認してください。'), 400
        except ValueError:
            return jsonify(error='パスワードは12〜1024文字です。登録上限の場合は管理者に確認してください。'), 400
        except sqlite3.Error:
            return jsonify(error='登録できませんでした。しばらくして再試行してください。'), 503

    @app.get('/health')
    def health():
        return jsonify(status='ok')

    @app.post('/v1/player-bans/check')
    def check_player_ban():
        data = request.get_json(silent=True)
        try:
            uid = data.get('playerUid') if isinstance(data, dict) else None
            digest = uid_digest(uid)
            name = data.get('playerName', '') if isinstance(data, dict) else ''
            if name:
                validate_player_name(name)
            observed = data.get('observedPlayers', []) if isinstance(data, dict) else []
            if not isinstance(observed, list) or len(observed) > 29:
                raise ValueError('Invalid player roster.')
        except ValueError:
            return jsonify(error='Invalid player identity.'), 400
        with closing(connect(database)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            now = int(time.time())
            for player in [{'playerUid': uid, 'playerName': name}, *observed]:
                if not isinstance(player, dict):
                    continue
                candidate_uid = player.get('playerUid')
                candidate_name = player.get('playerName')
                try:
                    candidate_digest = record_player_history(
                        db, candidate_uid, candidate_name, player.get('friendCode', ''), now)
                except ValueError:
                    continue
                if db.execute('SELECT 1 FROM player_bans WHERE uid_digest=?', (candidate_digest,)).fetchone():
                    continue
                pending = db.execute('SELECT reason FROM pending_player_name_bans WHERE player_name=?',
                                     (candidate_name,)).fetchone()
                if pending:
                    db.execute('INSERT INTO player_bans VALUES(?,?,?,?,?)',
                               (candidate_digest, candidate_name, '', pending['reason'], now))
                    db.execute('''INSERT INTO player_ban_uids VALUES(?,?)
                                  ON CONFLICT(uid_digest) DO UPDATE SET player_uid=excluded.player_uid''',
                               (candidate_digest, candidate_uid))
                    db.execute('DELETE FROM pending_player_name_bans WHERE player_name=?', (candidate_name,))
            banned = db.execute('SELECT 1 FROM player_bans WHERE uid_digest=?', (digest,)).fetchone() is not None
        return jsonify(banned=banned)

    @app.post('/v1/player-bans/manage')
    def manage_player_bans():
        source = request.remote_addr or 'unknown'
        if source in ('127.0.0.1', '::1'):
            source = request.headers.get('X-Real-IP', source)
        if not allow_attempt(database, source):
            return jsonify(error='Too many attempts.'), 429
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not verify_ban_admin(database, data.get('password')):
            return jsonify(error='Not authorized.'), 403
        try:
            action = data.get('action')
            history_name = data.get('historyName', '')
            history_from = data.get('historyFrom')
            history_to = data.get('historyTo')
            history_offset = data.get('historyOffset', 0)
            validate_history_search(history_name, history_from, history_to, history_offset)
            if action == 'add':
                add_ban(database, data.get('playerUid'), data.get('displayName', ''),
                        data.get('friendCode', ''), data.get('reason', ''))
            elif action == 'add-name':
                add_pending_name_ban(database, data.get('playerName'), data.get('reason', ''))
            elif action == 'add-history':
                add_ban_from_history(database, data.get('uidDigest'), data.get('reason', ''))
            elif action == 'remove':
                remove_ban(database, data.get('uidDigest'))
            elif action == 'remove-name':
                remove_pending_name_ban(database, data.get('playerName'))
            elif action != 'list':
                return jsonify(error='Invalid action.'), 400
            history, history_total = list_player_history(database, history_name, history_from, history_to, history_offset)
            return jsonify(bans=list_bans(database), pending=list_pending_name_bans(database),
                           history=history, historyTotal=history_total)
        except ValueError as error:
            return jsonify(error=str(error)), 400

    @app.post('/v1/inquiries')
    def submit_inquiry():
        request.max_content_length = inquiry.REQUEST_LIMIT
        request.max_form_parts = 12
        return inquiry.receive(request, database)

    @app.get('/v1/inquiries/attachments/<token>')
    def inquiry_attachment(token):
        row = issue_bridge.get_attachment(database, token)
        if row is None:
            return '', 404
        return send_file(BytesIO(row['data']), mimetype='application/octet-stream',
                         as_attachment=True, download_name=row['filename'])

    @app.post('/v1/debug-auth/verify')
    def authenticate():
        # Our loopback reverse proxy overwrites this header; ignore it from other peers.
        source = request.remote_addr or 'unknown'
        if source in ('127.0.0.1', '::1'):
            source = request.headers.get('X-Real-IP', source)
        try:
            if not allow_attempt(database, source):
                return jsonify(authorized=False), 429
            data = request.get_json(silent=True)
            password = data.get('password') if isinstance(data, dict) else None
            if verify(database, password):
                return jsonify(authorized=True)
            return jsonify(authorized=False), 401
        except sqlite3.Error:
            return jsonify(authorized=False), 503

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=os.environ.get('DEBUG_AUTH_DB', '/var/lib/tanuki-debug-auth/auth.sqlite3'))
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('init')
    commands.add_parser('list')
    invitation = commands.add_parser('invite')
    invitation.add_argument('name')
    invitation.add_argument('--hours', type=int, default=72)
    commands.add_parser('revoke-invite').add_argument('name')
    webhook = commands.add_parser('webhook-set')
    webhook.add_argument('product', choices=inquiry.PRODUCTS)
    webhook.add_argument('--kind', choices=('forum', 'text'), default='forum')
    for tag in inquiry.TAGS:
        webhook.add_argument('--{}-tag'.format(tag), default=None)
    commands.add_parser('webhook-list')
    commands.add_parser('webhook-remove').add_argument('product', choices=inquiry.PRODUCTS)
    for command in ('set', 'disable', 'remove'):
        commands.add_parser(command).add_argument('name')
    args = parser.parse_args()
    os.umask(0o077)
    initialize(args.db)
    if args.command == 'invite':
        try:
            print(issue_invitation(args.db, args.name, args.hours))
            print('One use only. Expires in {} hours. Reissuing invalidates the previous code.'.format(args.hours))
        except ValueError as error:
            parser.error(str(error))
    elif args.command == 'revoke-invite':
        with closing(connect(args.db)) as db, db:
            db.execute('DELETE FROM invitations WHERE name=? AND used_at IS NULL', (args.name,))
        print('Unused invitations revoked.')
    elif args.command == 'set':
        password = getpass.getpass('New debug password: ')
        if password != getpass.getpass('Confirm password: '):
            parser.error('Passwords do not match.')
        set_password(args.db, args.name, password)
        print('Password saved and enabled.')
    elif args.command == 'list':
        with closing(connect(args.db)) as db:
            for row in db.execute('SELECT name,enabled FROM passwords ORDER BY name'):
                print('{}\t{}'.format(row['name'], 'enabled' if row['enabled'] else 'disabled'))
    elif args.command == 'webhook-set':
        url = getpass.getpass('Discord webhook URL (hidden): ')
        if url != getpass.getpass('Confirm webhook URL (hidden): '):
            parser.error('Webhook URLs do not match.')
        try:
            inquiry.set_webhook(args.db, args.product, url, args.kind,
                                {tag: getattr(args, '{}_tag'.format(tag)) for tag in inquiry.TAGS})
        except ValueError as error:
            parser.error(str(error))
        print('Webhook saved for {} ({}). URL is not shown.'.format(args.product, args.kind))
    elif args.command == 'webhook-list':
        with closing(connect(args.db)) as db:
            for row in db.execute('SELECT product,kind FROM inquiry_webhooks ORDER BY product'):
                print('{}\t{}\tconfigured'.format(row['product'], row['kind']))
    elif args.command == 'webhook-remove':
        with closing(connect(args.db)) as db, db:
            result = db.execute('DELETE FROM inquiry_webhooks WHERE product=?', (args.product,))
        print('Webhook removed.' if result.rowcount else 'No matching webhook.')
    elif args.command in ('disable', 'remove'):
        with closing(connect(args.db)) as db, db:
            if args.command == 'disable':
                result = db.execute('UPDATE passwords SET enabled=0,updated_at=? WHERE name=?', (int(time.time()), args.name))
            else:
                result = db.execute('DELETE FROM passwords WHERE name=?', (args.name,))
            print('Record changed.' if result.rowcount else 'No matching record.')
    else:
        print('Database initialized.')


if __name__ == '__main__':
    main()
