import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
	entryPoints: ['src/main/playerBans.ts'],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
});
const { checkPlayerBan, managePlayerBans } = await import(
	'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64')
);
const calls = [];
let response = { banned: false };
let status = 200;
const request = async (url, options) => {
	calls.push({ url, ...options, payload: JSON.parse(options.body) });
	return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } });
};

const observed = [
	{ playerUid: 'remote', playerName: 'Remote', friendCode: 'CODE#1', publicIp: '8.8.8.8', ip: '1.1.1.1' },
	null,
	{ playerUid: 'invalid', playerName: 3 },
];
assert.equal(await checkPlayerBan('self', 'Self', 'CODE#0', observed, request), 'clear');
assert.deepEqual(calls[0].payload, {
	playerUid: 'self',
	playerName: 'Self',
	friendCode: 'CODE#0',
	observedPlayers: [{ playerUid: 'remote', playerName: 'Remote', friendCode: 'CODE#1' }],
});
assert.equal(calls[0].redirect, 'error');
assert.ok(calls[0].signal instanceof AbortSignal);
response = { banned: true };
assert.equal(await checkPlayerBan('other-self', 'Self', '', [], request), 'banned');
response = { error: 'Unavailable' };
status = 503;
assert.equal(await checkPlayerBan('self', 'Self', '', [], request), 'unavailable');
const beforeInvalid = calls.length;
assert.equal(await checkPlayerBan('', 'Self', '', [], request), 'unavailable');
assert.deepEqual(await managePlayerBans({ password: '', action: 'add-ip' }, request), {
	error: '管理者パスワードを入力してください。',
});
assert.ok((await managePlayerBans({ password: 'admin', action: 'unknown' }, request)).error);
assert.equal(calls.length, beforeInvalid, 'Invalid requests never contact the server');

const ban = {
	uid_digest: 'a'.repeat(64),
	player_uid: 'self',
	display_name: 'Self',
	friend_code: '',
	ban_type: 'ip',
	public_ip: '2606:4700:4700::1111',
	reason: 'test',
	created_at: 1,
};
const history = { uid_digest: ban.uid_digest, public_ip: ban.public_ip, uid_banned: 0, ip_banned: 1, is_banned: 1 };
status = 200;
response = { bans: [ban], pending: [], history: [history], historyTotal: 1, ipBansAvailable: true };
for (const action of ['add-ip', 'add-history-ip', 'remove-ip']) {
	const payload = { password: 'admin', action, playerUid: 'self', uidDigest: ban.uid_digest, publicIp: ban.public_ip };
	const result = await managePlayerBans(payload, request);
	assert.equal(result.ipBansAvailable, true);
	assert.deepEqual(result.bans, [ban]);
	assert.deepEqual(result.history, [history]);
	assert.deepEqual(calls.at(-1).payload, payload, 'Explicit IP action and exact target are preserved');
}
response = { bans: [], pending: [] };
const legacy = await managePlayerBans({ password: 'admin', action: 'list' }, request);
assert.equal(legacy.ipBansAvailable, false, 'Old servers must not enable the IP selector');
assert.equal(legacy.historyAvailable, false);
response = { error: 'Invalid action.' };
status = 400;
const beforeLegacyIp = calls.length;
assert.deepEqual(await managePlayerBans({ password: 'admin', action: 'add-ip', playerUid: 'self' }, request), {
	error: 'Invalid action.',
});
assert.equal(calls.length, beforeLegacyIp + 1, 'An unsupported IP action must never retry as a UID ban');
assert.equal(calls.at(-1).payload.action, 'add-ip');
console.log(
	'PASS player BAN transport: caller/roster IP fields never sent, explicit IP operations, administrator validation, capability fallback and no unsafe UID retry'
);
