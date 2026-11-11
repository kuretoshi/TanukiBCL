import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import vm from 'node:vm';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mobile = resolve(process.argv[2] ?? 'C:/Users/tamo-/TanukiBCL-mobile-hero-effects');
const directory = await mkdtemp(join(tmpdir(), 'tanuki-parrot-'));
let moduleId = 0;
async function load(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	const file = join(directory, `${moduleId++}.mjs`);
	await writeFile(file, result.outputFiles[0].contents);
	return import(pathToFileURL(file));
}
async function controllerMethods(file, names) {
	const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const klass = source.statements.find((n) => ts.isClassDeclaration(n) && n.name?.text === 'VoiceController');
	const methods = klass.members
		.filter((n) => names.includes(n.name?.getText(source)))
		.map((n) => n.getText(source).replace(/^(private|public) /, ''))
		.join('\n');
	return vm.runInNewContext(
		ts.transpileModule(`({${methods}})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
	);
}
async function displayFixture(recorder, state, me, web) {
	if (web) {
		const methods = await controllerMethods(join(mobile, 'src/app/services/voice-controller.service.ts'), [
			'getRenderablePlayers',
			'getOrCreatePlayerState',
			'isTalking',
		]);
		return {
			...methods,
			playerStates: new Map([[10, { talking: false, audible: false }]]),
			connectionController: {
				currentGameState: state,
				localPLayer: me,
				playerSocketIds: {},
				audioController: recorder,
			},
			getPlayerConnectionState: () => 'connected',
		};
	}
	const methods = await controllerMethods('src/renderer/voice/VoiceController.ts', ['updateCloneTalking']);
	return {
		...methods,
		audio: recorder,
		snapshot: { otherTalking: { 10: false } },
		patch(value) {
			Object.assign(this.snapshot, value);
		},
	};
}
function checkDisplay(display, state, on, web) {
	if (web) {
		const row = display.getRenderablePlayers().find((r) => r.player.id === 1);
		assert.equal(
			row.talking && row.audible,
			on,
			'mobile avatar follows audible clone even when owner live audio is out of range'
		);
		assert.equal(display.isTalking(10), on, 'mobile native overlay uses listener-local clone speech');
		assert.equal(display.playerStates.get(10).talking, false, 'mobile real VAD remains unchanged');
	} else {
		display.updateCloneTalking(state);
		assert.equal(!!display.snapshot.cloneTalking[10], on, 'PC/Lite/overlay display uses owner client ID');
		assert.equal(display.snapshot.otherTalking[10], false, 'PC real VAD remains unchanged');
	}
}
class Node {
	constructor() {
		this.gain = { value: 1 };
		this.pan = { value: 0 };
		this.connections = [];
	}
	connect(target) {
		this.connections.push(target);
	}
	disconnect(target) {
		this.connections = target ? this.connections.filter((n) => n !== target) : [];
	}
	stop() {
		this.stopped = true;
	}
	start(at, offset) {
		this.offset = offset;
	}
}
class Context {
	currentTime = 1;
	sampleRate = 48000;
	processors = [];
	plays = [];
	createGain() {
		return new Node();
	}
	createStereoPanner() {
		return new Node();
	}
	createScriptProcessor() {
		const node = new Node();
		this.processors.push(node);
		return node;
	}
	createBufferSource() {
		const node = new Node();
		this.plays.push(node);
		return node;
	}
	createBuffer(channels, length, sampleRate) {
		const data = new Float32Array(length);
		return { length, sampleRate, getChannelData: () => data };
	}
	voice(amplitude, seconds = 0.02) {
		this.currentTime += seconds;
		const data = new Float32Array(Math.round(seconds * this.sampleRate)).fill(amplitude);
		for (const p of this.processors)
			p.onaudioprocess?.({ inputBuffer: { sampleRate: this.sampleRate, getChannelData: () => data } });
	}
}
async function exercise(entry, web, seconds = 1.5) {
	const { createParrotRecording } = await load(entry);
	const ctx = new Context(),
		raw = new Node(),
		output = new Node(),
		requests = [];
	const recorder = createParrotRecording(ctx, output, web ? undefined : (...args) => requests.push(args));
	const me = { id: 1, isLocal: true, clientId: 10, x: 12, y: -15, isDead: false };
	const speaker = { id: 2, clientId: 11, x: 12, y: -15, isDead: false };
	const state = { mod: 'NoS', gameState: 1, map: 5, closedDoors: [], players: [me, speaker], isHost: true };
	let row = {
		ownerId: 1,
		birdId: 1,
		x: 12,
		y: -15,
		range: 4,
		...(seconds === 1.5 ? {} : { seconds }),
		recordId: 0,
		sourceId: 2,
		started: 0,
		clips: [],
		playId: 0,
		playClip: 0,
		playStarted: 0,
	};
	let now = 100000,
		allowed = true;
	const update = () => recorder.update([row], state, me, 1, now);
	update();
	recorder.setInput('peer', raw, 2, () => allowed);
	ctx.voice(0.25);
	assert.equal(requests.length, web ? 0 : 1, 'only desktop host requests capture');
	assert.equal(ctx.plays.length, 0, 'empty bird records before playing');
	row = { ...row, recordId: 1, started: now };
	update();
	for (let i = 0; i < Math.round(seconds * 50); i++) ctx.voice(0.25);
	now += seconds * 1000;
	row = { ...row, clips: [1], playId: 10, playClip: 1, playStarted: now };
	update();
	assert.equal(ctx.plays.length, 1);
	const first = ctx.plays[0];
	assert.equal(first.buffer.length, seconds * 16000, 'configured duration determines mono PCM size');
	assert(first.buffer.getChannelData(0).at(-100) > 0.24, 'recording fills the configured duration through the end');
	assert(
		first.buffer.getChannelData(0).some((v) => v > 0.24),
		'recorded PCM actually reaches playback'
	);
	assert(
		raw.connections.every((n) => ctx.processors.includes(n)),
		'raw input only feeds capture processor'
	);
	update();
	assert.equal(ctx.plays.length, 1, 'same play ID never repeats');
	recorder.setVolume('peer', 0);
	assert.equal(first.connections[0].gain.value, 0, 'source mute suppresses saved audio');
	recorder.setVolume('peer', 1);
	me.x = 30;
	update();
	assert.equal(first.connections[0].gain.value, 0, 'outside range silent');
	me.x = 12;
	state.gameState = 2;
	row = { ...row, playId: 0, playClip: 0, playStarted: 0 };
	update();
	assert(first.stopped, 'meeting stops playback immediately');
	state.gameState = 1;
	now += 2000;
	row = { ...row, playId: 11, playClip: 1, playStarted: now };
	update();
	assert.equal(ctx.plays.at(-1).buffer, first.buffer, 'completed clip survives meeting without copying');
	if (seconds > 1.5) {
		row = { ...row, playId: 13, playStarted: now - 1600 };
		update();
		assert.equal(ctx.plays.at(-1).offset, 1.6, 'long clips can begin after 1.5 seconds of playback delay');
	}
	allowed = false;
	now += 2000;
	row = { ...row, recordId: 2, started: now, playId: 0, playClip: 0, playStarted: 0 };
	update();
	for (let i = 0; i < Math.round(seconds * 50); i++) ctx.voice(0.9);
	now += seconds * 1000;
	row = { ...row, clips: [1, 2], playId: 12, playClip: 2, playStarted: now };
	update();
	assert(
		ctx.plays
			.at(-1)
			.buffer.getChannelData(0)
			.every((v) => v === 0),
		'muted/private input excluded from capture'
	);
	recorder.silence();
	assert(ctx.plays.at(-1).stopped, 'deafen stops playback');
	state.gameState = 0;
	update();
	assert.equal(raw.connections.length, 0, 'no capture processors retained outside game');
	recorder.disconnect();
	console.log(`PASS parrot ${seconds}s PCM, host coordination, meeting, permissions and cleanup: ${entry}`);
}
async function exerciseClone(entry) {
	const { createParrotRecording } = await load(entry);
	const ctx = new Context(),
		raw = new Node(),
		requests = [];
	const recorder = createParrotRecording(ctx, new Node(), (...args) => requests.push(args));
	const owner = { id: 1, clientId: 10, x: 12, y: -15, isDead: false };
	const me = { id: 2, isLocal: true, clientId: 11, x: 30, y: -15, isDead: false };
	const state = { mod: 'NoS', gameState: 1, map: 5, closedDoors: [], players: [owner, me], isHost: true };
	let now = 100000;
	let row = {
		mode: 'clone',
		spoofTalking: true,
		ownerId: 1,
		birdId: 1000001,
		sourceId: 1,
		x: 12,
		y: -15,
		range: 4,
		seconds: 10,
		recordId: 1,
		started: now,
		clips: [],
		playId: 0,
		playClip: 0,
		playStarted: 0,
	};
	const update = () => recorder.update([row], state, me, 1, now);
	const web = entry !== 'src/renderer/voice/parrotRecording.ts';
	const display = await displayFixture(recorder, state, me, web);
	update();
	recorder.setInput('owner', raw, 1, () => true);
	for (let i = 0; i < 500; i++) ctx.voice(i >= 200 && i < 300 ? 0 : 0.25);
	assert.equal(requests.length, 0, 'clone must not automatically request parrot captures');
	now += 10000;
	row = { ...row, clips: [1], playId: 1, playClip: 1, playStarted: now };
	update();
	const first = ctx.plays.at(-1);
	assert.equal(first.buffer.length, 160000, 'clone captures ten seconds of mono 16kHz PCM');
	assert(first.buffer.getChannelData(0).at(-100) > 0.24, 'recording fills the whole ten seconds');
	assert.equal(first.loop, true, 'native audio source loops without new RPCs or buffers');
	assert.equal(first.connections[0].gain.value, 0, 'outside listener starts with silent ongoing loop');
	ctx.currentTime += 0.1;
	assert(!recorder.isCloneTalking(1), 'inaudible clone cannot spoof owner');
	row = { ...row, x: 30 };
	update();
	assert(first.connections[0].gain.value > 0.99, 'playback follows clone independently of owner');
	assert.equal(ctx.plays.length, 1, 'moving clone never recreates or copies recording');
	assert(recorder.isCloneTalking(1), 'audible clone lights up owner even when owner is far away');
	checkDisplay(display, state, true, web);
	assert(!recorder.isCloneTalking(2), 'only the clone owner is spoofed');
	row = { ...row, spoofTalking: false };
	update();
	assert(
		!recorder.isCloneTalking(1) && first.connections[0].gain.value > 0,
		'off disables display without muting audio'
	);
	checkDisplay(display, state, false, web);
	row = { ...row, spoofTalking: undefined };
	update();
	assert(!recorder.isCloneTalking(1), 'legacy clone packets cannot enable spoofing');
	row = { ...row, spoofTalking: true };
	update();
	assert(recorder.isCloneTalking(1), 'enabling setting during existing playback is immediate');
	ctx.currentTime += 5;
	assert(!recorder.isCloneTalking(1), 'saved silent section never lights up');
	ctx.currentTime += 2;
	assert(recorder.isCloneTalking(1), 'voice resumes after silent section');
	ctx.currentTime += 10;
	assert(recorder.isCloneTalking(1), 'speaking follows loop cursor across multiple loops');
	ctx.state = 'suspended';
	assert(!recorder.isCloneTalking(1), 'suspended output context cannot spoof');
	ctx.state = 'running';
	owner.inVent = true;
	assert(recorder.isCloneTalking(1), 'owner location and vent state do not replace clone audibility');
	owner.inVent = false;
	me.inVent = true;
	update();
	assert(!recorder.isCloneTalking(1), 'listener in vent cannot hear or see clone VAD');
	me.inVent = false;
	update();
	recorder.setVolume('owner', 0);
	assert.equal(first.connections[0].gain.value, 0, 'player volume mutes saved clone voice');
	assert(!recorder.isCloneTalking(1), 'source mute clears spoof immediately');
	recorder.setVolume('owner', 1);
	recorder.silence();
	assert(first.stopped, 'deafen stops loop');
	assert(!recorder.isCloneTalking(1), 'deafen or comms silence clears spoof');
	now += 31250;
	update();
	assert.equal(ctx.plays.at(-1).offset, 1.25, 'undeafen resumes the correct point after multiple loops');
	assert.equal(ctx.plays.at(-1).buffer, first.buffer, 'resume reuses the same PCM buffer');
	state.gameState = 2;
	row = { ...row, playId: 0, playClip: 0, playStarted: 0 };
	update();
	assert(ctx.plays.at(-1).stopped, 'meeting stops looping source');
	assert(!recorder.isCloneTalking(1), 'meeting clears spoof');
	state.gameState = 1;
	now += 1000;
	row = { ...row, recordId: 2, started: now, clips: [], x: 12 };
	update();
	for (let i = 0; i < 500; i++) ctx.voice(0.5);
	now += 10000;
	row = { ...row, clips: [2], playId: 2, playClip: 2, playStarted: now, x: 30 };
	update();
	assert.notEqual(ctx.plays.at(-1).buffer, first.buffer, 'rerecord replaces old clip');
	assert(ctx.plays.at(-1).buffer.getChannelData(0).at(-100) > 0.49, 'replacement PCM is played');
	recorder.update([], state, me, 1, now);
	assert(ctx.plays.at(-1).stopped && raw.connections.length === 0, 'despawn and role removal release audio nodes');
	assert(!recorder.isCloneTalking(1), 'despawn and role removal clear spoof');
	recorder.disconnect();
	console.log(`PASS clone ten-second PCM, looping, moving position, volume, resume, overwrite and cleanup: ${entry}`);
}
try {
	await exerciseClone('src/renderer/voice/parrotRecording.ts');
	await exerciseClone(join(mobile, 'src/app/voice/parrotRecording.ts'));
	for (const seconds of [1.5, 0.5, 3, 5]) {
		await exercise('src/renderer/voice/parrotRecording.ts', false, seconds);
		await exercise(join(mobile, 'src/app/voice/parrotRecording.ts'), true, seconds);
	}
	const { validAddonChannels } = await load('src/common/AddonLink.ts');
	const { validParrot } = await load('src/common/ParrotState.ts');
	const channels = Object.fromEntries(
		['heroes', 'portable', 'megaphones', 'dying', 'interviews', 'jamming', 'echoes', 'muted', 'speech'].map((k) => [
			k,
			[],
		])
	);
	const row = {
		ownerId: 1,
		birdId: 1,
		x: 12,
		y: -15,
		range: 4,
		recordId: 1,
		sourceId: 2,
		started: 1000,
		clips: [1],
		playId: 1,
		playClip: 1,
		playStarted: 2500,
	};
	assert(validAddonChannels(channels, 3000), 'older clients without parrot channel accepted');
	assert(validAddonChannels({ ...channels, parrots: [row] }, 3000));
	assert(!validAddonChannels({ ...channels, parrots: [row, row] }, 3000), 'duplicate bird rejected');
	assert(!validParrot({ ...row, clips: [1, 2, 3, 4, 5, 6] }, 3000), 'bank is bounded');
	assert(!validParrot({ ...row, x: Infinity }, 3000), 'nonfinite coordinates rejected');
	for (const seconds of [0.5, 1.5, 3, 5])
		assert(validParrot({ ...row, seconds }, 3000), 'configured duration accepted');
	for (const seconds of [0, 0.49, 5.01, Infinity, NaN, null, '3'])
		assert(!validParrot({ ...row, seconds }, 3000), 'invalid duration rejected');
	assert(!validParrot({ ...row, playStarted: 99999 }, 3000), 'future timestamp rejected');
	const clone = { ...row, mode: 'clone', seconds: 10, sourceId: 1, birdId: 1000001 };
	assert(validAddonChannels({ ...channels, parrots: [clone] }, 3000), 'clone crosses validated addon transport');
	for (const spoofTalking of [true, false]) assert(validParrot({ ...clone, spoofTalking }, 3000));
	for (const spoofTalking of ['true', 1, null]) assert(!validParrot({ ...clone, spoofTalking }, 3000));
	assert(!validParrot({ ...row, spoofTalking: true }, 3000), 'ordinary parrots cannot spoof');
	assert(!validParrot({ ...clone, sourceId: 2 }, 3000), 'clone may only capture its owner');
	assert(!validParrot({ ...clone, clips: [1, 2] }, 3000), 'clone retains only one recording');
	assert(!validParrot({ ...clone, seconds: 5 }, 3000), 'clone recording is exactly ten seconds');
	assert(!validParrot({ ...row, mode: 'unknown' }, 3000), 'unknown capture mode rejected');
	const many = Array.from({ length: 120 }, (_, i) => ({ ...row, ownerId: Math.floor(i / 5), birdId: i + 1 }));
	assert(validAddonChannels({ ...channels, parrots: many }, 3000), '24 players with five parrots supported');
	assert(
		!validAddonChannels({ ...channels, parrots: [...many, { ...row, birdId: 999 }] }, 3000),
		'channel bound enforced'
	);
	console.log('PASS parrot transport validation and old-version compatibility');
} finally {
	await rm(directory, { recursive: true, force: true });
}
