import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

let phases;
let addon;
async function load(file, dependencies = {}) {
	const source = await readFile(file, 'utf8');
	const { code } = await transform(source, {
		loader: 'ts',
		format: 'cjs',
		target: 'es2022',
		logLevel: 'silent',
		define: { 'import.meta.env.DEV': 'false' },
	});
	const module = { exports: {} };
	vm.runInNewContext(code, {
		module,
		exports: module.exports,
		require(name) {
			if (dependencies[name]) return dependencies[name];
			if (name.endsWith('AmongUsState')) return { GameState: phases };
			if (name.endsWith('tanukiAddon')) return addon;
			if (name.endsWith('TypedEmitter')) return { TypedEmitter: class {} };
			if (name.endsWith('pushToTalkOptions')) return { pushToTalkOptions: { VOICE: 0 } };
			return new Proxy(
				{},
				{
					get: () => () => {
						throw new Error(`Unexpected inactive dependency: ${name}`);
					},
				}
			);
		},
		setInterval() {
			throw new Error('Inactive addon started a timer');
		},
		clearInterval() {},
		console,
	});
	return module.exports;
}

phases = (await load('src/common/AmongUsState.ts')).GameState;
addon = await load('src/common/tanukiAddon.ts');
const { bitCharacterStage } = await load('src/common/BitCharacterState.ts');
const { wallEarFor } = await load('src/common/WallEarState.ts');
const speaker = { id: 1, isDead: false, disconnected: false, x: 0, y: 0, inVent: false };
const state = {
	mod: 'NoS',
	gameState: phases.TASKS,
	nosAddonIds: ['tanuki.bcl.roles'],
	nosBitCharacters: [{ playerId: 1, stage: 2 }],
	nosWallEars: [{ playerId: 1, x: 0, y: 0, range: 4 }],
	nosLimitSpeechMuted: [1],
};
assert.equal(bitCharacterStage(state, speaker), 2);
assert.equal(wallEarFor(state, speaker)?.range, 4);
for (const change of [
	{ nosAddonIds: [] },
	{ nosAddonIds: undefined },
	{ nosAddonIds: ['UchuAddon'] },
	{ mod: 'NONE' },
]) {
	const absent = { ...state, ...change };
	assert.equal(bitCharacterStage(absent, speaker), -1, 'stale bit state must not enable a filter without the addon');
	assert.equal(wallEarFor(absent, speaker), undefined, 'stale ear state must not alter hearing without the addon');
	assert.equal(addon.isTanukiSpeechMuted(absent, 1), false, 'stale speech limits must not mute without the addon');
}
assert.equal(addon.isTanukiSpeechMuted(state, 1), true);
assert.equal(addon.isTanukiSpeechMuted({ ...state, gameState: phases.DISCUSSION }, 1), true);
assert.equal(addon.isTanukiSpeechMuted({ ...state, gameState: phases.LOBBY }, 1), false);
assert.equal(addon.isTanukiSpeechMuted(state, 2), false);

const { AudioController } = await load('src/renderer/voice/AudioController.ts');
const audio = new AudioController();
audio.context = {};
audio.masterGain = {};
for (let i = 0; i < 1000; i++) audio.syncTanukiAddon({ ...state, nosAddonIds: [] });
assert.equal(audio.heroSpeech, undefined);
assert.equal(audio.parrots, undefined);
assert.equal(audio.interviewer, undefined);
let stopped = 0;
audio.tanukiAddonActive = true;
audio.parrots = { disconnect: () => stopped++ };
audio.interviewer = { disconnect: () => stopped++ };
audio.heroSpeech = { dispose: () => stopped++ };
audio.stopTanukiInput = () => stopped++;
audio.syncTanukiAddon({ ...state, nosAddonIds: [] });
assert.equal(stopped, 4, 'losing detection stops all recorders, speech and microphone taps');
assert.equal(audio.heroSpeech, undefined);
assert.equal(audio.parrots, undefined);
assert.equal(audio.interviewer, undefined);
audio.syncTanukiAddon({ ...state, nosAddonIds: [] });
assert.equal(stopped, 4, 'already inactive teardown is a no-op');
console.log(
	'PASS: absent/stale addon effects bypassed; 1,000 inactive updates start no recognition, recording or timers; detection loss tears down once.'
);
