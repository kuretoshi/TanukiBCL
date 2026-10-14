import sqlite3
import asyncio
from contextlib import closing
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from auth import allow_attempt, create_app, initialize, set_password, verify, issue_invitation, redeem_invitation
import inquiry
import issue_bridge
import discord_bridge
import update_inquiry_github_token as token_tool


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / 'auth.sqlite3')
        initialize(self.db)
        self.client = create_app(self.db).test_client()

    def tearDown(self):
        self.temp.cleanup()

    def test_password_change_disable_and_storage(self):
        set_password(self.db, 'tester', 'original')
        self.assertTrue(verify(self.db, 'original'))
        self.assertFalse(verify(self.db, 'wrong'))
        set_password(self.db, 'second', 'second-password')
        self.assertTrue(verify(self.db, 'second-password'))
        set_password(self.db, 'tester', 'replacement')
        self.assertFalse(verify(self.db, 'original'))
        self.assertTrue(verify(self.db, 'replacement'))
        with closing(sqlite3.connect(self.db)) as db, db:
            self.assertNotIn('replacement', repr(db.execute('SELECT * FROM passwords').fetchall()))
            db.execute('UPDATE passwords SET enabled=0 WHERE name=?', ('tester',))
        self.assertFalse(verify(self.db, 'replacement'))
        self.assertTrue(verify(self.db, 'second-password'))

    def test_api_and_revocation_without_restart(self):
        set_password(self.db, 'tester', 'valid')
        endpoint = '/v1/debug-auth/verify'
        response = self.client.post(endpoint, json={'password': 'valid'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['authorized'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE passwords SET enabled=0')
        self.assertEqual(self.client.post(endpoint, json={'password': 'valid'}).status_code, 401)
        for password in (None, '', {}, 'x' * 1025):
            self.assertEqual(self.client.post(endpoint, json={'password': password}).status_code, 401)
        self.assertEqual(self.client.post(endpoint, data='not json').status_code, 401)
        self.assertEqual(self.client.get(endpoint).status_code, 405)
        self.assertEqual(self.client.post(endpoint, json={'password': 'x' * 8193}).status_code, 413)

    def test_rate_limit_persisted_and_releases(self):
        for _ in range(10):
            self.assertTrue(allow_attempt(self.db, 'test-source', 100))
        self.assertFalse(allow_attempt(self.db, 'test-source', 100))
        self.assertTrue(allow_attempt(self.db, 'other-source', 100))
        self.assertTrue(allow_attempt(self.db, 'test-source', 160))

    def test_limits_and_sql_names(self):
        set_password(self.db, "tester'); DROP TABLE passwords; --", 'safe')
        self.assertTrue(verify(self.db, 'safe'))
        for invalid in ('', None, 'x' * 1025):
            with self.assertRaises(ValueError):
                set_password(self.db, 'invalid', invalid)

    def test_invitation_registration_and_replay(self):
        code = issue_invitation(self.db, 'tester')
        with closing(sqlite3.connect(self.db)) as db:
            self.assertNotIn(code, repr(db.execute('SELECT * FROM invitations').fetchall()))
        endpoint = '/v1/debug-auth/register'
        self.assertEqual(self.client.post(endpoint, json={'code': code, 'password': 'short'}).status_code, 400)
        response = self.client.post(endpoint, json={'code': code, 'password': 'tester-password'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json['registered'])
        self.assertTrue(verify(self.db, 'tester-password'))
        self.assertFalse(redeem_invitation(self.db, code, 'replacement-password'))
        self.assertTrue(verify(self.db, 'tester-password'))
        with self.assertRaises(ValueError):
            issue_invitation(self.db, 'tester')

    def test_expiry_reissue_and_registration_limit(self):
        old = issue_invitation(self.db, 'tester')
        code = issue_invitation(self.db, 'tester')
        self.assertFalse(redeem_invitation(self.db, old, 'tester-password'))
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('UPDATE invitations SET expires_at=0')
        self.assertFalse(redeem_invitation(self.db, code, 'tester-password'))
        code = issue_invitation(self.db, 'tester')
        for i in range(16):
            set_password(self.db, str(i), 'existing-password')
        with self.assertRaises(ValueError):
            redeem_invitation(self.db, code, 'tester-password')
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("DELETE FROM passwords WHERE name='0'")
        self.assertTrue(redeem_invitation(self.db, code, 'tester-password'))

    def test_concurrent_redemption(self):
        from concurrent.futures import ThreadPoolExecutor
        code = issue_invitation(self.db, 'concurrent')
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: redeem_invitation(self.db, code, 'concurrent-password'), range(2)))
        self.assertEqual(sorted(outcomes), [False, True])

    def test_registration_page_and_assets(self):
        for path in ('/debug-register', '/debug-register/register.js', '/debug-register/register.css'):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
            response.close()
        self.assertEqual(self.client.get('/debug-register/auth.py').status_code, 404)


class InquiryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / 'auth.sqlite3')
        initialize(self.db)
        self.client = create_app(self.db).test_client()
        self.url_tanuki = 'https://discord.com/api/webhooks/123456789/tanuki_test_token'
        self.url_net = 'https://discord.com/api/webhooks/987654321/net_test_token'

    def tearDown(self):
        self.temp.cleanup()

    def test_routes_are_separate_and_secret_is_not_exposed(self):
        inquiry.set_webhook(self.db, 'tanuki', self.url_tanuki, 'text')
        inquiry.set_webhook(self.db, 'net', self.url_net, 'forum', {'bug': '12345'})
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM inquiry_webhooks').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM passwords').fetchone()[0], 0)
        requests = []

        def fake_open(request, timeout):
            requests.append(request)
            return io.BytesIO(b'{"id":"42"}')

        with mock.patch.object(inquiry, 'urlopen', side_effect=fake_open):
            for product in inquiry.PRODUCTS:
                result = self.client.post('/v1/inquiries', json={
                    'product': product, 'tag': 'bug', 'subject': 'Broken', 'body': 'Details',
                    'public_issue_consent': False})
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json, {'submitted': True})
                self.assertNotIn('discord.com', result.get_data(as_text=True))
        self.assertEqual([request.full_url for request in requests],
                         [self.url_tanuki + '?wait=true', self.url_net + '?wait=true'])
        self.assertEqual(json.loads(requests[0].data)['allowed_mentions'], {'parse': []})
        self.assertEqual(json.loads(requests[1].data)['applied_tags'], ['12345'])
        self.assertEqual(json.loads(requests[1].data)['thread_name'], 'Broken')
        self.assertEqual(requests[1].get_header('User-agent'),
                         'DiscordBot (https://github.com/kuretoshi/TanukiBCL, 1.0)')

    def test_multipart_attachment_and_limits(self):
        inquiry.set_webhook(self.db, 'net', self.url_net, 'forum')
        sent = []

        def fake_open(request, timeout):
            sent.append(request)
            return io.BytesIO(b'{"id":"42"}')

        with mock.patch.object(inquiry, 'urlopen', side_effect=fake_open):
            result = self.client.post('/v1/inquiries', data={
                'payload_json': json.dumps({'product': 'net', 'tag': 'question',
                                            'subject': 'Subject', 'body': 'Body'}),
                'files[0]': (io.BytesIO(b'attachment content'), 'test.txt'),
            })
        self.assertEqual(result.status_code, 200)
        self.assertIn(b'attachment content', sent[0].data)
        self.assertIn('multipart/form-data', sent[0].get_header('Content-type'))

    def test_missing_route_invalid_input_and_rate_limit(self):
        valid = {'product': 'net', 'tag': 'bug', 'subject': 'Subject', 'body': 'Body'}
        self.assertEqual(self.client.post('/v1/inquiries', json=valid).status_code, 503)
        inquiry.set_webhook(self.db, 'net', self.url_net)
        self.assertEqual(self.client.post('/v1/inquiries', json={**valid, 'product': 'other'}).status_code, 400)
        self.assertEqual(self.client.post('/v1/inquiries', json={**valid, 'body': ''}).status_code, 400)
        with mock.patch.object(inquiry, 'urlopen', side_effect=lambda request, timeout: io.BytesIO(b'{"id":"42"}')):
            for _ in range(7):
                self.assertEqual(self.client.post('/v1/inquiries', json=valid).status_code, 200)
            self.assertEqual(self.client.post('/v1/inquiries', json=valid).status_code, 429)

    def test_discord_failure_does_not_expose_webhook(self):
        from urllib.error import HTTPError
        inquiry.set_webhook(self.db, 'net', self.url_net)
        with mock.patch.object(inquiry, 'urlopen', side_effect=HTTPError(self.url_net, 403, 'Forbidden', {}, None)):
            result = self.client.post('/v1/inquiries', json={
                'product': 'net', 'tag': 'bug', 'subject': 'Broken', 'body': 'Details'})
        self.assertEqual(result.status_code, 502)
        self.assertNotIn(self.url_net, result.get_data(as_text=True))

    def test_webhook_validation(self):
        for invalid in (self.url_net + '/github', self.url_net + '?wait=true',
                        'http://discord.com/api/webhooks/1/token',
                        'https://example.invalid/api/webhooks/1/token'):
            with self.assertRaises(ValueError):
                inquiry.set_webhook(self.db, 'net', invalid)

    def test_tanuki_public_issue_with_download_and_discord_mirror(self):
        inquiry.set_webhook(self.db, 'tanuki', self.url_tanuki, 'forum')
        requests = []

        def github(method, repository, endpoint, payload=None):
            requests.append((method, endpoint, payload))
            if endpoint == '/issues':
                return {'number': 7, 'html_url': 'https://github.com/kuretoshi/TanukiBCL/issues/7'}
            return {'id': 101}

        def discord(request, timeout):
            requests.append(('DISCORD', request.full_url, request.data))
            return io.BytesIO(b'{"id":"50","channel_id":"60","guild_id":"70"}')

        data = {'payload_json': json.dumps({'product': 'tanuki', 'tag': 'bug',
                'subject': 'Public bug', 'body': 'Details', 'public_issue_consent': True}),
                'files[0]': (io.BytesIO(b'example log'), 'report.log')}
        with mock.patch.dict('os.environ', {'INQUIRY_GITHUB_REPO_TANUKI': 'kuretoshi/TanukiBCL'}), \
                mock.patch.object(issue_bridge, '_github', side_effect=github), \
                mock.patch.object(inquiry, 'urlopen', side_effect=discord):
            result = self.client.post('/v1/inquiries', data=data)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['issue_url'], 'https://github.com/kuretoshi/TanukiBCL/issues/7')
        issue_body = requests[0][2]['body']
        self.assertIn('report.log', issue_body)
        self.assertIn('/v1/inquiries/attachments/', issue_body)
        token = issue_body.split('/v1/inquiries/attachments/')[1].split(')')[0]
        download = self.client.get('/v1/inquiries/attachments/' + token)
        self.assertEqual(download.data, b'example log')
        self.assertEqual(download.headers['Content-Type'], 'application/octet-stream')
        self.assertEqual(self.client.get('/v1/inquiries/attachments/bad').status_code, 404)
        self.assertEqual(issue_bridge.get_by_thread(self.db, '60')['issue_number'], 7)
        self.assertIn(b'GitHub Issue:', requests[1][2])

    def test_discord_reply_edit_delete_and_thread_title_sync(self):
        issue_bridge.save_issue(self.db, 'key', 'tanuki', 'kuretoshi/TanukiBCL', 7,
                                'https://github.com/kuretoshi/TanukiBCL/issues/7',
                                'bug', 'Subject', 'Body', [], 1)
        issue_bridge.link_thread(self.db, 'key', '60', '50', '70')
        requests = []

        def github(method, repository, endpoint, payload=None):
            requests.append((method, endpoint, payload))
            return {'id': 101}

        with mock.patch.object(issue_bridge, '_github', side_effect=github):
            attachment_url = issue_bridge.save_discord_attachment(self.db, '51', '201', 'image.png', b'png data')
            self.assertEqual(issue_bridge.save_discord_attachment(self.db, '51', '201', 'image.png', b'png data'), attachment_url)
            attachment = [('image.png', attachment_url)]
            self.assertTrue(issue_bridge.sync_comment(self.db, '60', '51', 'Reporter', 'First', attachment))
            self.assertFalse(issue_bridge.sync_comment(self.db, '60', '51', 'Reporter', 'First', attachment))
            self.assertTrue(issue_bridge.sync_comment(self.db, '60', '51', 'Reporter', 'Edited'))
            self.assertTrue(issue_bridge.sync_comment(self.db, '60', '51', '', '', deleted=True))
            self.assertTrue(issue_bridge.rename_issue(self.db, '60', 'Renamed'))
        self.assertEqual([x[0] for x in requests], ['POST', 'PATCH', 'PATCH', 'PATCH'])
        self.assertIn(attachment_url, requests[0][2]['body'])
        self.assertIn('削除', requests[2][2]['body'])
        self.assertIn('Renamed', requests[3][2]['title'])

    def test_net_public_issue_uses_net_repository_and_forum(self):
        inquiry.set_webhook(self.db, 'net', self.url_net, 'forum')
        calls = []

        def github(method, repository, endpoint, payload=None):
            calls.append((method, repository, endpoint, payload))
            if endpoint == '/issues':
                return {'number': 12,
                        'html_url': 'https://github.com/kuretoshi/BetterCrewLink_Net/issues/12'}
            return {'id': 101}

        def discord(request, timeout):
            calls.append(('DISCORD', request.full_url, request.data))
            return io.BytesIO(b'{"id":"80","channel_id":"90","guild_id":"70"}')

        payload = {'product': 'net', 'tag': 'bug', 'subject': 'Net bug',
                   'body': 'Details', 'public_issue_consent': True}
        with mock.patch.dict('os.environ', {'INQUIRY_GITHUB_REPO_NET': 'kuretoshi/BetterCrewLink_Net'}), \
                mock.patch.object(issue_bridge, '_github', side_effect=github), \
                mock.patch.object(inquiry, 'urlopen', side_effect=discord):
            result = self.client.post('/v1/inquiries', json=payload)
            self.assertTrue(issue_bridge.sync_comment(self.db, '90', '91', 'Reporter', 'Reply'))
            self.assertTrue(issue_bridge.rename_issue(self.db, '90', 'Renamed'))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['issue_url'],
                         'https://github.com/kuretoshi/BetterCrewLink_Net/issues/12')
        self.assertEqual(calls[0][:3], ('POST', 'kuretoshi/BetterCrewLink_Net', '/issues'))
        self.assertIn(b'github.com/kuretoshi/BetterCrewLink_Net/issues/12', calls[1][2])
        self.assertEqual(calls[2][1:3], ('kuretoshi/BetterCrewLink_Net', '/issues/12/comments'))
        self.assertEqual(calls[3][1:3], ('kuretoshi/BetterCrewLink_Net', '/issues/12/comments'))
        self.assertEqual(calls[4][1:3], ('kuretoshi/BetterCrewLink_Net', '/issues/12'))

    def test_bot_completes_discord_link_when_webhook_omits_guild_id(self):
        issue_bridge.save_issue(self.db, 'key', 'tanuki', 'kuretoshi/TanukiBCL', 7,
                                'https://github.com/kuretoshi/TanukiBCL/issues/7',
                                'bug', 'Subject', 'Body', [], 1)
        issue_bridge.link_thread(self.db, 'key', '60', '50', None)
        with mock.patch.object(issue_bridge, '_github', return_value={'id': 101}) as github:
            row = issue_bridge.set_guild_id(self.db, '60', '70')
            self.assertTrue(issue_bridge.ensure_discord_link(self.db, row))
            self.assertFalse(issue_bridge.ensure_discord_link(self.db, issue_bridge.get_by_thread(self.db, '60')))
        self.assertIn('discord.com/channels/70/60', github.call_args.args[3]['body'])

    def test_discord_direct_issue_and_initial_updates(self):
        self.assertEqual(issue_bridge.discord_source_since(self.db, '20', now=100), 100)
        self.assertEqual(issue_bridge.discord_source_since(self.db, '20', now=200), 100)
        self.assertEqual(issue_bridge.discord_scan_since(self.db, '20'), 100)
        issue_bridge.mark_discord_scan(self.db, '20', 150)
        self.assertEqual(issue_bridge.discord_scan_since(self.db, '20'), 150)
        body = issue_bridge.discord_issue_body('question', 'Reporter', 'First post',
                                               [('log.txt', 'https://example.com/log')],
                                               'https://discord.com/channels/70/60')
        self.assertIn('First post', body)
        self.assertIn('log.txt', body)
        requests = []

        def github(method, repository, endpoint, payload=None):
            requests.append((method, endpoint, payload))
            if endpoint == '/issues':
                return {'number': 9, 'html_url': 'https://github.com/kuretoshi/TanukiBCL/issues/9'}
            return {'id': 102}

        with mock.patch.object(issue_bridge, '_github', side_effect=github):
            first = issue_bridge.create_discord_issue(self.db, 'kuretoshi/TanukiBCL',
                    'question', 'Direct post', body, '60', '70', '60')
            second = issue_bridge.create_discord_issue(self.db, 'kuretoshi/TanukiBCL',
                    'question', 'Direct post', body, '60', '70', '60')
            self.assertEqual(first['issue_number'], second['issue_number'])
            self.assertFalse(issue_bridge.ensure_discord_link(self.db, first))
            edited = issue_bridge.discord_issue_body('question', 'Reporter', 'Edited post', [],
                                                     'https://discord.com/channels/70/60')
            self.assertTrue(issue_bridge.sync_discord_initial(self.db, '60', edited))
            self.assertFalse(issue_bridge.sync_discord_initial(self.db, '60', edited))
            self.assertTrue(issue_bridge.rename_issue(self.db, '60', 'Renamed', 'bug'))
            self.assertTrue(issue_bridge.sync_comment(self.db, '60', '61', 'Helper', 'Reply'))
            deleted = issue_bridge.discord_issue_body('bug', '', '', [],
                    'https://discord.com/channels/70/60', deleted=True)
            self.assertTrue(issue_bridge.sync_discord_initial(self.db, '60', deleted))
        self.assertEqual([item[0] for item in requests], ['POST', 'PATCH', 'PATCH', 'POST', 'PATCH'])
        self.assertEqual(issue_bridge.get_by_thread(self.db, '60')['tag'], 'bug')
        self.assertIn('削除', requests[-1][2]['body'])

    def test_bot_imports_human_starter_once_and_skips_webhook(self):
        class FakeThread:
            def __init__(self, thread_id, webhook_id=None):
                self.id = thread_id
                self.name = 'Direct report'
                self.guild = SimpleNamespace(id=70)
                self.starter = SimpleNamespace(id=thread_id, webhook_id=webhook_id,
                        author=SimpleNamespace(bot=False, display_name='Reporter'))

            async def fetch_message(self, message_id):
                self.asserted_id = message_id
                return self.starter

        requests = []

        def github(method, repository, endpoint, payload=None):
            requests.append((method, endpoint, payload))
            return {'number': 10, 'html_url': 'https://github.com/kuretoshi/TanukiBCL/issues/10'}

        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            with mock.patch.object(client, '_is_new_source_thread', return_value=True), \
                    mock.patch.object(client, '_tag_for_thread', return_value='question'), \
                    mock.patch.object(client, '_message_data', new=mock.AsyncMock(return_value=('Body', []))):
                human = FakeThread(60)
                first = await client._import_thread(human)
                second = await client._import_thread(human)
                ignored = await client._import_thread(FakeThread(61, webhook_id=123))
                self.assertEqual(human.asserted_id, 60)
                self.assertEqual(first['issue_number'], second['issue_number'])
                self.assertIsNone(ignored)
            await client.close()

        with mock.patch.dict('os.environ', {'INQUIRY_DISCORD_FORUM_ID_TANUKI': '20',
                                             'INQUIRY_GITHUB_REPO_TANUKI': 'kuretoshi/TanukiBCL'}), \
                mock.patch.object(discord_bridge, 'DATABASE', self.db), \
                mock.patch.object(issue_bridge, '_github', side_effect=github):
            asyncio.run(exercise())
        self.assertEqual(len(requests), 1)

    def test_issue_is_accepted_when_discord_is_temporarily_unavailable(self):
        from urllib.error import HTTPError
        inquiry.set_webhook(self.db, 'tanuki', self.url_tanuki, 'forum')
        github = mock.Mock(return_value={'number': 8,
            'html_url': 'https://github.com/kuretoshi/TanukiBCL/issues/8'})
        payload = {'product': 'tanuki', 'tag': 'bug', 'subject': 'Intermittent',
                   'body': 'Details', 'public_issue_consent': True}
        with mock.patch.dict('os.environ', {'INQUIRY_GITHUB_REPO_TANUKI': 'kuretoshi/TanukiBCL'}), \
                mock.patch.object(issue_bridge, '_github', github), \
                mock.patch.object(inquiry, 'urlopen', side_effect=HTTPError(self.url_tanuki, 503, 'Unavailable', {}, None)):
            result = self.client.post('/v1/inquiries', json=payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['issue_url'], 'https://github.com/kuretoshi/TanukiBCL/issues/8')
        self.assertEqual(len(issue_bridge.pending(self.db)), 1)

    def test_product_github_tokens_are_selected_independently(self):
        response = io.BytesIO(b'{}')
        with mock.patch.dict('os.environ', {
            'INQUIRY_GITHUB_REPO_NET': 'kuretoshi/BetterCrewLink_Net',
            'INQUIRY_GITHUB_TOKEN': 'tanuki_token',
            'INQUIRY_GITHUB_TOKEN_NET': 'net_token',
        }), mock.patch.object(issue_bridge, 'urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = response
            issue_bridge._github('GET', 'kuretoshi/BetterCrewLink_Net', '/issues')
            self.assertEqual(urlopen.call_args.args[0].get_header('Authorization'), 'Bearer net_token')
            response.seek(0)
            issue_bridge._github('GET', 'kuretoshi/TanukiBCL', '/issues')
            self.assertEqual(urlopen.call_args.args[0].get_header('Authorization'), 'Bearer tanuki_token')

    def test_interactive_net_token_update_keeps_tanuki_and_bot_tokens(self):
        path = Path(self.temp.name) / 'bridge.env'
        path.write_text('INQUIRY_GITHUB_TOKEN=old\nINQUIRY_DISCORD_BOT_TOKEN=keep\n', encoding='utf-8')
        token_tool.replace_token(path, 'github_pat_new')
        self.assertEqual(path.read_text(encoding='utf-8'),
                         'INQUIRY_GITHUB_TOKEN=old\nINQUIRY_DISCORD_BOT_TOKEN=keep\n'
                         'INQUIRY_GITHUB_TOKEN_NET=github_pat_new\n')
        token_tool.replace_token(path, 'github_pat_newer')
        self.assertIn('INQUIRY_GITHUB_TOKEN_NET=github_pat_newer\n', path.read_text(encoding='utf-8'))
        with self.assertRaises(ValueError):
            token_tool.replace_token(path, 'bad token')
        self.assertIn('INQUIRY_GITHUB_TOKEN=old\n', path.read_text(encoding='utf-8'))
        from urllib.error import HTTPError
        with mock.patch.object(token_tool, 'urlopen',
                               side_effect=HTTPError('https://api.github.com', 422, 'Invalid', {}, None)):
            token_tool.check_issue_permission('github_pat_new', 'kuretoshi/BetterCrewLink_Net')
        with mock.patch.object(token_tool, 'urlopen',
                               side_effect=HTTPError('https://api.github.com', 403, 'Forbidden', {}, None)):
            with self.assertRaisesRegex(RuntimeError, 'HTTP 403'):
                token_tool.check_issue_permission('github_pat_new', 'kuretoshi/BetterCrewLink_Net')


if __name__ == '__main__':
    unittest.main()
