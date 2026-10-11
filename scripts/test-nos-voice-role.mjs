import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createSocket } from 'node:dgram';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-voice-role-'));
const output = join(directory, 'sender.mjs');
await build({
	entryPoints: ['src/main/nosVoiceRoleBridge.ts'],
	outfile: output,
	bundle: true,
	platform: 'node',
	format: 'esm',
});
const { NosVoiceRoleSender, validVoiceRoleDescriptor } = await import(pathToFileURL(output));
const socket = createSocket('udp4');
const received = [];
socket.on('message', (bytes) => received.push(bytes.toString().split('|')));
await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
const descriptorPath = join(directory, 'voice-role.json');
const descriptor = {
	protocol: 1,
	role: 'tanukiMegaphone',
	pid: 123,
	playerId: 7,
	port: socket.address().port,
	token: 'a'.repeat(32),
};
const state = { mod: 'NoS', gameState: 1, players: [{ id: 7, isLocal: true, isDead: false, disconnected: false }] };
const sender = new NosVoiceRoleSender(descriptorPath);
try {
	assert.equal(validVoiceRoleDescriptor(descriptor), true);
	for (const change of [
		{ protocol: 2 },
		{ port: 65536 },
		{ pid: -1 },
		{ playerId: 0.5 },
		{ token: 'bad' },
		{ role: 'unknown' },
	])
		assert.equal(validVoiceRoleDescriptor({ ...descriptor, ...change }), false);
	await writeFile(descriptorPath, JSON.stringify(descriptor));
	sender.send(0.5, true, 123, state);
	await delay(50);
	assert.equal(received.length, 1, 'matched process/player receives microphone sample');
	assert.deepEqual(
		[received[0][0], received[0][1], received[0][4], received[0][5]],
		['TBCL1', descriptor.token, '0.5', '1']
	);
	const firstSequence = Number(received[0][2]);
	sender.send(0.5, false, 123, state);
	await delay(50);
	assert.equal(received[1][5], '0', 'mute state sent explicitly');
	assert.ok(Number(received[1][2]) > firstSequence);
	for (const [rms, active, pid, game] of [
		[NaN, true, 123, state],
		[2, true, 123, state],
		[0.5, 'yes', 123, state],
		[0.5, true, 999, state],
		[0.5, true, 123, { ...state, mod: 'NONE' }],
		[0.5, true, 123, { ...state, gameState: 2 }],
		[0.5, true, 123, { ...state, players: [{ ...state.players[0], id: 8 }] }],
		[0.5, true, 123, { ...state, players: [{ ...state.players[0], isDead: true }] }],
	])
		sender.send(rms, active, pid, game);
	await delay(60);
	assert.equal(received.length, 2, 'wrong identities, inactive games and invalid samples never send');
	sender.close();
	await delay(10);
	const restarted = new NosVoiceRoleSender(descriptorPath);
	restarted.send(0.5, true, 123, state);
	await delay(50);
	restarted.close();
	assert.ok(
		Number(received[2][2]) > Number(received[1][2]),
		'BCL restart resumes monotonically within the same role session'
	);
	await writeFile(descriptorPath, JSON.stringify({ ...descriptor, token: 'b'.repeat(32) }));
	await delay(260);
	sender.send(0.2, true, 123, state);
	await delay(50);
	assert.equal(received[3][1], 'b'.repeat(32), 'new role session refreshes endpoint descriptor');
	await rm(descriptorPath);
	await delay(260);
	sender.send(0.2, true, 123, state);
	await delay(50);
	assert.equal(received.length, 4, 'removed role endpoint stops transmission');
	await writeFile(descriptorPath, JSON.stringify({ ...descriptor, role: 'tanukiTalkative' }));
	assert.equal(validVoiceRoleDescriptor({ ...descriptor, role: 'tanukiTalkative' }), true);
	const talkative = new NosVoiceRoleSender(descriptorPath);
	try {
		talkative.send(0, true, 123, { ...state, gameState: 2 });
		await delay(50);
		assert.equal(received.length, 5, 'Talkative receives silent heartbeats during meetings');
		talkative.send(0.2, true, 123, { ...state, gameState: 2 });
		await delay(50);
		assert.equal(received[5][4], '0.2', 'meeting speech reaches Talkative');
		talkative.send(0.2, true, 123, { ...state, gameState: 0 });
		await delay(50);
		assert.equal(received.length, 6, 'Talkative still rejects menu/lobby state');
	} finally {
		talkative.close();
	}
    await writeFile(descriptorPath, JSON.stringify({ ...descriptor, role: 'tanukiBclBibiri' }));
    const bibiri = new NosVoiceRoleSender(descriptorPath);
    try {
        const before = received.length;
        bibiri.send(.5, true, 123, { ...state, gameState: 2 });
        await delay(50);
        assert.equal(received.length, before + 1, 'Bibiri receives meeting voice for its host-controlled setting');
    } finally { bibiri.close(); }
    await writeFile(descriptorPath, JSON.stringify({ ...descriptor, role: 'tanukiVoiceRoles' }));
    const shared = new NosVoiceRoleSender(descriptorPath);
    try {
        const before = received.length;
        shared.send(.5, true, 123, state);
        shared.send(.5, true, 123, { ...state, gameState: 2 });
        await delay(50);
        assert.equal(received.length, before + 2, 'shared modifier transport receives task and meeting samples');
    } finally { shared.close(); }
    await writeFile(descriptorPath, JSON.stringify({ ...descriptor, role: 'tanukiMicTest' }));
    const micTest = new NosVoiceRoleSender(descriptorPath);
    try {
        const before = received.length;
        micTest.send(.2, true, 123, { ...state, gameState: 0 });
        await delay(50);
        assert.equal(received.length, before + 1, 'microphone test receives real samples in lobby');
        micTest.send(.2, true, 123, state);
        micTest.send(.2, true, 123, { ...state, gameState: 2 });
        micTest.send(.2, true, 123, { ...state, gameState: 3 });
        await delay(50);
        assert.equal(received.length, before + 1, 'microphone test never sends in tasks, meetings or menu');
    } finally { micTest.close(); }
    const discovery = createSocket('udp4');
    await new Promise(resolve => discovery.bind(0, '127.0.0.1', resolve));
    let validReply = false;
    discovery.on('message', (bytes, remote) => {
        const request = bytes.toString().split('|');
        const nonce = validReply ? request[2] : 'f'.repeat(32);
        discovery.send(`TBCLD1|${nonce}|${JSON.stringify(descriptor)}`, remote.port, remote.address);
    });
    const direct = new NosVoiceRoleSender(descriptorPath, discovery.address().port);
    try {
        await writeFile(descriptorPath, JSON.stringify({ ...descriptor, pid: 999 }));
        const before = received.length;
        direct.send(.3, true, 123, state);
        await delay(80);
        direct.send(.3, true, 123, state);
        await delay(80);
        assert.equal(received.length, before, 'wrong discovery nonce cannot override stale descriptor');
        validReply = true;
        await delay(300);
        direct.send(.3, true, 123, state);
        await delay(80);
        direct.send(.3, true, 123, state);
        await delay(80);
        assert.equal(received.length, before + 1, 'direct discovery restores UDP despite stale file PID');
        assert.equal(received.at(-1)[4], '0.3');
    } finally { direct.close(); discovery.close(); }
	console.log('NoS voice role sender and direct discovery checks passed.');
} finally {
	sender.close();
	socket.close();
	await rm(directory, { recursive: true, force: true });
}
