"""Import addon GitHub Issues and comments into the existing forum bridge."""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import inquiry
import issue_bridge


def initialize(path):
    with closing(issue_bridge.connect(path)) as db, db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS inquiry_github_sources (
                repository TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL, scanned_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS inquiry_github_comments (
                repository TEXT NOT NULL, comment_id INTEGER NOT NULL,
                thread_id TEXT NOT NULL, message_id TEXT NOT NULL, content_hash TEXT NOT NULL,
                PRIMARY KEY(repository,comment_id)
            );
        ''')


def pages(repository, endpoint):
    page = 1
    while True:
        values = issue_bridge._github('GET', repository,
            endpoint + ('&' if '?' in endpoint else '?') + f'per_page=100&page={page}')
        if not isinstance(values, list):
            raise RuntimeError('GitHub returned invalid listing.')
        yield from values
        if len(values) < 100:
            break
        page += 1


def import_issues(path):
    route = inquiry.get_webhook(path, 'addon')
    if route is None or route['kind'] != 'forum':
        return
    initialize(path)
    repository = issue_bridge.repository_for('addon')
    now = int(time.time())
    with closing(issue_bridge.connect(path)) as db, db:
        db.execute('INSERT OR IGNORE INTO inquiry_github_sources VALUES(?,?,?)', (repository, now, now))
        source = db.execute('SELECT * FROM inquiry_github_sources WHERE repository=?', (repository,)).fetchone()
    since = datetime.fromtimestamp(max(0, source['scanned_at'] - 2), timezone.utc).isoformat()
    endpoint = '/issues?' + urlencode({'state': 'all', 'sort': 'updated', 'direction': 'asc', 'since': since})
    for issue in pages(repository, endpoint):
        if 'pull_request' in issue:
            continue
        created = datetime.fromisoformat(issue['created_at'].replace('Z', '+00:00')).timestamp()
        if created < source['enabled_at']:
            continue
        with closing(issue_bridge.connect(path)) as db:
            exists = db.execute('SELECT 1 FROM inquiry_issues WHERE repository=? AND issue_number=?',
                                (repository, issue['number'])).fetchone()
        if exists:
            continue
        key = f"github:{repository}#{issue['number']}"
        body = issue.get('body') or '（本文なし）'
        issue_bridge.save_issue(path, key, 'addon', repository, issue['number'], issue['html_url'],
                                'question', issue['title'], body, [], now)
    with closing(issue_bridge.connect(path)) as db, db:
        db.execute('UPDATE inquiry_github_sources SET scanned_at=? WHERE repository=?', (now, repository))


def sync_comments(path):
    route = inquiry.get_webhook(path, 'addon')
    if route is None or route['kind'] != 'forum':
        return
    initialize(path)
    repository = issue_bridge.repository_for('addon')
    with closing(issue_bridge.connect(path)) as db:
        source = db.execute('SELECT enabled_at FROM inquiry_github_sources WHERE repository=?', (repository,)).fetchone()
    if source is None:
        return
    for row in issue_bridge.list_linked(path):
        if row['product'] != 'addon' or row['repository'] != repository:
            continue
        for comment in pages(repository, f"/issues/{row['issue_number']}/comments"):
            body = comment.get('body') or ''
            created = datetime.fromisoformat(comment['created_at'].replace('Z', '+00:00')).timestamp()
            if (created < source['enabled_at'] or '<!-- discord-message-id:' in body
                    or comment['id'] == row['link_comment_id']
                    or body.startswith('Discordフォーラムの対応スレッド:')):
                continue
            digest = hashlib.sha256(body.encode()).hexdigest()
            with closing(issue_bridge.connect(path)) as db:
                old = db.execute('SELECT * FROM inquiry_github_comments WHERE repository=? AND comment_id=?',
                                 (repository, comment['id'])).fetchone()
            if old and old['content_hash'] == digest:
                continue
            author = comment.get('user', {}).get('login', 'GitHub')
            payload = {'content': f"GitHub / {author}\n{body[:1600]}\n\n{comment['html_url']}",
                       'allowed_mentions': {'parse': []}}
            url = route['webhook_url']
            if old:
                url += '/messages/' + old['message_id']
            url += '?' + urlencode({'thread_id': row['thread_id'], 'wait': 'true'})
            request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                              method='PATCH' if old else 'POST', headers={'Content-Type': 'application/json',
                              'User-Agent': 'DiscordBot (https://github.com/kuretoshi/TanukiBCL, 1.0)'})
            with urlopen(request, timeout=15) as response:
                result = json.load(response)
            if not result.get('id'):
                raise RuntimeError('Discord did not confirm GitHub comment delivery.')
            with closing(issue_bridge.connect(path)) as db, db:
                db.execute('''INSERT INTO inquiry_github_comments VALUES(?,?,?,?,?)
                    ON CONFLICT(repository,comment_id) DO UPDATE SET
                    message_id=excluded.message_id,content_hash=excluded.content_hash''',
                    (repository, comment['id'], row['thread_id'], str(result['id']), digest))
