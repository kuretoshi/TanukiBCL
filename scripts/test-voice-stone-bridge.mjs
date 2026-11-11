import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-stone-bridge-'));
const previousLocalAppData = process.env.LOCALAPPDATA;
const receiver = createSocket('udp4');
try {
	const compiled = await build({
		entryPoints: ['src/main/heroSpeechBridge.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	});
	const path = join(directory, 'bridge.mjs');
	await writeFile(path, compiled.outputFiles[0].contents);
	const { registerHeroSpeechBridge } = await import(pathToFileURL(path));
	const states = await build({
		entryPoints: ['src/common/AmongUsState.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	});
	const statePath = join(directory, 'states.mjs');
	await writeFile(statePath, states.outputFiles[0].contents);
	const { GameState } = await import(pathToFileURL(statePath));
	receiver.bind(0, '127.0.0.1');
	await once(receiver, 'listening');
	const packets = [];
	receiver.on('message', (bytes) => packets.push(bytes.toString('ascii')));
	process.env.LOCALAPPDATA = directory;
	const source = join(directory, 'TanukiBCL', 'NoS');
	await mkdir(source, { recursive: true });
	const token = 'a'.repeat(32);
	const job = { playerId: 1, kind: 'stone', request: 7, expires: Date.now() + 5000, words: [], maxCharacters: 6 };
	await writeFile(
		join(source, 'hero-speech-99.json'),
		JSON.stringify({
			protocol: 2,
			pid: 99,
			port: receiver.address().port,
			token,
			updated: Date.now(),
			players: [job, { ...job, playerId: 3 }],
		})
	);
	const handlers = new Map();
	const ipc = {
		handle: (name, callback) => handlers.set(name, callback),
		on: (name, callback) => handlers.set(name, callback),
	};
	registerHeroSpeechBridge(
		ipc,
		() => ({
			pid: 99,
			state: { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: GameState.TASKS, isHost: false, players: [{ id: 1, isLocal: true }] },
		}),
		(id) => id === 42
	);
	const accept = handlers.get('NOS_HERO_SPEECH_WORD');
	const event = { sender: { id: 42 } };
	accept(event, token, 1, 7, 'stone', '猫 犬');
	accept(event, token, 1, 7, 'stone', '<猫>');
	accept(event, token, 1, 7, 'stone', '1234567');
	accept(event, token, 3, 7, 'stone', '猫');
	accept(event, 'b'.repeat(32), 1, 7, 'stone', '猫');
	accept(event, token, 1, 8, 'stone', '猫');
	accept({ sender: { id: 1 } }, token, 1, 7, 'stone', '猫');
	const delivered = once(receiver, 'message');
	accept(event, token, 1, 7, 'stone', 'インポスター');
	await delivered;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(
		packets.length,
		1,
		'invalid words, foreign players, sessions, requests and renderers cannot send packets'
	);
	const fields = packets[0].split('|');
	assert.equal(fields[6], 'stone');
	assert.equal(
		Buffer.from(fields[7], 'base64').toString('utf8'),
		'インポスター',
		'Japanese word crosses ASCII UDP intact'
	);
	console.log('PASS voice stone bridge: word bounds, session/request/sender/routing guards and UTF-8 transport');
} finally {
	receiver.close();
	if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = previousLocalAppData;
	await rm(directory, { recursive: true, force: true });
}
