"""Resolution sync uses real SQLite mappings and mocked remote APIs (no posts)."""
import asyncio
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest import mock

import discord
import discord_bridge
import issue_bridge


class ResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / 'mapping.sqlite3')
        issue_bridge.initialize(self.db)
        self.env = mock.patch.dict('os.environ', {
            'INQUIRY_DISCORD_FORUM_ID_TANUKI': '20',
            'INQUIRY_DISCORD_FORUM_ID_NET': '21',
            'INQUIRY_DISCORD_FORUM_ID_ADDON': '22',
            'INQUIRY_GITHUB_REPO_TANUKI': 'kuretoshi/TanukiBCL',
            'INQUIRY_GITHUB_REPO_NET': 'kuretoshi/BetterCrewLink_Net',
            'INQUIRY_GITHUB_REPO_ADDON': 'kuretoshi/TanukiBCL-NoSAddon',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.patch_db = mock.patch.object(discord_bridge, 'DATABASE', self.db)
        self.patch_db.start()
        self.addCleanup(self.patch_db.stop)
        self.link()

    def link(self, product='tanuki', fingerprint='app-report'):
        repository = issue_bridge.repository_for(product)
        with closing(issue_bridge.connect(self.db)) as db, db:
            db.execute('DELETE FROM inquiry_issues')
        issue_bridge.save_issue(self.db, fingerprint, product, repository, 25,
                               f'https://github.com/{repository}/issues/25',
                               'bug', 'Original', 'Body', [], 1)
        issue_bridge.link_thread(self.db, fingerprint, 60, 60, 70)

    def test_close_completed_exact_counterpart_without_comment(self):
        with mock.patch.object(issue_bridge, '_github', side_effect=[
            {'number': 25, 'state': 'open'},
            {'number': 25, 'state': 'closed', 'state_reason': 'completed'},
        ]) as github:
            self.assertTrue(issue_bridge.resolve_issue(self.db, 60))
        self.assertEqual(github.call_args_list, [
            mock.call('GET', 'kuretoshi/TanukiBCL', '/issues/25'),
            mock.call('PATCH', 'kuretoshi/TanukiBCL', '/issues/25',
                      {'state': 'closed', 'state_reason': 'completed'}),
        ])

    def test_already_closed_is_not_updated_or_reopened(self):
        with mock.patch.object(issue_bridge, '_github', return_value={
            'number': 25, 'state': 'closed', 'state_reason': 'not_planned',
        }) as github:
            self.assertFalse(issue_bridge.resolve_issue(self.db, 60))
            github.assert_called_once()

    def test_unlinked_thread_is_not_imported(self):
        with mock.patch.object(issue_bridge, '_github') as github:
            self.assertFalse(issue_bridge.resolve_issue(self.db, 999))
            github.assert_not_called()

    def test_wrong_issue_pr_and_invalid_responses_are_rejected(self):
        for response in ({'number': 26, 'state': 'open'},
                         {'number': 25, 'state': 'open', 'pull_request': {}},
                         {'number': 25, 'state': 'unknown'}, [], None):
            with self.subTest(response=response), mock.patch.object(
                    issue_bridge, '_github', return_value=response) as github:
                with self.assertRaises(RuntimeError):
                    issue_bridge.resolve_issue(self.db, 60)
                github.assert_called_once()

    def test_failure_is_retried_not_remembered_as_success(self):
        with mock.patch.object(issue_bridge, '_github', side_effect=[
            {'number': 25, 'state': 'open'}, RuntimeError('503'),
            {'number': 25, 'state': 'open'},
            {'number': 25, 'state': 'closed', 'state_reason': 'completed'},
        ]) as github:
            with self.assertRaises(RuntimeError):
                issue_bridge.resolve_issue(self.db, 60)
            self.assertTrue(issue_bridge.resolve_issue(self.db, 60))
            self.assertEqual(github.call_count, 4)

    def test_close_response_must_confirm_completion(self):
        with mock.patch.object(issue_bridge, '_github', side_effect=[
            {'number': 25, 'state': 'open'}, {'number': 25, 'state': 'open'},
        ]):
            with self.assertRaises(RuntimeError):
                issue_bridge.resolve_issue(self.db, 60)

    async def sync(self, *, product='tanuki', parent=20, guild=70,
                   applied=(101,), available=((101, '解決済み'),), concurrent=False,
                   initial_closed=False):
        client = discord_bridge.InquiryDiscordClient()
        thread = mock.Mock(spec=discord.Thread)
        thread.id, thread.parent_id, thread.guild = 60, parent, SimpleNamespace(id=guild)
        thread.applied_tags = [SimpleNamespace(id=value) for value in applied]
        forum = mock.Mock(spec=discord.ForumChannel)
        forum.guild = SimpleNamespace(id=guild)
        forum.available_tags = [SimpleNamespace(id=id_, name=name) for id_, name in available]
        closed = initial_closed

        def github(method, repo, endpoint, payload=None):
            nonlocal closed
            if method == 'PATCH':
                closed = payload['state'] == 'closed'
            return {'number': 25, 'state': 'closed' if closed else 'open',
                    'state_reason': 'completed' if closed else None}

        async def fetch(id_):
            return thread if id_ == 60 else forum

        try:
            with mock.patch.object(client, 'fetch_channel', side_effect=fetch) as fetch_mock, \
                    mock.patch.object(issue_bridge, '_github', side_effect=github) as api:
                if concurrent:
                    await asyncio.gather(client._sync_resolution(60), client._sync_resolution(60))
                else:
                    await client._sync_resolution(60)
                return api.call_args_list, fetch_mock.call_args_list
        finally:
            await client.close()

    def test_all_existing_mapping_origins_and_products(self):
        for product, parent in [('tanuki', 20), ('net', 21), ('addon', 22)]:
            for origin in ['app-report', 'discord:60', f'github:{product}#25']:
                with self.subTest(product=product, origin=origin):
                    self.link(product, origin)
                    calls, _ = asyncio.run(self.sync(product=product, parent=parent))
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(calls[-1].args[1], issue_bridge.repository_for(product))

    def test_only_exact_name_and_matching_applied_tag_id(self):
        for options in [dict(applied=()), dict(applied=(102,)),
                        dict(available=()), dict(available=((101, '未解決'),)),
                        dict(available=((101, '解決済み（仮）'),))]:
            with self.subTest(options=options):
                calls, _ = asyncio.run(self.sync(**options))
                self.assertEqual(calls, [])

    def test_other_forum_product_guild_and_repository_do_not_close(self):
        for options in [dict(parent=999), dict(parent=21), dict(guild=999)]:
            with self.subTest(options=options):
                calls, _ = asyncio.run(self.sync(**options))
                self.assertEqual(calls, [])
        with mock.patch.dict('os.environ', {'INQUIRY_GITHUB_REPO_TANUKI': 'someone/else'}):
            self.assertEqual(asyncio.run(self.sync())[0], [])

    def test_event_and_maintenance_concurrency_only_patch_once(self):
        calls, _ = asyncio.run(self.sync(concurrent=True))
        self.assertEqual([call.args[0] for call in calls], ['GET', 'PATCH', 'GET'])

    def test_current_tags_fetched_instead_of_cached_gateway_state(self):
        calls, fetches = asyncio.run(self.sync(applied=()))
        self.assertEqual(calls, [])
        self.assertEqual(fetches, [mock.call(60), mock.call(20)])

    def test_raw_updates_include_uncached_archived_threads(self):
        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            try:
                payload = SimpleNamespace(parent_id=20, thread_id=60, thread=None,
                                          data={'applied_tags': ['101']})
                with mock.patch.object(client, '_sync_resolution', new=mock.AsyncMock()) as sync:
                    await client.on_raw_thread_update(payload)
                    sync.assert_awaited_once_with(60)
            finally:
                await client.close()
        asyncio.run(exercise())

    def test_raw_updates_ignore_unrelated_or_missing_tags(self):
        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            try:
                with mock.patch.object(client, '_sync_resolution', new=mock.AsyncMock()) as sync:
                    for parent, data in [(999, {'applied_tags': ['101']}), (20, {})]:
                        await client.on_raw_thread_update(SimpleNamespace(
                            parent_id=parent, thread_id=60, data=data))
                    sync.assert_not_awaited()
            finally:
                await client.close()
        asyncio.run(exercise())

    def test_raw_empty_tags_trigger_removal_sync(self):
        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            try:
                with mock.patch.object(client, '_sync_resolution', new=mock.AsyncMock()) as sync:
                    await client.on_raw_thread_update(SimpleNamespace(
                        parent_id=20, thread_id=60, data={'applied_tags': []}))
                    sync.assert_awaited_once_with(60)
            finally:
                await client.close()
        asyncio.run(exercise())

    def state_api(self, initial='open'):
        current = {'number': 25, 'state': initial,
                   'state_reason': 'completed' if initial == 'closed' else None}

        def api(method, repo, endpoint, payload=None):
            self.assertEqual(repo, 'kuretoshi/TanukiBCL')
            self.assertEqual(endpoint, '/issues/25')
            if method == 'PATCH':
                current.update(payload)
            return current.copy()
        return current, mock.Mock(side_effect=api)

    def remembered(self):
        with closing(issue_bridge.connect(self.db)) as db:
            return db.execute('SELECT * FROM inquiry_discord_resolution WHERE thread_id=?',
                              ('60',)).fetchone()

    def test_tag_close_remove_reopen_and_reattach(self):
        current, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, True), 'closed')
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, False), 'open')
            self.assertEqual(self.remembered()['resolved'], 0)
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, True), 'closed')
        patches = [call.args[3] for call in api.call_args_list if call.args[0] == 'PATCH']
        self.assertEqual(patches, [
            {'state': 'closed', 'state_reason': 'completed'},
            {'state': 'open', 'state_reason': 'reopened'},
            {'state': 'closed', 'state_reason': 'completed'},
        ])

    def test_untagged_manual_close_has_no_history_and_is_not_reopened(self):
        with mock.patch.object(issue_bridge, '_github') as api:
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 101, False))
            api.assert_not_called()
        self.assertIsNone(self.remembered())

    def test_removal_after_restart_reads_persisted_history(self):
        _, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
            issue_bridge.initialize(self.db)  # Existing state survives restart/migration.
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, False), 'open')

    def test_failed_reopen_retains_history_and_retries(self):
        _, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
        with mock.patch.object(issue_bridge, '_github', side_effect=RuntimeError('503')):
            with self.assertRaises(RuntimeError):
                issue_bridge.sync_discord_resolution(self.db, 60, 101, False)
        self.assertEqual(self.remembered()['resolved'], 1)
        with mock.patch.object(issue_bridge, '_github', api):
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, False), 'open')

    def test_already_open_removal_clears_history_without_patch(self):
        current, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
            current['state'] = 'open'
            api.reset_mock()
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 101, False))
            self.assertEqual(self.remembered()['resolved'], 0)
            api.assert_called_once_with('GET', 'kuretoshi/TanukiBCL', '/issues/25')
            current['state'] = 'closed'  # Later manual closure without a new tag.
            api.reset_mock()
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 101, False))
            api.assert_not_called()

    def test_replacement_tag_and_changed_mapping_do_not_reopen(self):
        _, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
        with mock.patch.object(issue_bridge, '_github') as untouched:
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 102, False))
            with closing(issue_bridge.connect(self.db)) as db, db:
                db.execute('UPDATE inquiry_issues SET issue_number=26 WHERE thread_id=?', ('60',))
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 101, False))
            untouched.assert_not_called()

    def test_already_closed_tag_is_remembered_for_subsequent_removal(self):
        _, api = self.state_api('closed')
        with mock.patch.object(issue_bridge, '_github', api):
            self.assertIsNone(issue_bridge.sync_discord_resolution(self.db, 60, 101, True))
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, False), 'open')

    def test_close_intent_survives_ambiguous_success_and_later_removal(self):
        current, api = self.state_api()

        def failed_close(method, repo, endpoint, payload=None):
            result = api(method, repo, endpoint, payload)
            if method == 'PATCH':
                raise RuntimeError('Connection lost after GitHub accepted close')
            return result

        with mock.patch.object(issue_bridge, '_github', side_effect=failed_close):
            with self.assertRaises(RuntimeError):
                issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
        self.assertEqual(current['state'], 'closed')
        self.assertEqual(self.remembered()['resolved'], 1)
        with mock.patch.object(issue_bridge, '_github', api):
            self.assertEqual(issue_bridge.sync_discord_resolution(self.db, 60, 101, False), 'open')

    def test_removed_tag_definition_does_not_trigger_reopen(self):
        _, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
        calls, _ = asyncio.run(self.sync(applied=(), available=()))
        self.assertEqual(calls, [])
        self.assertEqual(self.remembered()['resolved'], 1)

    def test_client_reopens_with_empty_tags_after_restart(self):
        _, api = self.state_api()
        with mock.patch.object(issue_bridge, '_github', api):
            issue_bridge.sync_discord_resolution(self.db, 60, 101, True)
        calls, _ = asyncio.run(self.sync(applied=(), initial_closed=True))
        self.assertEqual(calls[-1], mock.call('PATCH', 'kuretoshi/TanukiBCL', '/issues/25',
                                           {'state': 'open', 'state_reason': 'reopened'}))
        self.assertEqual(self.remembered()['resolved'], 0)

    def test_reconcile_retries_resolution_even_when_history_unavailable(self):
        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            try:
                with mock.patch.object(client, '_sync_resolution', new=mock.AsyncMock()) as sync, \
                        mock.patch.object(client, '_thread', new=mock.AsyncMock(return_value=None)):
                    row = issue_bridge.get_by_thread(self.db, 60)
                    await client._reconcile(row)
                    sync.assert_awaited_once_with('60')
            finally:
                await client.close()
        asyncio.run(exercise())

    def test_resolution_failure_does_not_block_existing_comment_mirroring(self):
        async def exercise():
            client = discord_bridge.InquiryDiscordClient()
            try:
                with mock.patch.object(client, '_sync_resolution', new=mock.AsyncMock(
                        side_effect=RuntimeError('503'))), \
                        mock.patch.object(client, '_thread', new=mock.AsyncMock(return_value=None)) as thread, \
                        self.assertLogs(discord_bridge.LOG, level='ERROR'):
                    await client._reconcile(issue_bridge.get_by_thread(self.db, 60))
                    thread.assert_awaited_once()
            finally:
                await client.close()
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
