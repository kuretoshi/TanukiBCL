import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'tanuki-local-capture-'));
const oldNow = Date.now;
let now = 10000,
	speech;
Date.now = () => now;
try {
	let descriptor = {
		pid: 99,
		session: 'a'.repeat(32),
		localNeuralConfigured: true,
		players: [1, 2, 3].map((playerId) => ({
			playerId,
			kind: 'stone',
			request: 0,
			expires: 0,
			recordStarted: 0,
			recordUntil: 0,
			recognizer: 'local',
			words: [],
			maxCharacters: 8,
		})),
	};
	const sent = [],
		calls = [],
		nodes = [];
	globalThis.__stoneIpc = {
		invoke: async (name, ...args) => {
			if (name === 'NOS_HERO_SPEECH_STATE') return descriptor;
			calls.push([name, ...args]);
			return true;
		},
		send: (...args) => sent.push(args),
	};
	const built = await build({
		entryPoints: ['src/renderer/voice/heroSpeech.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		plugins: [
			{
				name: 'ipc',
				setup(b) {
					b.onResolve({ filter: /lib\/electron-bridge$/ }, () => ({ path: 'ipc', namespace: 'mock' }));
					b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
						contents: 'export const ipcRenderer=globalThis.__stoneIpc;',
					}));
				},
			},
		],
	});
	const path = join(dir, 'capture.mjs');
	await writeFile(path, built.outputFiles[0].contents);
	const { HeroSpeech } = await import(pathToFileURL(path));
	const source = { connect() {}, disconnect() {} },
		context = {
			sampleRate: 48000,
			destination: {},
			createScriptProcessor() {
				const n = { connect() {}, disconnect() {}, onaudioprocess: null };
				nodes.push(n);
				return n;
			},
			createGain() {
				return { gain: { value: 1 }, connect() {}, disconnect() {} };
			},
		};
	const game = {
		mod: 'NoS',
		nosAddonIds: ['tanuki.bcl.roles'],
		lobbyCode: 'TEST',
		gameState: 2,
		isHost: false,
		players: [
			{ id: 1, isLocal: true },
			{ id: 2, isLocal: false },
			{ id: 3, isLocal: false },
		],
	};
	speech = new HeroSpeech(context);
	speech.setContext(game);
	speech.setInput('local', source, 1, () => true);
	speech.setInput('pc', source, 2, () => true);
	speech.setInput('web', source, 3, () => true);
	speech.setPeerPlatform('pc', 'desktop');
	speech.setPeerPlatform('web', 'web');
	await speech.poll();
	assert.equal(nodes.length, 1, 'Guest warms only its own input');
	assert(sent.at(-1)[3].includes(1));
	nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(48000).fill(0.1) } });
	descriptor.players[0] = {
		...descriptor.players[0],
		request: 1,
		recognizer: 'local-neural',
		recordStarted: 9500,
		recordUntil: 10500,
		expires: 30500,
	};
	await speech.poll();
	now = 10050;
	nodes[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2400).fill(0.1) } });
	now = 10600;
	await speech.poll();
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], 'VOICE_STONE_LOCAL_TRANSCRIBE');
	assert.equal(calls[0][4].length, 17644, 'First syllable retained, pre-ability audio excluded');
	await speech.poll();
	assert.equal(calls.length, 1);
	speech.setContext({ ...game, isHost: true });
	await speech.poll();
	assert.equal(nodes.length, 2, 'Host adds web input only, never a remote PC');
	assert(sent.at(-1)[3].includes(3));
	assert(!sent.at(-1)[3].includes(2));
	descriptor = { ...descriptor, players: [] };
	await speech.poll();
	assert.equal(speech.recordings.size, 0, 'Meeting or role removal tears down capture');
	console.log(
		'PASS shared local capture: owner/web routing, no Vosk dependency, bounded recording window, first syllable buffer, duplicate suppression and cancellation'
	);
} finally {
	speech?.dispose();
	Date.now = oldNow;
	delete globalThis.__stoneIpc;
	await rm(dir, { recursive: true, force: true });
}
