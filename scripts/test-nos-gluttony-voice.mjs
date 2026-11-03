import assert from 'node:assert/strict';
import { build } from 'esbuild';

const output = await build({
	entryPoints: ['src/renderer/voice/spatialAudio.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
});
const { calculateVoiceAudio } = await import(
	`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`
);

const listener = { id: 1, clientId: 1, x: 0, y: 0, isDead: false, isImpostor: false };
const swallowed = {
	id: 2,
	clientId: 2,
	x: 1,
	y: 0,
	isDead: false,
	isImpostor: false,
	nosPlayer: { speakerPositionX: 1000, speakerPositionY: 1000 },
};
const state = {
	mod: 'NoS',
	nosAddonIds: ['UchuAddon'],
	gameState: 1,
	map: 0,
	currentCamera: -1,
	closedDoors: [],
};
const lobby = { maxDistance: 5.32, nosVoicePositions: false, nosGluttonySwallowVoice: 'mute' };
const input = {
	state,
	settings: { enableSpatialAudio: true },
	activeLobbySettings: lobby,
	me: listener,
	other: swallowed,
	maxDistance: 5.32,
	impostorRadioClientId: -1,
};
const voice = (changes = {}) => calculateVoiceAudio({ ...input, ...changes });

assert.equal(voice().gain, 0, 'swallowed player is muted with NoS speaker positions disabled');
assert.equal(voice({ activeLobbySettings: { ...lobby, nosVoicePositions: true } }).gain, 0);
const quiet = voice({ activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'quiet' } });
assert.equal(quiet.gain, 0.1);
assert.deepEqual(quiet.muffle, { type: 'lowpass', frequency: 450, q: Math.SQRT1_2 });
assert.equal(voice({ activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'normal' } }).gain, 1);
assert.equal(voice({ activeLobbySettings: { maxDistance: 5.32, nosVoicePositions: false } }).gain, 0,
	'older lobby settings use the new default');

assert.equal(voice({ other: { ...swallowed, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0 } } }).gain, 1,
	'Gluttony owner and released players have an ordinary speaker position');
assert.equal(voice({ state: { ...state, nosAddonIds: [] } }).gain, 1);
assert.equal(voice({ state: { ...state, gameState: 2 } }).gain, 1,
	'meeting uses ordinary living-player voice rules');
assert.equal(voice({ other: { ...swallowed, isDead: true }, me: { ...listener, isDead: true } }).gain, 1,
	'dead players do not retain the swallow restriction');

const megaphoneState = {
	...state,
	nosAddonIds: ['UchuAddon', 'tanuki.bcl.roles'],
	nosMegaphones: [{ playerId: 2, phase: false, range: 5 }],
};
assert.equal(voice({ state: megaphoneState }).gain, 0, 'megaphone cannot bypass mute');
const megaphoneQuiet = voice({
	state: megaphoneState,
	activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'quiet' },
});
assert.ok(megaphoneQuiet.gain > 0 && megaphoneQuiet.gain <= 0.1);
assert.equal(megaphoneQuiet.muffle?.type, 'lowpass');

const radioInput = {
	activeLobbySettings: {
		...lobby,
		impostorRadioEnabled: true,
		nosGluttonySwallowVoice: 'quiet',
	},
	other: { ...swallowed, isImpostor: true },
	impostorRadioClientId: 2,
	nosImpostorRadioHearable: true,
};
assert.equal(voice({ ...radioInput, activeLobbySettings: { ...radioInput.activeLobbySettings, nosGluttonySwallowVoice: 'mute' } }).gain, 0,
	'radio cannot bypass mute');
assert.equal(voice(radioInput).gain, 0.1, 'radio is also muffled');

console.log('PASS UchuAddon Gluttony swallow voice modes and bypass paths');
