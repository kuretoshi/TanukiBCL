import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'tanuki-neural-bridge-'));
try {
	const sent = [];
	let resolveWord;
	let modelStarts = 0;
	globalThis.__localMock = {
		status: { enabled: true, available: true, error: '' },
		profile: null,
		sent,
		transcribe: async () => {
			modelStarts++;
			return new Promise((r) => (resolveWord = r));
		},
	};
	const result = await build({
		entryPoints: ['src/main/heroSpeechBridge.ts'],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		plugins: [
			{
				name: 'isolate',
				setup(b) {
					b.onResolve({ filter: /\/localStoneSpeech$|\.\/localStoneSpeech$/ }, () => ({
						path: 'local',
						namespace: 'test',
					}));
					b.onResolve({ filter: /\/nosAddonLink$|\.\/nosAddonLink$/ }, () => ({ path: 'link', namespace: 'test' }));
					b.onLoad({ filter: /.*/, namespace: 'test' }, (arg) => ({
						contents:
							arg.path === 'local'
								? 'export const localSpeechStatus=()=>globalThis.__localMock.status;export const localStoneWorker={idle(){},close(){},transcribe:(...args)=>globalThis.__localMock.transcribe(...args)};'
								: 'export const nosAddonLink={current:()=>globalThis.__localMock.profile,endpoint:()=>12345,sendCommand:(pid,kind,fields)=>{globalThis.__localMock.sent.push({pid,kind,fields});return true;}};',
					}));
				},
			},
		],
	});
	const file = join(dir, 'bridge.mjs');
	await writeFile(file, result.outputFiles[0].contents);
	const { registerHeroSpeechBridge, validHeroSpeechDescriptor } = await import(pathToFileURL(file));
	const handlers = new Map(),
		ipc = { handle: (n, f) => handlers.set(n, f), on: (n, f) => handlers.set(n, f) };
	const context = {
		pid: 99,
		state: {
			mod: 'NoS',
			nosAddonIds: ['tanuki.bcl.roles'],
			gameState: 2,
			isHost: false,
			players: [
				{ id: 1, isLocal: true },
				{ id: 2, isLocal: false },
			],
		},
	};
	const close = registerHeroSpeechBridge(
		ipc,
		() => context,
		(id) => id === 42
	);
	const session = 'a'.repeat(32),
		now = Date.now();
	const job = {
		playerId: 1,
		kind: 'stone',
		request: 1,
		expires: now + 19000,
		recordUntil: now - 1000,
		recordStarted: now - 6000,
		recognizer: 'local-neural',
		words: [],
		maxCharacters: 8,
	};
	globalThis.__localMock.profile = { session, unixMs: now, channels: { speech: [job] } };
	assert(
		validHeroSpeechDescriptor(
			{ protocol: 2, pid: 99, port: 12345, token: session, updated: now, players: [job] },
			99,
			now
		)
	);
	assert(
		!validHeroSpeechDescriptor(
			{ protocol: 2, pid: 99, port: 12345, token: session, updated: now, players: [{ ...job, kind: 'hero' }] },
			99,
			now
		)
	);
	const wav = Buffer.alloc(3244);
	wav.write('RIFF');
	wav.writeUInt32LE(3236, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(16000, 24);
	wav.writeUInt32LE(32000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(3200, 40);
	const send = handlers.get('VOICE_STONE_LOCAL_TRANSCRIBE'),
		event = { sender: { id: 42 } };
	context.state.nosAddonIds = [];
	for (let i = 0; i < 100; i++) {
		assert.equal(handlers.get('NOS_HERO_SPEECH_STATE')(event), null);
		assert.equal(await send(event, session, 1, 1, wav), false);
	}
	assert.equal(modelStarts, 0, 'Stale descriptors cannot load a model without detected Tanuki addon');
	context.state.nosAddonIds = ['tanuki.bcl.roles'];
	assert.equal(await send({ sender: { id: 2 } }, session, 1, 1, wav), false);
	assert.equal(await send(event, session, 2, 1, wav), false);
	assert.equal(await send(event, 'b'.repeat(32), 1, 1, wav), false);
	const pending = send(event, session, 1, 1, wav);
	await new Promise((r) => setImmediate(r));
	resolveWord('インポスター');
	assert.equal(await pending, true);
	assert.equal(sent.at(-1).fields.word, 'インポスター');
	assert.equal(await send(event, session, 1, 1, wav), false, 'Duplicate local request');
	job.request = 2;
	const stale = send(event, session, 1, 2, wav);
	await new Promise((r) => setImmediate(r));
	globalThis.__localMock.profile.channels.speech = [];
	resolveWord('猫');
	assert.equal(await stale, false, 'Meeting/role removal drops old result');
	close();
	console.log(
		'PASS local neural bridge: mode validation, owner/IPC/session/request checks, Japanese placement and late result rejection'
	);
} finally {
	delete globalThis.__localMock;
	await rm(dir, { recursive: true, force: true });
}
