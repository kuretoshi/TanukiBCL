"""Mirror replies in linked Discord forum threads into GitHub Issues."""

import asyncio
import logging
import os

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

    async def on_ready(self):
        LOG.info('Discord bridge connected as %s', self.user)
        if self._maintenance_task is None or self._maintenance_task.done():
            self._maintenance_task = asyncio.create_task(self._maintain())

    async def _maintain(self):
        while not self.is_closed():
            try:
                await asyncio.to_thread(inquiry.mirror_pending, DATABASE)
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

    async def _reconcile(self, row):
        try:
            channel = await self._thread(row['thread_id'])
            if channel is None:
                return
            await asyncio.to_thread(issue_bridge.rename_issue, DATABASE, channel.id, channel.name)
            seen = set()
            async for message in channel.history(limit=None, oldest_first=True):
                if message.id == int(row['initial_message_id']) or message.author.bot or message.webhook_id:
                    continue
                seen.add(str(message.id))
                await self._sync_message(message)
            prior = await asyncio.to_thread(issue_bridge.comment_message_ids, DATABASE, channel.id)
            for message_id in prior - seen:
                await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, channel.id,
                                        message_id, '', '', 0, True)
        except (discord.Forbidden, discord.NotFound):
            LOG.warning('Cannot read Discord thread %s', row['thread_id'])
        except Exception:
            LOG.exception('Failed to reconcile Discord thread %s', row['thread_id'])

    async def _sync_message(self, message):
        if message.author.bot or message.webhook_id:
            return
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
        await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, message.channel.id,
                                message.id, message.author.display_name,
                                content, attachments)

    async def on_message(self, message):
        if not isinstance(message.channel, discord.Thread):
            return
        if await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, message.channel.id):
            try:
                await self._sync_message(message)
            except Exception:
                LOG.exception('Failed to mirror Discord message %s', message.id)

    async def on_raw_message_edit(self, payload):
        if not await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, payload.channel_id):
            return
        try:
            thread = await self._thread(payload.channel_id)
            if thread:
                await self._sync_message(await thread.fetch_message(payload.message_id))
        except discord.NotFound:
            return
        except Exception:
            LOG.exception('Failed to mirror Discord edit %s', payload.message_id)

    async def on_raw_message_delete(self, payload):
        if not await asyncio.to_thread(issue_bridge.get_by_thread, DATABASE, payload.channel_id):
            return
        try:
            await asyncio.to_thread(issue_bridge.sync_comment, DATABASE, payload.channel_id,
                                    payload.message_id, '', '', 0, True)
        except Exception:
            LOG.exception('Failed to mirror Discord deletion %s', payload.message_id)

    async def on_thread_update(self, before, after):
        if before.name == after.name:
            return
        try:
            await asyncio.to_thread(issue_bridge.rename_issue, DATABASE, after.id, after.name)
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
