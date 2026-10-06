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
        """)
    os.chmod(path, 0o600)


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
    from flask import Flask, jsonify, request, send_from_directory
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
