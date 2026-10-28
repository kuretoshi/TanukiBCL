"""Refresh the read-only MariaDB viewer from the live SQLite player tables.

The application continues to use SQLite. Only player records are copied; password
hashes, invitations, inquiry contents and attachments stay out of the viewer.
"""

from datetime import datetime, timezone
import sqlite3

import pymysql


SQLITE_URI = 'file:/var/lib/tanuki-debug-auth/auth.sqlite3?mode=ro'
MYSQL_SOCKET = '/run/mysqld/mysqld.sock'
VIEWER_DB = 'tanuki_player_view'

TABLES = {
    'player_history': (
        'uid_digest,player_uid,display_name,friend_code,first_seen_at,last_seen_at',
        '''CREATE TABLE IF NOT EXISTS player_history (
            uid_digest CHAR(64) PRIMARY KEY,
            player_uid VARCHAR(256) NOT NULL,
            display_name TEXT NOT NULL,
            friend_code TEXT NOT NULL,
            first_seen_at BIGINT NOT NULL,
            last_seen_at BIGINT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''',
    ),
    'player_bans': (
        'uid_digest,display_name,friend_code,reason,created_at',
        '''CREATE TABLE IF NOT EXISTS player_bans (
            uid_digest CHAR(64) PRIMARY KEY,
            display_name TEXT NOT NULL,
            friend_code TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at BIGINT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''',
    ),
    'player_ban_uids': (
        'uid_digest,player_uid',
        '''CREATE TABLE IF NOT EXISTS player_ban_uids (
            uid_digest CHAR(64) PRIMARY KEY,
            player_uid VARCHAR(256) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''',
    ),
    'pending_player_name_bans': (
        'player_name,reason,created_at',
        '''CREATE TABLE IF NOT EXISTS pending_player_name_bans (
            player_name VARCHAR(255) PRIMARY KEY,
            reason TEXT NOT NULL,
            created_at BIGINT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''',
    ),
}


def snapshot_player_tables():
    source = sqlite3.connect(SQLITE_URI, uri=True, timeout=5)
    try:
        source.execute('BEGIN')
        return {
            name: source.execute(f'SELECT {columns} FROM {name}').fetchall()
            for name, (columns, _) in TABLES.items()
        }
    finally:
        source.close()


def refresh():
    snapshot = snapshot_player_tables()
    target = pymysql.connect(
        unix_socket=MYSQL_SOCKET,
        user='root',
        charset='utf8mb4',
        autocommit=False,
    )
    try:
        with target.cursor() as cursor:
            cursor.execute(f'CREATE DATABASE IF NOT EXISTS {VIEWER_DB} CHARACTER SET utf8mb4')
            cursor.execute(f'USE {VIEWER_DB}')
            for _, schema in TABLES.values():
                cursor.execute(schema)
            cursor.execute('''CREATE TABLE IF NOT EXISTS mirror_status (
                id TINYINT PRIMARY KEY,
                refreshed_at_utc DATETIME NOT NULL,
                player_history_count INT NOT NULL,
                player_bans_count INT NOT NULL,
                pending_player_name_bans_count INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''')
        target.commit()

        with target.cursor() as cursor:
            for name, (columns, _) in TABLES.items():
                cursor.execute(f'DELETE FROM {name}')
                rows = snapshot[name]
                if rows:
                    placeholders = ','.join(['%s'] * len(columns.split(',')))
                    cursor.executemany(
                        f'INSERT INTO {name} ({columns}) VALUES ({placeholders})',
                        rows,
                    )
            cursor.execute('''REPLACE INTO mirror_status VALUES (%s,%s,%s,%s,%s)''', (
                1,
                datetime.now(timezone.utc).replace(tzinfo=None),
                len(snapshot['player_history']),
                len(snapshot['player_bans']),
                len(snapshot['pending_player_name_bans']),
            ))
        target.commit()
    except Exception:
        target.rollback()
        raise
    finally:
        target.close()


if __name__ == '__main__':
    refresh()
