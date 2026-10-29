import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cache = resolve('.tools/test-cache');
await mkdir(cache, { recursive: true });
let moduleId = 0;
async function load(entry, mocks = {}) {
	const output = await build({
		entryPoints: [entry],
		bundle: true,
		packages: 'external',
		platform: 'node',
		format: 'esm',
		write: false,
		define: { 'import.meta.env.DEV': 'false' },
		plugins: [
			{
				name: 'integration-mocks',
				setup(b) {
					b.onResolve({ filter: /.*/ }, (args) => {
						const key = Object.keys(mocks).find((key) => args.path === key || args.path.endsWith('/' + key));
						if (key) return { path: key, namespace: 'mock' };
					});
					b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path] }));
					if (process.env.TANUKI_ADDON_BASELINE)
						b.onLoad({ filter: /[\\/]AudioController\.ts$/ }, async (args) => ({
							contents: await readFile(process.env.TANUKI_ADDON_BASELINE, 'utf8'),
							loader: 'ts',
							resolveDir: resolve(args.path, '..'),
						}));
				},
			},
		],
	});
	const file = join(cache, `tanuki-loading-${process.pid}-${moduleId++}.mjs`);
	await writeFile(file, output.outputFiles[0].contents);
	return import(pathToFileURL(file));
}

const { GameState } = await load('src/common/AmongUsState.ts');
const { hasTanukiAddon } = await load('src/common/tanukiAddon.ts');
const local = { id: 1, clientId: 11, isLocal: true, isDead: false, disconnected: false };
const remote = { id: 2, clientId: 22, isLocal: false, isDead: false, disconnected: false };
const plain = {
	mod: 'NoS',
	nosAddonIds: [],
	gameState: GameState.TASKS,
	lobbyCode: 'ABCDEF',
	players: [local, remote],
	isHost: true,
};
const detected = { ...plain, nosAddonIds: ['tanuki.bcl.roles'] };
for (const state of [
	undefined,
	plain,
	{ ...plain, nosAddonIds: undefined },
	{ ...plain, nosAddonIds: ['UchuAddon'] },
	{ ...detected, mod: 'NONE' },
])
	assert.equal(hasTanukiAddon(state), false);
assert.equal(hasTanukiAddon(detected), true);
const { voiceJammingFor } = await load('src/common/VoiceJammingState.ts');
const { isHeroTransformed } = await load('src/common/HeroTransformState.ts');
const { chargingMegaphone, portableMegaphoneExtraRange } = await load('src/renderer/voice/megaphoneVoice.ts');
const { voiceRoleIdentity } = await load('src/common/RemoteVoiceRole.ts');
const stale = {
	...plain,
	nosVoiceJamming: [{ playerId: 1, muted: true, lowpass: true, pitch: 1.5 }],
	nosHeroTransforms: [{ playerId: 1, kind: 'super' }],
	nosMegaphones: [{ playerId: 1, range: 20 }],
	nosPortableMegaphones: [{ playerId: 1, extraRange: 20 }],
};
assert.equal(voiceJammingFor({ ...stale, gameState: GameState.DISCUSSION }, 1), undefined);
assert.equal(isHeroTransformed(stale, 1), false);
assert.equal(chargingMegaphone(stale, local), undefined);
assert.equal(portableMegaphoneExtraRange(stale, local), 0);
assert.equal(voiceRoleIdentity(stale, local), undefined, 'stale addon payloads cannot reactivate its features');

const io = [],
	sockets = [];
globalThis.tanukiIo = { io, sockets, file: '' };
const mainMocks = {
	'node:fs': `
		export function existsSync(p) { globalThis.tanukiIo.io.push(p); return true; }
		export function statSync(p) { globalThis.tanukiIo.io.push(p); return { size: 100 }; }
		export function readFileSync(p) {
			globalThis.tanukiIo.io.push(p);
			const now = Date.now(), base = { protocol: 1, pid: 123, unixMs: now, players: [] };
			if (p.endsWith('voice-role.json')) return JSON.stringify({ ...base, role: 'tanukiVoiceRoles', playerId: 1, port: 12345, token: 'a'.repeat(32) });
			if (p.includes('hero-speech-')) return JSON.stringify({ ...base, protocol: 2, updated: now, port: 12345, token: 'a'.repeat(32), players: [{ playerId: 1, kind: 'hero', request: 1, expires: now + 1000, words: ['変身'] }] });
			if (p.includes('host-voice-')) return JSON.stringify({ ...base, port: 12345, token: 'a'.repeat(32) });
			return JSON.stringify(base);
		}`,
	'node:dgram': `export function createSocket() {
		const socket = { closed: false, packets: [], on() { return this; }, unref() {}, close() { this.closed = true; }, send(...args) { this.packets.push(args); } };
		globalThis.tanukiIo.sockets.push(socket); return socket;
	}`,
};
const { readTanukiAddonState } = await load('src/main/tanukiAddonState.ts', mainMocks);
for (const state of [
	plain,
	{ ...plain, nosAddonIds: undefined },
	{ ...plain, nosAddonIds: ['UchuAddon'] },
	{ ...detected, mod: 'NONE' },
])
	assert.deepEqual(readTanukiAddonState(123, state), {});
