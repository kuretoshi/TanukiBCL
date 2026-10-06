import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path

from auth import allow_attempt, create_app, initialize, set_password, verify, issue_invitation, redeem_invitation


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


if __name__ == '__main__':
    unittest.main()
