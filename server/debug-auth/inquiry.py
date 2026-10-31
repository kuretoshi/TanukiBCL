"""Server-side intake for GitHub Issues mirrored to Discord forums."""
from contextlib import closing
import hashlib
import json
import logging
import re
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import issue_bridge


PRODUCTS = ('tanuki', 'net', 'addon')
TAGS = ('question', 'bug', 'request')
ATTACHMENT_LIMIT = 24 * 1024 * 1024
REQUEST_LIMIT = 26 * 1024 * 1024
WEBHOOK_PATH = re.compile(r'/api/webhooks/\d+/[A-Za-z0-9._-]+\Z')
TAG_ID = re.compile(r'\d{1,20}\Z')
LOG = logging.getLogger(__name__)


def connect(path):
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    return db


def initialize(path):
    with closing(connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS inquiry_webhooks (
                product TEXT PRIMARY KEY CHECK(product IN ('tanuki','net','addon')),
                webhook_url TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('forum','text')),
                question_tag TEXT,
                bug_tag TEXT,
                request_tag TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_attempts (
                source TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS inquiry_attempts_timestamp
                ON inquiry_attempts(timestamp);
        """)
        schema = db.execute("SELECT sql FROM sqlite_master WHERE name='inquiry_webhooks'").fetchone()[0]
        if "'addon'" not in schema:
            db.execute('BEGIN IMMEDIATE')
            db.execute('ALTER TABLE inquiry_webhooks RENAME TO inquiry_webhooks_legacy')
            db.execute("""CREATE TABLE inquiry_webhooks (
                product TEXT PRIMARY KEY CHECK(product IN ('tanuki','net','addon')),
                webhook_url TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('forum','text')),
                question_tag TEXT, bug_tag TEXT, request_tag TEXT, updated_at INTEGER NOT NULL
            )""")
            db.execute('INSERT INTO inquiry_webhooks SELECT * FROM inquiry_webhooks_legacy')
            db.execute('DROP TABLE inquiry_webhooks_legacy')
    issue_bridge.initialize(path)


def validate_webhook(url):
    if not isinstance(url, str):
        raise ValueError('Enter a Discord incoming webhook URL.')
    try:
        parsed = urlparse(url)
        valid = (parsed.scheme == 'https' and parsed.hostname in ('discord.com', 'discordapp.com')
                 and parsed.port is None and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment and WEBHOOK_PATH.fullmatch(parsed.path))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('Enter a Discord incoming webhook URL without /github or query parameters.')
    return url


def set_webhook(path, product, url, kind='forum', tags=None):
    if product not in PRODUCTS or kind not in ('forum', 'text'):
        raise ValueError('Choose product tanuki/net/addon and kind forum/text.')
    validate_webhook(url)
    tags = tags or {}
    if kind == 'text' and any(tags.values()):
        raise ValueError('Text channels do not support forum tags.')
    for key, value in tags.items():
        if key not in TAGS or (value is not None and not TAG_ID.fullmatch(value)):
            raise ValueError('Forum tag IDs must contain digits only.')
    with closing(connect(path)) as db, db:
        db.execute("""INSERT INTO inquiry_webhooks
            (product,webhook_url,kind,question_tag,bug_tag,request_tag,updated_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(product) DO UPDATE SET
            webhook_url=excluded.webhook_url,kind=excluded.kind,
            question_tag=excluded.question_tag,bug_tag=excluded.bug_tag,
            request_tag=excluded.request_tag,updated_at=excluded.updated_at""",
            (product, url, kind, tags.get('question'), tags.get('bug'), tags.get('request'), int(time.time())))


def get_webhook(path, product):
    with closing(connect(path)) as db:
        return db.execute('SELECT * FROM inquiry_webhooks WHERE product=?', (product,)).fetchone()


def allow_attempt(path, source, now=None):
    now = int(time.time()) if now is None else now
    # Keep report traffic independent of the debug-password limiter.
    source = hashlib.sha256(source.encode('utf-8')).hexdigest()
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('DELETE FROM inquiry_attempts WHERE timestamp<=?', (now - 3600,))
        total = db.execute('SELECT COUNT(*) FROM inquiry_attempts').fetchone()[0]
        personal = db.execute('SELECT COUNT(*) FROM inquiry_attempts WHERE source=?', (source,)).fetchone()[0]
        if total >= 120 or personal >= 10:
            return False
        db.execute('INSERT INTO inquiry_attempts VALUES(?,?)', (source, now))
    return True


def _files(request):
    files = []
    total = 0
    for name, uploaded in request.files.items(multi=True):
        if not re.fullmatch(r'files\[\d+\]', name) or len(files) >= 10:
            raise ValueError('Invalid attachments.')
        data = uploaded.read(ATTACHMENT_LIMIT + 1 - total)
        total += len(data)
        if total > ATTACHMENT_LIMIT:
            raise ValueError('Attachments exceed 24 MiB.')
        filename = (uploaded.filename or 'attachment').replace('\\', '_').replace('/', '_')
        filename = re.sub(r'[\r\n"]', '_', filename)[:150] or 'attachment'
        files.append((filename, data))
    return files


def _multipart(payload, files):
    import secrets
    boundary = '----TanukiInquiry' + secrets.token_hex(16)
    chunks = []
    def field(name, data, filename=None):
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        chunks.extend((f'--{boundary}\r\n{disposition}\r\n\r\n'.encode(), data, b'\r\n'))
    field('payload_json', json.dumps(payload, ensure_ascii=False).encode('utf-8'))
    for index, (filename, data) in enumerate(files):
        field(f'files[{index}]', data, filename)
    chunks.append(f'--{boundary}--\r\n'.encode())
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


def send_to_discord(route, tag, subject, body, files, issue_url=None):
    content = f'{body[:1700]}\n\nGitHub Issue: {issue_url}' if issue_url else body
    if route['kind'] == 'forum':
        payload = {'thread_name': subject[:100], 'content': content, 'allowed_mentions': {'parse': []}}
        tag_id = route[f'{tag}_tag']
        if tag_id:
            payload['applied_tags'] = [tag_id]
    else:
        payload = {'content': f'**[{tag}] {subject}**\n{content}', 'allowed_mentions': {'parse': []}}
    if files:
        data, content_type = _multipart(payload, files)
    else:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        content_type = 'application/json'
    request = Request(route['webhook_url'] + '?wait=true', data=data, method='POST', headers={
        'Content-Type': content_type,
        'User-Agent': 'DiscordBot (https://github.com/kuretoshi/TanukiBCL, 1.0)',
    })
    with urlopen(request, timeout=12) as response:
        result = json.load(response)
    if not isinstance(result, dict) or not result.get('id'):
        raise RuntimeError('Discord did not confirm the report.')
    return result


def mirror_pending(database, only_key=None):
    """Retry Discord delivery after the Issue has already been accepted."""
    for row in issue_bridge.pending(database):
        if only_key is not None and row['fingerprint'] != only_key:
            continue
        route = get_webhook(database, row['product'])
        if route is None or route['kind'] != 'forum':
            continue
        claimed = issue_bridge.claim_pending(database, row['fingerprint'])
        if claimed is None:
            continue
        try:
            result = send_to_discord(route, row['tag'], row['subject'], row['body'],
                                     issue_bridge.pending_files(database, row['fingerprint']), row['issue_url'])
            if not result.get('channel_id'):
                raise RuntimeError('Discord did not return a forum thread ID.')
            issue_bridge.link_thread(database, row['fingerprint'], result['channel_id'], result['id'],
                                     result.get('guild_id'))
        except Exception:
            issue_bridge.release_pending(database, row['fingerprint'])
            if only_key is not None:
                raise
            LOG.exception('Could not mirror inquiry %s to Discord', row['fingerprint'])
    for row in issue_bridge.list_linked(database):
        try:
            issue_bridge.ensure_discord_link(database, row)
        except Exception:
            LOG.exception('Could not add Discord link to issue %s', row['issue_number'])


def receive(request, database):
    source = request.remote_addr or 'unknown'
    if source in ('127.0.0.1', '::1'):
        source = request.headers.get('X-Real-IP', source)
    try:
        if not allow_attempt(database, source):
            return {'error': '送信回数が多すぎます。時間をおいて再試行してください。'}, 429
        data = request.get_json(silent=True) if request.is_json else json.loads(request.form['payload_json'])
        if not isinstance(data, dict):
            raise ValueError('Invalid report.')
        product, tag = data.get('product'), data.get('tag')
        subject, body = data.get('subject'), data.get('body')
        if (product not in PRODUCTS or tag not in TAGS or not isinstance(subject, str)
                or not isinstance(body, str) or not 1 <= len(subject.strip()) <= 100
                or not 1 <= len(body.strip()) <= 1800):
            raise ValueError('Invalid report.')
        route = get_webhook(database, product)
        if route is None:
            return {'error': 'この報告先は現在利用できません。'}, 503
        files = _files(request)
        subject, body = subject.strip(), body.strip()
        if product == 'addon' and data.get('public_issue_consent') is not True:
            raise ValueError('Public disclosure consent is required for addon reports.')
        # Older clients stay on the private Discord route until they show public disclosure.
        if data.get('public_issue_consent') is not True:
            send_to_discord(route, tag, subject, body, files)
            return {'submitted': True}, 200
        if route['kind'] != 'forum':
            return {'error': 'この報告先は現在利用できません。'}, 503
        repository = issue_bridge.repository_for(product)
        key = issue_bridge.fingerprint(source, product, tag, subject, body, files, int(time.time()) // 600)
        existing = issue_bridge.get_by_fingerprint(database, key)
        if existing is not None:
            return {'submitted': True, 'issue_url': existing['issue_url']}, 200
        attachments = issue_bridge.save_attachments(database, key, files)
        try:
            number, issue_url = issue_bridge.create_issue(repository, product, tag, subject, body, attachments)
        except Exception:
            issue_bridge.delete_attachments(database, key)
            raise
        issue_bridge.save_issue(database, key, product, repository, number, issue_url,
                                tag, subject, body, files, int(time.time()))
        try:
            mirror_pending(database, key)
        except Exception:
            # The Issue is the accepted record. The bot worker will retry the forum mirror.
            LOG.exception('Issue %s was created but Discord delivery is pending', number)
        return {'submitted': True, 'issue_url': issue_url}, 200
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return {'error': '報告内容を確認してください。'}, 400
    except (HTTPError, URLError, TimeoutError, OSError, RuntimeError):
        return {'error': '報告を送信できませんでした。時間をおいて再試行してください。'}, 502
    except sqlite3.Error:
        return {'error': '報告を送信できませんでした。時間をおいて再試行してください。'}, 503