assert.equal(io.length, 0, 'undetected addon must not even stat or probe role state files');
readTanukiAddonState(123, detected);
assert.ok(io.length > 0, 'detected addon still reads its active role states');
io.length = 0;
readTanukiAddonState(123, { ...detected, gameState: GameState.LOBBY });
assert.equal(io.length, 0, 'role state reads remain stopped in the lobby');

const handlers = new Map();
const ipc = { on: (name, cb) => handlers.set(name, cb), handle: (name, cb) => handlers.set(name, cb) };
let state = plain,
	changed;
const { registerNosVoiceRoleBridge } = await load('src/main/nosVoiceRoleBridge.ts', mainMocks);
assert.equal(sockets.length, 0, 'importing addon bridges must not open sockets');
const bridge = registerNosVoiceRoleBridge(
	ipc,
	() => ({ pid: 123, state }),
	(id) => id === 7,
	(listener) => {
		changed = listener;
		return () => {
			changed = undefined;
		};
	}
);
assert.ok(bridge);
const event = { sender: { id: 7 } };
handlers.get('NOS_VOICE_ROLE_SAMPLE')(event, 0.5, true);
handlers.get('NOS_HOST_VOICE_SAMPLE')(event, 2, 0.5, true);
assert.equal(handlers.get('NOS_HERO_SPEECH_STATE')(event), null);
assert.equal(io.length, 0, 'IPC cannot bypass absent addon detection');
assert.equal(sockets.length, 0, 'registering and receiving disabled addon IPC must not open sockets');
state = detected;
handlers.get('NOS_VOICE_ROLE_SAMPLE')(event, 0.5, true);
handlers.get('NOS_HOST_VOICE_SAMPLE')(event, 2, 0.5, true);
handlers.get('NOS_HERO_SPEECH_READY')(event, 'a'.repeat(32), [1]);
assert.equal(sockets.length, 3, 'detected voice, host relay and speech bridges activate lazily');
assert.ok(sockets.every((socket) => socket.packets.length > 0));
state = plain;
changed(state);
assert.ok(
	sockets.every((socket) => socket.closed),
	'detection loss closes every addon socket'
);
const previousReads = io.length;
handlers.get('NOS_VOICE_ROLE_SAMPLE')(event, 0.5, true);
handlers.get('NOS_HOST_VOICE_SAMPLE')(event, 2, 0.5, true);
handlers.get('NOS_HERO_SPEECH_STATE')(event);
assert.equal(io.length, previousReads, 'old descriptors are ignored after detection loss');
bridge.close();

const timers = new Map();
const oldInterval = globalThis.setInterval,
	oldClear = globalThis.clearInterval;
