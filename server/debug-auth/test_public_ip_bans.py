"""Public IP attribution and independent UID/IP ban regression coverage."""
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from auth import (
    add_ban, add_pending_name_ban, canonical_public_ip, create_app, initialize,
    set_password, uid_digest, verify,
)


class PublicIpBanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / 'auth.sqlite3')
        self.client = create_app(self.db).test_client()
        set_password(self.db, 'admin', 'admin-password')
        self.admin_env = mock.patch.dict('os.environ', {'BAN_ADMIN_NAME': 'admin'})
        self.admin_env.start()
        self.addCleanup(self.admin_env.stop)
        self.admin_calls = 0

    def rows(self, sql, params=()):
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(sql, params)]

    def association(self, uid):
        rows = self.rows('SELECT * FROM player_public_ips WHERE uid_digest=?', (uid_digest(uid),))
        return rows[0] if rows else None

    def check(self, uid='self', ip='8.8.8.8', headers=None, **fields):
        payload = {'playerUid': uid, 'playerName': uid, 'friendCode': 'SELF#1234', **fields}
        return self.client.post('/v1/player-bans/check', json=payload, headers=headers,
                                environ_overrides={'REMOTE_ADDR': ip})

    def manage(self, action='list', **fields):
        # Keep actual rate limiting enabled without each test sharing one caller bucket.
        self.admin_calls += 1
        return self.client.post('/v1/player-bans/manage',
                                json={'password': 'admin-password', 'action': action, **fields},
                                environ_overrides={'REMOTE_ADDR': f'192.0.2.{self.admin_calls}'})

    def history(self):
        response = self.manage()
        self.assertEqual(response.status_code, 200)
        return {row['uid_digest']: row for row in response.json['history']}

    def test_canonical_public_ip_accepts_public_literals_and_mapped_ipv4(self):
        cases = {
            ' 8.8.8.8 ': '8.8.8.8',
            '2606:4700:4700:0000:0000:0000:0000:1111': '2606:4700:4700::1111',
            '::ffff:8.8.8.8': '8.8.8.8',
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(canonical_public_ip(value), expected)

    def test_canonical_public_ip_rejects_nonpublic_or_ambiguous_addresses(self):
        for value in (None, {}, 134744072, '', 'dns.google', '8.8.8.8,1.1.1.1', '8.8.8.8:443',
                      '[2606:4700:4700::1111]:443', '127.0.0.1', '::1', '10.1.2.3', 'fc00::1',
                      '169.254.1.1', 'fe80::1', '100.64.0.1', '192.0.2.1', '2001:db8::1',
                      '224.0.0.1', 'ff00::1', '240.0.0.1', '4000::1', 'fec0::1',
                      '2606:4700:4700::1111%eth0', '::ffff:127.0.0.1', '1' * 65):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'public IPv4 or IPv6'):
                canonical_public_ip(value)

    def test_direct_peer_ip_wins_over_headers_body_and_roster(self):
        response = self.check(headers={'X-Real-IP': '1.1.1.1', 'X-Forwarded-For': '9.9.9.9',
                                       'CF-Connecting-IP': '1.0.0.1'},
                              publicIp='208.67.222.222',
                              observedPlayers=[{'playerUid': 'observed', 'playerName': 'Observed',
                                                'friendCode': 'OTHER#1234', 'publicIp': '9.9.9.9'}])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {'banned': False})
        self.assertEqual(self.association('self')['public_ip'], '8.8.8.8')
        self.assertIsNone(self.association('observed'))
        history = self.history()
        self.assertEqual(history[uid_digest('self')]['friend_code'], 'SELF#1234')
        self.assertEqual(history[uid_digest('observed')]['public_ip'], '')

    def test_only_exact_loopback_peer_trusts_a_single_x_real_ip(self):
        for index, (peer, forwarded, expected) in enumerate((
                ('127.0.0.1', '1.1.1.1', '1.1.1.1'),
                ('::1', '2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111'),
                ('127.0.0.1', '::ffff:8.8.8.8', '8.8.8.8'),
                ('127.0.0.2', '1.1.1.1', None),
                ('::ffff:127.0.0.1', '1.1.1.1', None),
                ('127.0.0.1', '1.1.1.1, 8.8.8.8', None),
                ('127.0.0.1', '1.1.1.1:443', None),
                ('127.0.0.1', '10.0.0.1', None))):
            uid = f'proxy-{index}'
            with self.subTest(peer=peer, forwarded=forwarded):
                self.assertEqual(self.check(uid, peer, headers={'X-Real-IP': forwarded}).status_code, 200)
                record = self.association(uid)
                self.assertEqual(record['public_ip'] if record else None, expected)
        self.check('untrusted-forwarders', '127.0.0.1',
                   headers={'X-Forwarded-For': '8.8.8.8', 'CF-Connecting-IP': '1.1.1.1'})
        self.assertIsNone(self.association('untrusted-forwarders'))

    def test_roster_updates_and_unknown_self_ip_preserve_known_association(self):
        self.check('target', '1.1.1.1')
        self.check('observer', '8.8.8.8', observedPlayers=[
            {'playerUid': 'target', 'playerName': 'Renamed', 'publicIp': '9.9.9.9'},
            {'playerUid': 'roster-only', 'playerName': 'Roster Only'}])
        self.check('target', '127.0.0.1', publicIp='9.9.9.9')
        self.assertEqual(self.association('target')['public_ip'], '1.1.1.1')
        self.assertIsNone(self.association('roster-only'))
        self.check('nameless', '9.9.9.9', playerName='')
        self.assertEqual(self.association('nameless')['public_ip'], '9.9.9.9')
        self.assertNotIn(uid_digest('nameless'), self.history())

    def test_changed_ip_is_persisted_inside_history_throttle(self):
        with mock.patch('auth.time.time', return_value=1000):
            self.check()
        with mock.patch('auth.time.time', return_value=1001):
            self.check()
        self.assertEqual(self.association('self')['updated_at'], 1000)
        with mock.patch('auth.time.time', return_value=1002):
            self.check(ip='1.1.1.1')
        self.assertEqual(self.association('self')['public_ip'], '1.1.1.1')
        self.assertEqual(self.association('self')['updated_at'], 1002)
        self.assertEqual(self.history()[uid_digest('self')]['last_seen_at'], 1000)
        with mock.patch('auth.time.time', return_value=2802):
            self.check(ip='1.1.1.1')
        self.assertEqual(self.association('self')['updated_at'], 2802)

    def test_ip_ban_matches_request_ip_across_uids_but_does_not_follow_uid(self):
        self.check('target')
        added = self.manage('add-ip', playerUid='target', displayName='Target', reason='network')
        self.assertEqual(added.status_code, 200)
        self.assertTrue(added.json['ipBansAvailable'])
        self.assertEqual([(row['ban_type'], row['public_ip']) for row in added.json['bans']],
                         [('ip', '8.8.8.8')])
        self.assertEqual(self.check('different-uid').json, {'banned': True})
        self.assertEqual(self.check('target').json, {'banned': True})
        self.assertEqual(self.check('target', '1.1.1.1').json, {'banned': False})
        self.assertEqual(self.association('target')['public_ip'], '1.1.1.1')
        listed = self.manage().json['bans'][0]
        self.assertEqual(listed['public_ip'], '8.8.8.8')
        self.assertEqual(listed['player_uid'], 'target')
        self.assertEqual(self.rows('SELECT * FROM player_bans'), [])

    def test_banned_self_still_records_new_ip(self):
        add_ban(self.db, 'target')
        self.assertTrue(self.check('target').json['banned'])
        self.assertTrue(self.check('target', '1.1.1.1').json['banned'])
        self.assertEqual(self.association('target')['public_ip'], '1.1.1.1')

    def test_history_ip_ban_uses_verified_ip_and_retains_history_metadata(self):
        self.check('target', playerName='Target', friendCode='TARGET#1234')
        added = self.manage('add-history-ip', uidDigest=uid_digest('target'), reason='reviewed')
        self.assertEqual(added.status_code, 200)
        row = added.json['bans'][0]
        self.assertEqual((row['ban_type'], row['player_uid'], row['display_name'], row['friend_code'], row['reason']),
                         ('ip', 'target', 'Target', 'TARGET#1234', 'reviewed'))

    def test_missing_verified_ip_rejects_ip_actions_without_uid_fallback(self):
        self.check(observedPlayers=[{'playerUid': 'observed', 'playerName': 'Observed'}])
        for action, fields in (('add-ip', {'playerUid': 'unknown'}),
                               ('add-ip', {'playerUid': 'observed'}),
                               ('add-history-ip', {'uidDigest': uid_digest('observed')})):
            with self.subTest(action=action, fields=fields):
                response = self.manage(action, **fields)
                self.assertEqual(response.status_code, 400)
                self.assertIn('No verified public IP', response.json['error'])
        missing = self.manage('add-history-ip', uidDigest=uid_digest('unknown'))
        self.assertEqual(missing.status_code, 400)
        self.assertIn('history was not found', missing.json['error'])
        self.assertEqual(self.rows('SELECT * FROM player_bans'), [])
        self.assertEqual(self.rows('SELECT * FROM player_ip_bans'), [])

    def test_explicit_admin_ip_can_ban_without_history_and_is_canonical(self):
        added = self.manage('add-ip', playerUid='unseen', publicIp='::ffff:8.8.8.8')
        self.assertEqual(added.status_code, 200)
        self.assertEqual(added.json['bans'][0]['player_uid'], 'unseen')
        self.assertEqual(added.json['bans'][0]['public_ip'], '8.8.8.8')
        self.assertIsNone(self.association('unseen'))
        self.assertEqual(self.check('other').json, {'banned': True})
        self.assertEqual(self.manage('remove-ip', publicIp='::ffff:8.8.8.8').json['bans'], [])
        ipv6 = '2606:4700:4700:0:0:0:0:1111'
        added = self.manage('add-ip', playerUid='v6-target', publicIp=ipv6)
        self.assertEqual(added.json['bans'][0]['public_ip'], '2606:4700:4700::1111')
        self.assertEqual(self.check('v6-other', '2606:4700:4700::1111').json, {'banned': True})
        self.assertEqual(self.manage('remove-ip', publicIp=ipv6).json['bans'], [])
        for value in ('10.0.0.1', '8.8.8.8,1.1.1.1', 'ff00::1'):
            with self.subTest(value=value):
                self.assertEqual(self.manage('add-ip', playerUid='unseen', publicIp=value).status_code, 400)
                self.assertEqual(self.manage('remove-ip', publicIp=value).status_code, 400)

    def test_uid_and_ip_bans_remove_independently_in_both_orders(self):
        self.check('target')
        for first in ('remove', 'remove-ip'):
            with self.subTest(first=first):
                self.assertEqual(self.manage('add', playerUid='target').status_code, 200)
                self.assertEqual(self.manage('add-ip', playerUid='target').status_code, 200)
                if first == 'remove':
                    response = self.manage(first, uidDigest=uid_digest('target'))
                    self.assertEqual([row['ban_type'] for row in response.json['bans']], ['ip'])
                    self.assertFalse(self.check('target', '1.1.1.1').json['banned'])
                    self.assertTrue(self.check('new-uid').json['banned'])
                else:
                    response = self.manage(first, publicIp='8.8.8.8')
                    self.assertEqual([row['ban_type'] for row in response.json['bans']], ['uid'])
                    self.assertTrue(self.check('target', '1.1.1.1').json['banned'])
                    self.assertFalse(self.check('new-uid').json['banned'])
                identity = self.rows('SELECT player_uid FROM player_ban_uids WHERE uid_digest=?',
                                     (uid_digest('target'),))
                self.assertEqual(identity, [{'player_uid': 'target'}])
                self.manage('remove', uidDigest=uid_digest('target'))
                self.manage('remove-ip', publicIp='8.8.8.8')
                self.assertEqual(self.rows('SELECT * FROM player_ban_uids'), [])
                self.assertFalse(self.check('target').json['banned'])

    def test_history_flags_and_uid_ip_listing_update_independently(self):
        self.check('first')
        self.check('shared')
        self.check('unbanned', '9.9.9.9')
        self.manage('add', playerUid='first')
        self.manage('add-ip', playerUid='first')
        history = self.history()
        for uid, flags in (('first', (1, 1, 1)), ('shared', (0, 1, 1)), ('unbanned', (0, 0, 0))):
            row = history[uid_digest(uid)]
            self.assertEqual((row['uid_banned'], row['ip_banned'], row['is_banned']), flags)
        self.check('first', '1.1.1.1')
        response = self.manage()
        by_type = {row['ban_type']: row for row in response.json['bans']}
        self.assertEqual(by_type['uid']['public_ip'], '1.1.1.1')
        self.assertEqual(by_type['ip']['public_ip'], '8.8.8.8')
        row = next(row for row in response.json['history'] if row['uid_digest'] == uid_digest('first'))
        self.assertEqual((row['uid_banned'], row['ip_banned'], row['is_banned']), (1, 0, 1))

    def test_reassigning_ip_ban_cleans_only_unreferenced_identity(self):
        with mock.patch('auth.time.time', return_value=1000):
            self.manage('add-ip', playerUid='first', publicIp='8.8.8.8')
        first_created = self.manage().json['bans'][0]['created_at']
        self.assertEqual(first_created, 1000)
        with mock.patch('auth.time.time', return_value=2000):
            self.manage('add-ip', playerUid='second', publicIp='8.8.8.8')
        self.assertEqual(self.rows('SELECT player_uid FROM player_ban_uids'), [{'player_uid': 'second'}])
        self.manage('add', playerUid='second')
        with mock.patch('auth.time.time', return_value=3000):
            self.manage('add-ip', playerUid='third', publicIp='8.8.8.8')
        self.assertEqual({row['player_uid'] for row in self.rows('SELECT player_uid FROM player_ban_uids')},
                         {'second', 'third'})
        self.assertEqual(self.rows('SELECT created_at FROM player_ip_bans')[0]['created_at'], first_created)

    def test_new_ip_actions_require_named_admin(self):
        set_password(self.db, 'tester', 'tester-password')
        for action, fields in (('list', {}), ('add-ip', {'playerUid': 'target', 'publicIp': '8.8.8.8'}),
                               ('add-history-ip', {'uidDigest': uid_digest('target')}),
                               ('remove-ip', {'publicIp': '8.8.8.8'})):
            for password in ('tester-password', 'wrong'):
                with self.subTest(action=action, password=password):
                    denied = self.manage(action, password=password, **fields)
                    self.assertEqual(denied.status_code, 403)
                    self.assertNotIn('ipBansAvailable', denied.json)
        with mock.patch.dict('os.environ', {'BAN_ADMIN_NAME': ''}):
            self.assertEqual(self.manage('add-ip', playerUid='target', publicIp='8.8.8.8').status_code, 403)
        self.assertEqual(self.rows('SELECT * FROM player_ip_bans'), [])

    def test_initialization_migrates_old_database_without_changing_existing_rows(self):
        self.check('target', '127.0.0.1')
        add_ban(self.db, 'target', 'Target', 'OLD#1234', 'old reason')
        add_pending_name_ban(self.db, 'Pending', 'old pending')
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO inquiry_attempts VALUES(?,?)', ('fixture-source', 1234))
            db.execute('DROP TABLE player_ip_bans')
            db.execute('DROP TABLE player_public_ips')
        old_tables = ('passwords', 'player_bans', 'player_ban_uids', 'player_history',
                      'pending_player_name_bans', 'inquiry_attempts')
        original = {table: self.rows(f'SELECT * FROM {table}') for table in old_tables}
        initialize(self.db)
        initialize(self.db)
        self.assertEqual({table: self.rows(f'SELECT * FROM {table}') for table in old_tables}, original)
        self.assertEqual(self.rows('SELECT * FROM player_public_ips'), [])
        self.assertEqual(self.rows('SELECT * FROM player_ip_bans'), [])
        self.assertTrue(verify(self.db, 'admin-password'))
        self.assertTrue(self.check('target').json['banned'])


if __name__ == '__main__':
    unittest.main()
