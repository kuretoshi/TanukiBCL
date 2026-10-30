"""Public IP tables remain visible in the existing read-only database mirror."""
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import auth
import heidisql_mirror as mirror


class PublicIpMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'auth.sqlite3'
        auth.initialize(str(self.path))

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_adds_only_player_ip_tables(self):
        with closing(auth.connect(str(self.path))) as db, db:
            db.execute('INSERT INTO player_public_ips VALUES(?,?,?)', ('a' * 64, '8.8.8.8', 123))
            db.execute('INSERT INTO player_ip_bans VALUES(?,?,?,?,?,?)',
                       ('8.8.8.8', 'a' * 64, 'Player', 'CODE', 'reason', 123))
        uri = 'file:' + self.path.as_posix() + '?mode=ro'
        with mock.patch.object(mirror, 'SQLITE_URI', uri):
            snapshot = mirror.snapshot_player_tables()
        self.assertEqual(snapshot['player_public_ips'], [('a' * 64, '8.8.8.8', 123)])
        self.assertEqual(snapshot['player_ip_bans'][0][0], '8.8.8.8')
        self.assertEqual(set(snapshot), {'player_history', 'player_bans', 'player_ban_uids',
                                        'pending_player_name_bans', 'player_public_ips', 'player_ip_bans'})
        self.assertNotIn('passwords', snapshot)
        self.assertNotIn('inquiries', snapshot)

    def target(self):
        target = mock.MagicMock()
        cursor = target.cursor.return_value.__enter__.return_value
        snapshot = {name: [] for name in mirror.TABLES}
        snapshot['player_public_ips'] = [('a' * 64, '8.8.8.8', 123)]
        snapshot['player_ip_bans'] = [('8.8.8.8', 'a' * 64, 'Player', '', '', 123)]
        return target, cursor, snapshot

    def test_refresh_creates_and_copies_ip_tables_with_bound_values(self):
        target, cursor, snapshot = self.target()
        with mock.patch.object(mirror, 'snapshot_player_tables', return_value=snapshot), \
                mock.patch.object(mirror.pymysql, 'connect', return_value=target):
            mirror.refresh()
        queries = [call.args[0] for call in cursor.execute.call_args_list]
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS player_public_ips' in sql for sql in queries))
        self.assertTrue(any('CREATE TABLE IF NOT EXISTS player_ip_bans' in sql for sql in queries))
        self.assertIn('DELETE FROM player_public_ips', queries)
        self.assertIn('DELETE FROM player_ip_bans', queries)
        self.assertEqual(cursor.executemany.call_count, 2)
        copied = {call.args[0]: call.args[1] for call in cursor.executemany.call_args_list}
        self.assertIn(snapshot['player_public_ips'], copied.values())
        self.assertIn(snapshot['player_ip_bans'], copied.values())
        self.assertEqual(target.commit.call_count, 2)
        target.rollback.assert_not_called()
        target.close.assert_called_once()

    def test_copy_failure_rolls_back_all_player_table_changes(self):
        target, cursor, snapshot = self.target()
        cursor.executemany.side_effect = RuntimeError('copy failed')
        with mock.patch.object(mirror, 'snapshot_player_tables', return_value=snapshot), \
                mock.patch.object(mirror.pymysql, 'connect', return_value=target):
            with self.assertRaisesRegex(RuntimeError, 'copy failed'):
                mirror.refresh()
        target.rollback.assert_called_once()
        target.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
