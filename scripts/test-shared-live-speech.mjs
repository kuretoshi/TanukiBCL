import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'tanuki-live-speech-'));
const realNow = Date.now,
	realInterval = globalThis.setInterval,
	realClear = globalThis.clearInterval;
let now = 10000;
async function load(entry, name, plugins = []) {
	const b = await build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		define: { 'import.meta.env.DEV': 'false' },
		plugins,
	});
	const file = join(dir, name + '.mjs');
	await writeFile(file, b.outputFiles[0].contents);
	return import(pathToFileURL(file));
}
try {
	Date.now = () => now;
	const { LiveSpeechAudio } = await load('src/common/LiveSpeechAudio.ts', 'audio');
	const { StonePcm } = await load('src/common/VoiceStoneAudio.ts', 'wav');
	const voice = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.03) * 0.1);
	const a = new LiveSpeechAudio();
	for (let i = 0; i < 20; i++) a.append(new Float32Array(4800), 48000, 10000 + i * 100);
	assert.equal(a.take(12500), undefined, 'silence never submits');
	for (let i = 0; i < 12; i++) a.append(voice, 48000, 13000 + i * 100);
	assert(a.take(14200));
	assert.equal(a.take(14201), undefined);
	a.append(voice, 48000, 14200);
	assert(a.take(14650).length > 40000, 'overlap preserves a word crossing an intermediate boundary');
	assert.equal(a.take(14800), undefined, 'silence flush occurs only once');
	for (let i = 0; i < 300; i++) a.append(voice, 48000, 15000 + i * 100);
	assert(a.take(45000).length <= 44 + 8100 * 32, 'continuous speech has bounded memory');
	a.append(voice, 48000, 46000);
	a.reset();
	assert.equal(a.take(46500), undefined, 'muting/request changes discard PCM');
	const pcm = new StonePcm();
	pcm.append(voice, 48000);
	const wav = pcm.wav();
	const sent = [],
		handlers = new Map();
	let resolve,
		calls = 0,
		profile;
	globalThis.__live = {
		status: { enabled: true },
		get profile() {
			return profile;
		},
		sent,
		transcribeText: async () => {
			calls++;
			return new Promise((r) => (resolve = r));
		},
	};
	const mock = {
		name: 'native-mock',
		setup(b) {
			b.onResolve({ filter: /\.\/localStoneSpeech$/ }, () => ({ path: 'local', namespace: 'mock' }));
			b.onResolve({ filter: /\.\/nosAddonLink$/ }, () => ({ path: 'link', namespace: 'mock' }));
			b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
				contents:
					path === 'local'
						? 'export const localSpeechStatus=()=>globalThis.__live.status;export const localStoneWorker={idle(){},close(){},transcribeText:(...a)=>globalThis.__live.transcribeText(...a)}'
						: 'export const nosAddonLink={current:()=>globalThis.__live.profile,endpoint:()=>1234,sendCommand:(pid,kind,fields)=>{globalThis.__live.sent.push({pid,kind,fields});return true}}',
			}));
		},
	};
	const { registerHeroSpeechBridge } = await load('src/main/heroSpeechBridge.ts', 'bridge', [mock]);
	const context = {
		pid: 99,
		state: {
			mod: 'NoS',
			nosAddonIds: ['tanuki.bcl.roles'],
			gameState: 2,
			isHost: false,
			players: [{ id: 1, isLocal: true }, { id: 2 }],
		},
	};
	const close = registerHeroSpeechBridge(
		{ handle: (n, f) => handlers.set(n, f), on: (n, f) => handlers.set(n, f) },
		() => context,
		(id) => id === 42
	);
	const session = 'a'.repeat(32),
		event = { sender: { id: 42 } };
	const hero = { playerId: 1, kind: 'hero', request: 1, words: ['蒸着', 'じょうちゃく'], expires: 15000 };
	const ng = { playerId: 1, kind: 'ng', request: 2, words: ['タスク', 'たすく'], expires: 11400 };
	profile = { session, unixMs: now, channels: { speech: [hero, ng] } };
	const poll = () => handlers.get('NOS_HERO_SPEECH_STATE')(event);
	const transcribe = (refs, player = 1, at = now, ev = event) =>
		handlers.get('HERO_SPEECH_LOCAL_TRANSCRIBE')(ev, session, player, refs, at, wav);
	const refs = [
		{ kind: 'hero', request: 1 },
		{ kind: 'ng', request: 2 },
	];
	poll();
	const first = transcribe(refs);
	assert.equal(calls, 1);
	assert.equal(await transcribe(refs), false, 'one pending clip per speaker');
	now = 12000;
	ng.expires = 13400;
	poll();
	resolve('じょうちゃく。タスクだ。');
	assert.equal(await first, true);
	assert.deepEqual(
		sent.map((s) => s.fields.speechKind).sort(),
		['hero', 'ng'],
		'full transcript satisfies both canonical jobs after an NG heartbeat renewal'
	);
	now++;
	const duplicate = transcribe(refs);
	resolve('蒸着、タスク');
	await duplicate;
	assert.equal(sent.length, 2, 'reports are deduplicated');
	assert.equal(await transcribe(refs, 2), false, 'another PC microphone is not owned');
	assert.equal(await transcribe(refs, 1, now - 6000), false, 'old audio rejected');
	assert.equal(await transcribe(refs, 1, now + 1000), false, 'future audio rejected');
	assert.equal(
		await transcribe(refs, 1, now, { sender: { id: 9 } }),
		false,
		'settings/untrusted renderer cannot submit'
	);
	assert.equal(await transcribe([{ kind: 'hero', request: 99 }]), false, 'arbitrary requests rejected');
	now++;
	hero.request = 3;
	const custom = transcribe([{ kind: 'hero', request: 3 }]);
	resolve('変身');
	await custom;
	assert.equal(sent.length, 2, 'default transformation does not override a custom phrase');
	now++;
	const changed = transcribe([{ kind: 'hero', request: 3 }]);
	hero.words = ['闇落ち'];
	poll();
	resolve('蒸着');
	await changed;
	assert.equal(sent.length, 2, 'a late result cannot use replaced words');
	now++;
	const absent = transcribe([{ kind: 'hero', request: 3 }]);
	context.state.nosAddonIds = [];
	poll();
	resolve('闇落ち');
	await absent;
	assert.equal(sent.length, 2, 'addon loss cancels pending results');
	const before = calls;
	assert.equal(await transcribe(refs), false);
	assert.equal(calls, before, 'no addon starts no worker');
	close();
	// Exercise the renderer routing without Vosk or a real microphone.
	globalThis.setInterval = () => 0;
	globalThis.clearInterval = () => {};
	let snapshot,
		invoked = [];
	globalThis.__ipc = {
		invoke: async (name, ...args) => {
			if (name === 'NOS_HERO_SPEECH_STATE') return snapshot;
			invoked.push([name, ...args]);
		},
		send() {},
	};
	const rendererMock = {
		name: 'renderer',
		setup(b) {
			b.onResolve({ filter: /electron-bridge$/ }, () => ({ path: 'ipc', namespace: 'ipc' }));
			b.onLoad({ filter: /.*/, namespace: 'ipc' }, () => ({ contents: 'export const ipcRenderer=globalThis.__ipc;' }));
		},
	};
	const { HeroSpeech } = await load('src/renderer/voice/heroSpeech.ts', 'renderer', [rendererMock]);
	const audio = () => ({ connect() {}, disconnect() {} });
	const speech = new HeroSpeech({
		sampleRate: 48000,
		createScriptProcessor: audio,
		createGain: () => ({ ...audio(), gain: { value: 1 } }),
		destination: audio(),
	});
	context.state.nosAddonIds = ['tanuki.bcl.roles'];
	const state = { ...context.state, lobbyCode: 'ROOM', isHost: true };
	speech.setContext(state);
	for (const [key, id] of [
		['local', 1],
		['pc', 2],
		['web', 3],
		['unknown', 4],
	])
		speech.setInput(key, audio(), id, () => true);
	speech.setPeerPlatform('pc', 'desktop');
	speech.setPeerPlatform('web', 'web');
	snapshot = {
		session,
		localNeuralConfigured: true,
		players: [1, 2, 3, 4].flatMap((playerId) => [
			{ ...hero, playerId, expires: now + 5000 },
			{ ...ng, playerId, expires: now + 1400 },
		]),
	};
	await speech.poll();
	assert.deepEqual([...speech.live.keys()].sort(), [1, 3], 'shared model respects local PC/host Web routing');
	assert.equal(speech.captures.size, 0);
	assert.equal(speech.model, undefined, 'Vosk is not loaded alongside the shared live model');
	const capture = speech.live.get(1);
	for (let i = 0; i < 12; i++) {
		now += 100;
		capture.processor.onaudioprocess({ inputBuffer: { getChannelData: () => voice } });
	}
	snapshot.players.forEach((p) => (p.expires = now + 1400));
	await speech.poll();
	assert.equal(invoked.filter((i) => i[0] === 'HERO_SPEECH_LOCAL_TRANSCRIBE').length, 1);
	assert.equal(invoked[0][3].length, 2, 'one clip is shared by hero and NG');
	const original = speech.live.get(1);
	snapshot.players.forEach((p) => (p.expires = now + 1400));
	await speech.poll();
	assert.equal(speech.live.get(1), original, 'heartbeat updates preserve the capture');
	const fakeModel = {
		terminate() {},
		KaldiRecognizer: class { on() {} remove() {} acceptWaveform() {} },
	};
	globalThis.window = { Vosk: { createModel: async () => fakeModel } };
	globalThis.document = { createElement: () => ({}), head: { appendChild: (element) => element.onload() } };
	snapshot.localNeuralConfigured = false;
	await speech.poll(); await speech.poll();
	assert.equal(speech.live.size, 0, 'switching off tears down shared captures');
	assert.deepEqual([...speech.captures.keys()].sort(), [1, 3], 'Vosk fallback keeps the same speaker ownership');
	speech.setContext({ ...state, nosAddonIds: [] });
	assert.equal(speech.live.size, 0);
	assert.equal(speech.captures.size, 0);
	assert.equal(speech.model, undefined, 'addon loss releases the fallback model as well');
	speech.dispose();
	console.log(
		'PASS shared live speech: bounded utterances, overlap, canonical hero/NG matching, ownership, stale/cancel/duplicate guards, lazy model and routing'
	);
} finally {
	Date.now = realNow;
	globalThis.setInterval = realInterval;
	globalThis.clearInterval = realClear;
	delete globalThis.__live;
	delete globalThis.__ipc;
	delete globalThis.window; delete globalThis.document;
	await rm(dir, { recursive: true, force: true });
}