let nextTimer = 0;
let invokes = 0;
globalThis.tanukiIpc = {
	on() {},
	off() {},
	send() {},
	invoke: async () => {
		invokes++;
		return null;
	},
};
const track = { enabled: true, readyState: 'live', muted: false, stop() {} };
globalThis.tanukiStream = { getAudioTracks: () => [track], getTracks: () => [track] };
globalThis.tanukiSettings = { masterVolume: 100, autoGainControl: true, microphone: 'default' };
const nodes = [];
class AudioNode {
	constructor(context, kind) {
		this.context = context;
		this.kind = kind;
		this.connections = new Set();
		for (const name of ['gain', 'delayTime', 'frequency', 'Q'])
			this[name] = { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
		nodes.push(this);
	}
	connect(node) {
		this.connections.add(node);
	}
	disconnect(node) {
		if (node) this.connections.delete(node);
		else this.connections.clear();
	}
	getFloatTimeDomainData(data) {
		data.fill(0.5);
	}
}
class AudioContext {
	currentTime = 0;
	sampleRate = 48000;
	destination = new AudioNode(this, 'destination');
	createGain() {
		return new AudioNode(this, 'gain');
	}
	createMediaStreamSource() {
		return new AudioNode(this, 'source');
	}
	createAnalyser() {
		return new AudioNode(this, 'analyser');
	}
	createPanner() {
		return new AudioNode(this, 'panner');
	}
	createBiquadFilter() {
		return new AudioNode(this, 'filter');
	}
	createConvolver() {
		return new AudioNode(this, 'convolver');
	}
	createDelay() {
		return new AudioNode(this, 'delay');
	}
	createScriptProcessor() {
		return new AudioNode(this, 'processor');
	}
	setSinkId() {
		return Promise.resolve();
	}
	resume() {
		return Promise.resolve();
	}
}
globalThis.AudioContext = AudioContext;
globalThis.Audio = class {
	setAttribute() {}
	pause() {}
	removeAttribute() {}
	load() {}
	remove() {}
};
globalThis.window = { electron: { ipcRenderer: globalThis.tanukiIpc, shell: {}, platform: 'win32' } };
const audioMocks = {
	'electron-bridge': 'export const ipcRenderer = globalThis.tanukiIpc;',
	SettingsStore: 'export default { store: globalThis.tanukiSettings };',
	captureMicrophone:
		'export async function captureMicrophone() { return { stream: globalThis.tanukiStream, usedDefault: false }; }',
	vad: 'export default function() { return { options: {}, init() {}, destroy() {} }; }',
};
globalThis.setInterval = (callback, ms) => {
	const id = ++nextTimer;
	timers.set(id, { callback, ms });
	return id;
};
globalThis.clearInterval = (id) => {
	timers.delete(id);
};
let audio;
try {
	const { AudioController } = await load('src/renderer/voice/AudioController.ts', audioMocks);
	audio = new AudioController();
	audio.started = true;
	audio.context = new AudioContext();
	audio.createOutputBus('default');
	await audio.createInputChain(globalThis.tanukiSettings, 0, 0);
	audio.addPeer('peer', globalThis.tanukiStream);
	audio.setSpeechPlatform('peer', 'web');
	audio.updateGameState(plain);
	const peer = audio.peers.get('peer');
	assert.equal(timers.size, 0, 'plain NoS must have no addon microphone or recognition timers');
	assert.equal(nodes.filter((n) => n.kind === 'analyser' || n.kind === 'processor').length, 0);
	for (const name of ['dyingVoiceRecording', 'megaphoneRecording', 'bibiriEcho']) assert.equal(peer[name], undefined);
	assert.equal(audio.interviewer, undefined);
	assert.equal(audio.heroSpeech, undefined);
	assert.equal(audio.interviewMic, undefined);
	assert.equal(invokes, 0, 'plain NoS never polls speech IPC or loads a speech model');

	audio.updateGameState(detected);
	assert.ok(audio.interviewer && audio.heroSpeech && audio.localMegaphoneRecording);
	assert.ok(peer.dyingVoiceRecording && peer.megaphoneRecording && peer.bibiriEcho);
	assert.equal(timers.size, 2, 'detection starts one microphone sampler and one recognition poll');
	assert.ok(audio.heroSpeech.platforms.has('peer'), 'late detection preserves existing peer platform metadata');
	const allocated = nodes.length;
	for (let i = 0; i < 10; i++) audio.updateGameState(detected);
	assert.equal(nodes.length, allocated, 'unchanged detection reuses addon resources');
	assert.equal(timers.size, 2);
	let samples = 0;
	audio.on('voiceRoleSample', () => {
		samples++;
	});
	const obsolete = [...timers.values()].find((timer) => timer.ms === 50).callback;
	obsolete();
	assert.equal(samples, 1);
	const oldSpeech = audio.heroSpeech;
	audio.updateGameState(plain);
	assert.equal(timers.size, 0, 'detection loss stops all addon timers');
	assert.equal(oldSpeech.disposed, true);
	assert.equal(audio.interviewer, undefined);
	assert.equal(audio.interviewMic, undefined);
	for (const name of ['dyingVoiceRecording', 'megaphoneRecording', 'bibiriEcho']) assert.equal(peer[name], undefined);
	assert.ok(peer.gain.connections.has(audio.masterGain), 'ordinary voice output survives addon teardown');
	assert.ok(peer.source.connections.has(peer.pan), 'ordinary voice input survives addon teardown');
	const stoppedSamples = samples;
	obsolete();
	assert.equal(samples, stoppedSamples, 'queued sampler cannot send after deactivation');
	audio.updateGameState(detected);
	assert.notEqual(audio.heroSpeech, oldSpeech);
	obsolete();
	assert.equal(samples, stoppedSamples, 'old sampler cannot send into a new activation');
	assert.equal(timers.size, 2, 'redetection restarts each timer exactly once');
	audio.teardownInputChain();
	assert.equal(timers.size, 1);
	await audio.createInputChain(globalThis.tanukiSettings, 0, 0);
	assert.equal(timers.size, 2, 'microphone replacement restarts only its own sampler');
	audio.updateGameState({ ...detected, mod: 'NONE' });
	assert.equal(timers.size, 0, 'leaving NoS releases all addon resources');
	console.log(
		'PASS addon detection: zero file probes, sockets, recorder graphs and timers while absent; lazy activation, removal, redetection and microphone replacement'
	);
} finally {
	audio?.teardownInputChain();
	audio?.teardownTanukiAddon?.();
	globalThis.setInterval = oldInterval;
	globalThis.clearInterval = oldClear;
}
