"""Mirror replies in linked Discord forum threads into GitHub Issues."""

import asyncio
import logging
import os
import time

import discord

import inquiry
import issue_bridge


LOG = logging.getLogger(__name__)
DATABASE = os.environ.get('DEBUG_AUTH_DB', '/var/lib/tanuki-debug-auth/auth.sqlite3')


class InquiryDiscordClient(discord.Client):
    def __init__(self):
        intents = discord.Intents(guilds=True, messages=True, message_content=True)
        super().__init__(intents=intents)
        self._maintenance_task = None
        self.forums = {}
        self.source_since = {}
        for product in inquiry.PRODUCTS:
            configured_forum = os.environ.get(f'INQUIRY_DISCORD_FORUM_ID_{product.upper()}', '')
            if not configured_forum.isdecimal():
                continue
            forum_id = int(configured_forum)
            if forum_id in self.forums:
                raise RuntimeError('The same Discord forum cannot be assigned to multiple products.')
            self.forums[forum_id] = product
            self.source_since[forum_id] = issue_bridge.discord_source_since(DATABASE, forum_id)
        self._import_locks = {}

    async def on_ready(self):
        LOG.info('Discord bridge connected as %s', self.user)
        for product in inquiry.PRODUCTS:
            if product not in self.forums.values():
                LOG.warning('Direct Discord forum import is disabled for %s: forum ID is not configured', product)
        if self._maintenance_task is None or self._maintenance_task.done():
            self._maintenance_task = asyncio.create_task(self._maintain())

    async def _maintain(self):
        while not self.is_closed():
            try:
                await asyncio.to_thread(inquiry.mirror_pending, DATABASE)
                try:
                    await self._scan_new_threads()
                except Exception:
                    LOG.exception('Could not scan the inquiry forums')
                for row in await asyncio.to_thread(issue_bridge.list_linked, DATABASE):
                    await self._reconcile(row)
            except Exception:
                LOG.exception('Discord inquiry maintenance failed')
            await asyncio.sleep(300)

    async def _thread(self, thread_id):
        channel = self.get_channel(int(thread_id))
        if channel is None:
            channel = await self.fetch_channel(int(thread_id))
        return channel if isinstance(channel, discord.Thread) else None

    def _is_new_source_thread(self, thread):
        return (isinstance(thread, discord.Thread) and thread.parent_id in self.forums
                and thread.created_at is not None
                and thread.created_at.timestamp() >= self.source_since[thread.parent_id])

    def _tag_for_thread(self, thread):
        product = self.forums.get(thread.parent_id)
        route = inquiry.get_webhook(DATABASE, product) if product else None
        if route is not None:
            applied = {str(value) for value in thread.applied_tags}
            for tag in ('bug', 'request', 'question'):
                if route[f'{tag}_tag'] in applied:
                    return tag
        return 'question'

    async def _scan_new_threads(self):
        for forum_id, product in self.forums.items():
            try:
                await self._scan_forum(forum_id, product)
            except Exception:
                LOG.exception('Could not scan the %s inquiry forum', product)

    async def _scan_forum(self, forum_id, product):
        forum = self.get_channel(forum_id) or await self.fetch_channel(forum_id)
        if not isinstance(forum, discord.ForumChannel):
            raise RuntimeError(f'Configured {product} forum ID does not identify a forum channel.')
        scan_started_at = int(time.time())
        archive_since = await asyncio.to_thread(issue_bridge.discord_scan_since, DATABASE, forum_id)
        had_error = False
        for thread in await forum.guild.active_threads():
            if self._is_new_source_thread(thread):
                try:
                    await self._import_thread(thread)
                except Exception:
                    had_error = True
                    LOG.exception('Failed to import active Discord thread %s', thread.id)
        async for thread in forum.archived_threads(limit=None):
            if thread.archive_timestamp and thread.archive_timestamp.timestamp() < archive_since:
                break
            if self._is_new_source_thread(thread):
                try:
                    await self._import_thread(thread)
                except Exception:
                    had_error = True
                    LOG.exception('Failed to import archived Discord thread %s', thread.id)
        if not had_error:
            await asyncio.to_thread(issue_bridge.mark_discord_scan, DATABASE, forum_id,
                                    scan_started_at)

    async def _import_thread(self, thread):
        if not self._is_new_source_thread(thread):
            return None
        lock = self._import_locks.setdefault(thread.id, asyncio.Lock())
        async with lock:
            if await asyncio.to_thread(issue_bridge.is_discord_thread_ignored, DATABASE, thread.id):
                return None
            existing = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, thread.id)
            if existing is not None:
                return existing
            try:
                starter = await thread.fetch_message(thread.id)
            except discord.NotFound:
                return None
            if starter.author.bot or starter.webhook_id:
                return None
            product = self.forums[thread.parent_id]
            tag = await asyncio.to_thread(self._tag_for_thread, thread)
            content, attachments = await self._message_data(starter)
            thread_url = f'https://discord.com/channels/{thread.guild.id}/{thread.id}'
            body = issue_bridge.discord_issue_body(product, tag, starter.author.display_name, content,
                                                  attachments, thread_url)
            row = await asyncio.to_thread(issue_bridge.create_discord_issue, DATABASE,
                                          issue_bridge.repository_for(product), product, tag,
                                          thread.name[:100], body, thread.id, thread.guild.id,
                                          starter.id)
            LOG.info('Created Issue %s from Discord thread %s', row['issue_number'], thread.id)
            return row

    async def _reconcile(self, row):
        try:
            channel = await self._thread(row['thread_id'])
            if channel is None:
                return
            if not row['guild_id']:
                row = await asyncio.to_thread(issue_bridge.set_guild_id, DATABASE, channel.id, channel.guild.id)
            await asyncio.to_thread(issue_bridge.ensure_discord_link, DATABASE, row)
            direct = row['fingerprint'].startswith('discord:')
            tag = await asyncio.to_thread(self._tag_for_thread, channel) if direct else None
            await asyncio.to_thread(issue_bridge.rename_issue, DATABASE, channel.id, channel.name, tag)
            row = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, channel.id)
            seen = set()
            initial_seen = False
            async for message in channel.history(limit=None, oldest_first=True):
                if message.id == int(row['initial_message_id']):
                    initial_seen = True
                    if direct:
                        await self._sync_initial(message, row)
                    continue
                if message.author.bot or message.webhook_id:
                    continue
                seen.add(str(message.id))
                await self._sync_message(message)
            if direct and not initial_seen:
                await self._delete_initial(row)
            prior = await asyncio.to_thread(issue_bridge.comment_message_ids, DATABASE, channel.id)
            for message_id in prior - seen:
                await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, channel.id,
                                        message_id, '', '', 0, True)
        except (discord.Forbidden, discord.NotFound):
            LOG.warning('Cannot read Discord thread %s', row['thread_id'])
        except Exception:
            LOG.exception('Failed to reconcile Discord thread %s', row['thread_id'])

    async def _message_data(self, message):
        attachments = []
        content = message.content
        if len(message.attachments) > 10 or sum(item.size for item in message.attachments) > inquiry.ATTACHMENT_LIMIT:
            content += f'\n\n添付ファイルは容量制限のためDiscordで確認してください: {message.jump_url}'
        else:
            for item in message.attachments:
                try:
                    url = await asyncio.to_thread(issue_bridge.discord_attachment_url, DATABASE, item.id)
                    if url is None:
                        data = await item.read()
                        url = await asyncio.to_thread(issue_bridge.save_discord_attachment, DATABASE,
                                                      message.id, item.id, item.filename, data)
                    attachments.append((item.filename, url))
                except (discord.HTTPException, OSError):
                    content += f'\n\n添付ファイルを取得できませんでした: {message.jump_url}'
        return content, attachments

    async def _sync_initial(self, message, row):
        if message.author.bot or message.webhook_id:
            return
        content, attachments = await self._message_data(message)
        thread_url = f"https://discord.com/channels/{row['guild_id']}/{row['thread_id']}"
        body = issue_bridge.discord_issue_body(row['product'], row['tag'], message.author.display_name,
                                              content, attachments, thread_url)
        await asyncio.to_thread(issue_bridge.sync_discord_initial, DATABASE, row['thread_id'], body)

    async def _delete_initial(self, row):
        thread_url = f"https://discord.com/channels/{row['guild_id']}/{row['thread_id']}"
        body = issue_bridge.discord_issue_body(row['product'], row['tag'], '', '', [], thread_url,
                                               deleted=True)
        await asyncio.to_thread(issue_bridge.sync_discord_initial, DATABASE, row['thread_id'], body)

    async def _sync_message(self, message):
        if message.author.bot or message.webhook_id:
            return
        content, attachments = await self._message_data(message)
        await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, message.channel.id,
                                message.id, message.author.display_name,
                                content, attachments)

    async def on_message(self, message):
        if not isinstance(message.channel, discord.Thread):
            return
        row = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, message.channel.id)
        if row is None and self._is_new_source_thread(message.channel):
            try:
                row = await self._import_thread(message.channel)
            except Exception:
                LOG.exception('Failed to create Issue from Discord thread %s', message.channel.id)
        if row is not None:
            try:
                if (row['fingerprint'].startswith('discord:')
                        and message.id == int(row['initial_message_id'])):
                    await self._sync_initial(message, row)
                else:
                    await self._sync_message(message)
            except Exception:
                LOG.exception('Failed to mirror Discord message %s', message.id)

    async def on_thread_create(self, thread):
        if self._is_new_source_thread(thread):
            try:
                await self._import_thread(thread)
            except Exception:
                LOG.exception('Failed to create Issue from Discord thread %s', thread.id)

    async def on_raw_message_edit(self, payload):
        row = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, payload.channel_id)
        if row is None:
            return
        try:
            thread = await self._thread(payload.channel_id)
            if thread:
                message = await thread.fetch_message(payload.message_id)
                if (row['fingerprint'].startswith('discord:')
                        and message.id == int(row['initial_message_id'])):
                    await self._sync_initial(message, row)
                else:
                    await self._sync_message(message)
        except discord.NotFound:
            return
        except Exception:
            LOG.exception('Failed to mirror Discord edit %s', payload.message_id)

    async def on_raw_message_delete(self, payload):
        row = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, payload.channel_id)
        if row is None:
            return
        try:
            if (row['fingerprint'].startswith('discord:')
                    and payload.message_id == int(row['initial_message_id'])):
                await self._delete_initial(row)
            else:
                await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, payload.channel_id,
                                        payload.message_id, '', '', 0, True)
        except Exception:
            LOG.exception('Failed to mirror Discord deletion %s', payload.message_id)

    async def on_thread_update(self, before, after):
        if before.name == after.name and before.applied_tags == after.applied_tags:
            return
        try:
            row = await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, after.id)
            if row is None:
                return
            tag = await asyncio.to_thread(self._tag_for_thread, after) if row['fingerprint'].startswith('discord:') else None
            await asyncio.to_thread(issue_bridge.rename_issue, DATABASE, after.id, after.name, tag)
            if row['fingerprint'].startswith('discord:') and before.applied_tags != after.applied_tags:
                await self._reconcile(row)
        except Exception:
            LOG.exception('Failed to mirror Discord thread title %s', after.id)


def main():
    token = os.environ.get('INQUIRY_DISCORD_BOT_TOKEN')
    if not token:
        raise SystemExit('INQUIRY_DISCORD_BOT_TOKEN is required.')
    logging.basicConfig(level=logging.INFO)
    inquiry.initialize(DATABASE)
    InquiryDiscordClient().run(token, log_handler=None)


if __name__ == '__main__':
    main()
