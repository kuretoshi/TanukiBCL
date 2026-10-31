"""GitHub Issues and Discord forum mapping for desktop inquiries."""

from contextlib import closing
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


REPOSITORY = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z')
API_ROOT = 'https://api.github.com'


def connect(path):
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    return db


def initialize(path):
    with closing(connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS inquiry_issues (
                fingerprint TEXT PRIMARY KEY,
                product TEXT NOT NULL,
                repository TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                issue_url TEXT NOT NULL,
                tag TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                thread_id TEXT UNIQUE,
                guild_id TEXT,
                initial_message_id TEXT,
                link_comment_id INTEGER,
                mirroring_until INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_pending_files (
                fingerprint TEXT NOT NULL REFERENCES inquiry_issues(fingerprint),
                position INTEGER NOT NULL,
                filename TEXT NOT NULL,
                data BLOB NOT NULL,
                PRIMARY KEY(fingerprint, position)
            );
            CREATE TABLE IF NOT EXISTS inquiry_attachments (
                token TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                filename TEXT NOT NULL,
                data BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_discord_attachments (
                attachment_id TEXT PRIMARY KEY,
                token TEXT NOT NULL REFERENCES inquiry_attachments(token)
            );
            CREATE TABLE IF NOT EXISTS inquiry_discord_comments (
                message_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                comment_id INTEGER NOT NULL,
                content_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_discord_sources (
                forum_id TEXT PRIMARY KEY,
                enabled_at INTEGER NOT NULL,
                scanned_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_discord_ignored (
                thread_id TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS inquiry_discord_resolution (
                thread_id TEXT PRIMARY KEY,
                repository TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                tag_id TEXT NOT NULL,
                resolved INTEGER NOT NULL CHECK(resolved IN (0,1))
            );
        """)


def repository_for(product):
    name = os.environ.get('INQUIRY_GITHUB_REPO_' + product.upper(), '')
    if not REPOSITORY.fullmatch(name):
        raise RuntimeError('GitHub issue destination is not configured.')
    return name


def attachment_base():
    base = os.environ.get('INQUIRY_PUBLIC_BASE', 'https://debug-auth.kuretoshi.work')
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::\d+)?', base):
        raise RuntimeError('Public attachment base URL is invalid.')
    return base


def save_attachments(path, key, files):
    links = []
    with closing(connect(path)) as db, db:
        for filename, data in files:
            token = secrets.token_urlsafe(32)
            db.execute('INSERT INTO inquiry_attachments VALUES(?,?,?,?,?)',
                       (token, key, filename, data, int(time.time())))
            links.append((filename, f'{attachment_base()}/v1/inquiries/attachments/{token}'))
    return links


def get_attachment(path, token):
    if not re.fullmatch(r'[A-Za-z0-9_-]{40,50}', token):
        return None
    with closing(connect(path)) as db:
        return db.execute('SELECT filename,data FROM inquiry_attachments WHERE token=?', (token,)).fetchone()


def delete_attachments(path, key):
    with closing(connect(path)) as db, db:
        db.execute('DELETE FROM inquiry_attachments WHERE fingerprint=?', (key,))


def discord_attachment_url(path, attachment_id):
    with closing(connect(path)) as db:
        row = db.execute('SELECT token FROM inquiry_discord_attachments WHERE attachment_id=?',
                         (str(attachment_id),)).fetchone()
    return f'{attachment_base()}/v1/inquiries/attachments/{row["token"]}' if row else None


def save_discord_attachment(path, message_id, attachment_id, filename, data):
    token = secrets.token_urlsafe(32)
    filename = re.sub(r'[\r\n/\\"]', '_', filename)[:150] or 'attachment'
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT token FROM inquiry_discord_attachments WHERE attachment_id=?',
                              (str(attachment_id),)).fetchone()
        if existing:
            return f'{attachment_base()}/v1/inquiries/attachments/{existing["token"]}'
        db.execute('INSERT INTO inquiry_attachments VALUES(?,?,?,?,?)',
                   (token, str(message_id), filename, data, int(time.time())))
        db.execute('INSERT INTO inquiry_discord_attachments VALUES(?,?)',
                   (str(attachment_id), token))
    return f'{attachment_base()}/v1/inquiries/attachments/{token}'


def _github(method, repository, endpoint, payload=None):
    addon_repository = os.environ.get('INQUIRY_GITHUB_REPO_ADDON', '')
    if addon_repository and repository == addon_repository:
        token = os.environ.get('INQUIRY_GITHUB_TOKEN_ADDON', '')
        if not token:
            raise RuntimeError('Addon GitHub issue token is not configured.')
    else:
        token = _existing_github_token(repository)
    return _github_request(method, repository, endpoint, payload, token)


def _existing_github_token(repository):
    net_repository = os.environ.get('INQUIRY_GITHUB_REPO_NET', '')
    token = (os.environ.get('INQUIRY_GITHUB_TOKEN_NET', '')
             if repository == net_repository and net_repository else '')
    if not token:
        token = os.environ.get('INQUIRY_GITHUB_TOKEN', '')
    if not token:
        raise RuntimeError('GitHub issue token is not configured.')
    return token


def _github_request(method, repository, endpoint, payload, token):
    if not REPOSITORY.fullmatch(repository):
        raise ValueError('Invalid GitHub repository.')
    url = f'{API_ROOT}/repos/{repository}{endpoint}'
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = Request(url, data=body, method=method, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'TanukiBCL-Inquiry-Bridge',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urlopen(request, timeout=20) as response:
            return json.load(response)
    except HTTPError as error:
        # Do not expose the token, request body, or remote response to callers.
        raise RuntimeError(f'GitHub request failed ({error.code}).') from error


def fingerprint(source, product, tag, subject, body, files, time_bucket):
    digest = hashlib.sha256()
    for value in (source, product, tag, subject, body, str(time_bucket)):
        digest.update(value.encode('utf-8'))
        digest.update(b'\0')
    for filename, data in files:
        digest.update(filename.encode('utf-8'))
        digest.update(b'\0')
        digest.update(data)
    return digest.hexdigest()


def issue_body(product, tag, body, attachments):
    attachment_note = ''
    if attachments:
        lines = []
        for filename, url in attachments:
            label = _safe_markdown(filename).replace('[', '\\[').replace(']', '\\]')
            lines.append(f'- [{label}]({url})')
        attachment_note = '\n\n### 添付ファイル（公開）\n' + '\n'.join(lines)
    return (f'製品: {product}\n種別: {tag}\n\n{_safe_markdown(body)}{attachment_note}'
            '\n\n---\nアプリ内の問い合わせフォームから投稿されました。')


def create_issue(repository, product, tag, subject, body, attachments):
    result = _github('POST', repository, '/issues', {
        'title': f'[{product}/{tag}] {subject}',
        'body': issue_body(product, tag, body, attachments),
    })
    if not isinstance(result, dict) or not isinstance(result.get('number'), int) or not result.get('html_url'):
        raise RuntimeError('GitHub did not confirm issue creation.')
    return result['number'], result['html_url']


def discord_source_since(path, forum_id, now=None):
    now = int(time.time()) if now is None else now
    with closing(connect(path)) as db, db:
        db.execute('INSERT OR IGNORE INTO inquiry_discord_sources VALUES(?,?,?)',
                   (str(forum_id), now, now))
        return db.execute('SELECT enabled_at FROM inquiry_discord_sources WHERE forum_id=?',
                          (str(forum_id),)).fetchone()['enabled_at']


def discord_scan_since(path, forum_id):
    with closing(connect(path)) as db:
        return db.execute('SELECT scanned_at FROM inquiry_discord_sources WHERE forum_id=?',
                          (str(forum_id),)).fetchone()['scanned_at']


def mark_discord_scan(path, forum_id, now):
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_discord_sources SET scanned_at=? WHERE forum_id=?',
                   (now, str(forum_id)))


def ignore_discord_thread(path, thread_id):
    with closing(connect(path)) as db, db:
        db.execute('INSERT OR IGNORE INTO inquiry_discord_ignored VALUES(?)', (str(thread_id),))


def is_discord_thread_ignored(path, thread_id):
    with closing(connect(path)) as db:
        return db.execute('SELECT 1 FROM inquiry_discord_ignored WHERE thread_id=?',
                          (str(thread_id),)).fetchone() is not None


def discord_issue_body(product, tag, author, content, attachments, thread_url, deleted=False):
    text = 'Discordの元投稿が削除されました。' if deleted else (_safe_markdown(content.strip()) or '（本文なし）')
    attachment_note = ''
    if attachments and not deleted:
        lines = []
        for filename, url in attachments:
            label = _safe_markdown(filename).replace('[', '\\[').replace(']', '\\]')
            lines.append(f'- [{label}]({url})')
        attachment_note = '\n\n### 添付ファイル（公開）\n' + '\n'.join(lines)
    author_line = '' if deleted else f'Discord投稿者: {_safe_markdown(author)}\n'
    return (f'製品: {product}\n種別: {tag}\n{author_line}\n'
            f'{text}{attachment_note}\n\n---\nDiscordフォーラムの元投稿: {thread_url}')


def create_discord_issue(path, repository, product, tag, subject, body, thread_id, guild_id, initial_message_id,
                         now=None):
    existing = get_by_thread(path, thread_id)
    if existing is not None:
        return existing
    result = _github('POST', repository, '/issues', {
        'title': f'[{product}/{tag}] {subject}', 'body': body,
    })
    if not isinstance(result, dict) or not isinstance(result.get('number'), int) or not result.get('html_url'):
        raise RuntimeError('GitHub did not confirm issue creation.')
    key = f'discord:{thread_id}'
    with closing(connect(path)) as db, db:
        db.execute('''INSERT INTO inquiry_issues
            (fingerprint,product,repository,issue_number,issue_url,tag,subject,body,
             thread_id,guild_id,initial_message_id,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
            (key, product, repository, result['number'], result['html_url'], tag, subject, body,
             str(thread_id), str(guild_id), str(initial_message_id),
             int(time.time()) if now is None else now))
    return get_by_thread(path, thread_id)


def sync_discord_initial(path, thread_id, body):
    row = get_by_thread(path, thread_id)
    if row is None or not row['fingerprint'].startswith('discord:') or row['body'] == body:
        return False
    _github('PATCH', row['repository'], f"/issues/{row['issue_number']}", {'body': body})
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_issues SET body=? WHERE fingerprint=?', (body, row['fingerprint']))
    return True


def get_by_fingerprint(path, key):
    with closing(connect(path)) as db:
        return db.execute('SELECT * FROM inquiry_issues WHERE fingerprint=?', (key,)).fetchone()


def save_issue(path, key, product, repository, number, url, tag, subject, body, files, now):
    with closing(connect(path)) as db, db:
        db.execute('''INSERT INTO inquiry_issues
            (fingerprint,product,repository,issue_number,issue_url,tag,subject,body,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)''',
            (key, product, repository, number, url, tag, subject, body, now))
        db.executemany('''INSERT INTO inquiry_pending_files
            (fingerprint,position,filename,data) VALUES (?,?,?,?)''',
            [(key, index, filename, data) for index, (filename, data) in enumerate(files)])


def pending(path):
    with closing(connect(path)) as db:
        return db.execute('SELECT * FROM inquiry_issues WHERE thread_id IS NULL ORDER BY created_at').fetchall()


def claim_pending(path, key, now=None):
    now = int(time.time()) if now is None else now
    with closing(connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        result = db.execute('''UPDATE inquiry_issues SET mirroring_until=?
            WHERE fingerprint=? AND thread_id IS NULL AND mirroring_until<?''', (now + 60, key, now))
        if not result.rowcount:
            return None
        return db.execute('SELECT * FROM inquiry_issues WHERE fingerprint=?', (key,)).fetchone()


def release_pending(path, key):
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_issues SET mirroring_until=0 WHERE fingerprint=? AND thread_id IS NULL', (key,))


def pending_files(path, key):
    with closing(connect(path)) as db:
        return [(row['filename'], row['data']) for row in db.execute('''
            SELECT filename,data FROM inquiry_pending_files WHERE fingerprint=? ORDER BY position''', (key,))]


def link_thread(path, key, thread_id, message_id, guild_id):
    with closing(connect(path)) as db, db:
        db.execute('''UPDATE inquiry_issues SET thread_id=?,guild_id=?,initial_message_id=?
            WHERE fingerprint=? AND thread_id IS NULL''',
                   (str(thread_id), str(guild_id) if guild_id else None, str(message_id), key))
        db.execute('DELETE FROM inquiry_pending_files WHERE fingerprint=?', (key,))


def get_by_thread(path, thread_id):
    with closing(connect(path)) as db:
        return db.execute('SELECT * FROM inquiry_issues WHERE thread_id=?', (str(thread_id),)).fetchone()


def set_guild_id(path, thread_id, guild_id):
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_issues SET guild_id=? WHERE thread_id=? AND guild_id IS NULL',
                   (str(guild_id), str(thread_id)))
    return get_by_thread(path, thread_id)


def comment_message_ids(path, thread_id):
    with closing(connect(path)) as db:
        return {row['message_id'] for row in db.execute(
            'SELECT message_id FROM inquiry_discord_comments WHERE thread_id=?', (str(thread_id),))}


def list_linked(path):
    with closing(connect(path)) as db:
        return db.execute('SELECT * FROM inquiry_issues WHERE thread_id IS NOT NULL').fetchall()


def resolve_issue(path, thread_id, resolved=True):
    """Update only the persisted counterpart; never create an Issue or comment."""
    row = get_by_thread(path, thread_id)
    if row is None:
        return False
    endpoint = f"/issues/{row['issue_number']}"
    current = _github('GET', row['repository'], endpoint)
    if (not isinstance(current, dict) or current.get('number') != row['issue_number']
            or 'pull_request' in current or current.get('state') not in ('open', 'closed')):
        raise RuntimeError('GitHub did not confirm the linked Issue.')
    state = 'closed' if resolved else 'open'
    if current['state'] == state:
        return False
    result = _github('PATCH', row['repository'], endpoint,
                     {'state': state, 'state_reason': 'completed' if resolved else 'reopened'})
    if (not isinstance(result, dict) or result.get('number') != row['issue_number']
            or result.get('state') != state
            or (resolved and result.get('state_reason') != 'completed')):
        raise RuntimeError('GitHub did not confirm Issue resolution.')
    return True


def sync_discord_resolution(path, thread_id, tag_id, resolved):
    """Remember tag transitions across restarts; leave unobserved manual closes alone."""
    row = get_by_thread(path, thread_id)
    if row is None:
        return None
    identity = (str(thread_id), row['repository'], row['issue_number'], str(tag_id))
    with closing(connect(path)) as db:
        prior = db.execute('''SELECT resolved FROM inquiry_discord_resolution
            WHERE thread_id=? AND repository=? AND issue_number=? AND tag_id=?''', identity).fetchone()
    if not resolved and (prior is None or not prior['resolved']):
        return None

    def remember(value):
        with closing(connect(path)) as db, db:
            db.execute('''INSERT INTO inquiry_discord_resolution VALUES(?,?,?,?,?)
                ON CONFLICT(thread_id) DO UPDATE SET repository=excluded.repository,
                issue_number=excluded.issue_number,tag_id=excluded.tag_id,resolved=excluded.resolved''',
                (*identity, int(value)))

    # Record the close intent first: if the process exits after GitHub accepts
    # the close, a subsequent tag removal must still be able to reopen it.
    if resolved and (prior is None or not prior['resolved']):
        remember(True)
    changed = resolve_issue(path, thread_id, resolved)
    if not resolved:
        remember(False)
    return ('closed' if resolved else 'open') if changed else None


def ensure_discord_link(path, row):
    if (not row['thread_id'] or not row['guild_id'] or row['link_comment_id']
            or row['fingerprint'].startswith('discord:')):
        return False
    thread_url = f"https://discord.com/channels/{row['guild_id']}/{row['thread_id']}"
    result = _github('POST', row['repository'], f"/issues/{row['issue_number']}/comments", {
        'body': f'Discordフォーラムの対応スレッド: {thread_url}',
    })
    comment_id = result.get('id')
    if not isinstance(comment_id, int):
        raise RuntimeError('GitHub did not confirm the Discord link comment.')
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_issues SET link_comment_id=? WHERE fingerprint=? AND link_comment_id IS NULL',
                   (comment_id, row['fingerprint']))
    return True


def _safe_markdown(value):
    return value.replace('@', '@\u200b')


def comment_body(message_id, author, content, attachments, deleted=False):
    marker = f'<!-- discord-message-id:{message_id} -->'
    if deleted:
        return f'{marker}\nDiscordの返信が削除されました。'
    text = _safe_markdown(content.strip()) or '（本文なし）'
    attachment_note = ''
    if attachments:
        lines = []
        for filename, url in attachments:
            label = _safe_markdown(filename).replace('[', '\\[').replace(']', '\\]')
            lines.append(f'- [{label}]({url})')
        attachment_note = '\n\n添付ファイル（公開）:\n' + '\n'.join(lines)
    return f'{marker}\n**Discord: {_safe_markdown(author)}**\n\n{text}{attachment_note}'


def sync_comment(path, thread_id, message_id, author, content, attachments=(), deleted=False):
    row = get_by_thread(path, thread_id)
    if row is None or str(message_id) == row['initial_message_id']:
        return False
    body = comment_body(message_id, author, content, attachments, deleted)
    content_hash = hashlib.sha256(body.encode('utf-8')).hexdigest()
    with closing(connect(path)) as db:
        prior = db.execute('SELECT * FROM inquiry_discord_comments WHERE message_id=?', (str(message_id),)).fetchone()
    if prior and prior['content_hash'] == content_hash:
        return False
    if prior:
        _github('PATCH', row['repository'], f"/issues/comments/{prior['comment_id']}", {'body': body})
        comment_id = prior['comment_id']
    else:
        result = _github('POST', row['repository'], f"/issues/{row['issue_number']}/comments", {'body': body})
        comment_id = result.get('id')
        if not isinstance(comment_id, int):
            raise RuntimeError('GitHub did not confirm comment creation.')
    with closing(connect(path)) as db, db:
        db.execute('''INSERT INTO inquiry_discord_comments(message_id,thread_id,comment_id,content_hash)
            VALUES (?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET
            content_hash=excluded.content_hash''', (str(message_id), str(thread_id), comment_id, content_hash))
    return True


def rename_issue(path, thread_id, title, tag=None):
    row = get_by_thread(path, thread_id)
    if row is None:
        return False
    title = title.strip()[:100]
    tag = tag if tag in ('question', 'bug', 'request') else row['tag']
    if not title or (title == row['subject'] and tag == row['tag']):
        return False
    _github('PATCH', row['repository'], f"/issues/{row['issue_number']}",
            {'title': f"[{row['product']}/{tag}] {title}"})
    with closing(connect(path)) as db, db:
        db.execute('UPDATE inquiry_issues SET subject=?,tag=? WHERE fingerprint=?',
                   (title, tag, row['fingerprint']))
    return True
