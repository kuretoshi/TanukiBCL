import sqlite3
from contextlib import closing
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from auth import allow_attempt, create_app, initialize, set_password, verify, issue_invitation, redeem_invitation
import inquiry
import issue_bridge


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
                    'public_issue_consent': product == 'net'})
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


if __name__ == '__main__':
    unittest.main()
