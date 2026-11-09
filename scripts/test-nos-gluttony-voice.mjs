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
	nosPlayer: { speakerPositionX: 1000, speakerPositionY: 1000, addonData: 100 },
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

// UchuAddon publishes the victim at its real voice endpoint only to its swallower.
// The body remains nearby in every view; no role-name or magic-coordinate inference.
for (const nosVoicePositions of [false, true]) {
	const settings = { ...lobby, nosVoicePositions };
	const ownVictim = { ...swallowed, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0, addonData: 100 } };
	assert.equal(voice({ other: ownVictim, activeLobbySettings: settings }).gain, 1,
		'mute must preserve the swallower hearing its own victim');
	assert.equal(voice({ activeLobbySettings: settings }).gain, 0,
		'mute must hide the same victim from a nearby bystander');
	const radio = { impostorRadioClientId: 2, nosImpostorRadioHearable: true,
		activeLobbySettings: { ...settings, impostorRadioEnabled: true } };
	assert.equal(voice({ ...radio, other: ownVictim }).gain, 1, 'swallower retains authorized radio');
	assert.equal(voice(radio).gain, 0, 'radio must not leak a hidden victim to a bystander');
}
assert.equal(voice({
	state: { ...state, nosLocalMicPosition: { x: 20, y: 4 } },
	other: { ...swallowed, nosPlayer: { speakerPositionX: 21, speakerPositionY: 4, addonData: 100 } },
}).gain, 1, 'mute uses the published microphone endpoint, not the physical body');
assert.equal(voice({
	other: { ...swallowed, nosPlayer: { speakerPositionX: 20, speakerPositionY: 4, addonData: 100 } },
	me: { ...listener, nosRole: { roleName: 'gluttonyU' } },
}).gain, 0, 'another Gluttony cannot hear this victim; no role or sentinel-coordinate exception');

const nearby = { ...swallowed, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0, addonData: 100 } };
assert.equal(voice({ other: nearby }).gain, 1, 'AddonData=100 alone must not mute an allowed NoS endpoint');
const nearbyQuiet = voice({ other: nearby, activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'quiet' } });
assert.equal(nearbyQuiet.gain, 0.1, 'explicit swallowed data applies quiet mode');
assert.deepEqual(nearbyQuiet.muffle, { type: 'lowpass', frequency: 450, q: Math.SQRT1_2 });
assert.equal(voice({ other: nearby, activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'normal' } }).gain, 1);
for (const addonData of [undefined, null, 0, 1, 36, 64, 99, 101, 128, 164, -100, 100.5, NaN, '100']) {
	const unmarked = { ...swallowed, nosPlayer: { speakerPositionX: 1000, speakerPositionY: 1000, addonData } };
	const atHiddenPosition = { ...state, nosLocalMicPosition: { x: 1000, y: 1000 } };
	assert.equal(voice({ state: atHiddenPosition, other: unmarked }).gain, 1,
		`coordinates never identify swallowing, including missing/other data (${addonData})`);
}
const released = { ...nearby, nosPlayer: { ...nearby.nosPlayer, addonData: 0 } };
assert.equal(voice({ other: released }).gain, 1, '100 -> 0 releases immediately');
assert.equal(voice({ other: nearby }).gain, 1, '0 -> 100 keeps the swallower audible without cached inference');
assert.equal(voice({ other: nearby, state: { ...state, nosAddonIds: [] } }).gain, 1, 'value belongs to UchuAddon');
for (const mod of ['NONE', 'SUPER_NEW_ROLES', 'TOH4E']) {
	assert.equal(voice({ other: nearby, state: { ...state, mod } }).gain, 1, 'value belongs to NoS');
}
assert.equal(voice({ other: { ...nearby, isDead: true }, me: { ...listener, isDead: true } }).gain, 1);
const unrelatedRadio = { state: { ...state, nosLocalMicPosition: { x: 1000, y: 1000 } },
	other: { ...swallowed, isImpostor: true, nosPlayer: { ...swallowed.nosPlayer, addonData: 0 } },
	activeLobbySettings: { ...lobby, impostorRadioEnabled: true, nosGluttonySwallowVoice: 'quiet' },
	impostorRadioClientId: 2, nosImpostorRadioHearable: true };
assert.equal(voice(unrelatedRadio).gain, 1, 'unrelated hidden-position role keeps normal radio, not Gluttony quiet mode');

assert.equal(voice().gain, 0, 'swallowed player is muted with NoS speaker positions disabled');
assert.equal(voice({ activeLobbySettings: { ...lobby, nosVoicePositions: true } }).gain, 0);
const quiet = voice({ activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'quiet' } });
assert.equal(quiet.gain, 0, 'quiet mode cannot bypass NoS published hearing distance');
assert.equal(voice({ activeLobbySettings: { ...lobby, nosGluttonySwallowVoice: 'normal' } }).gain, 0,
	'normal mode cannot bypass NoS published hearing distance');
assert.equal(voice({ activeLobbySettings: { maxDistance: 5.32, nosVoicePositions: false } }).gain, 0,
	'older lobby settings use the new default');

assert.equal(voice({ other: { ...swallowed, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0 } } }).gain, 1,
	'Gluttony owner and released players have an ordinary speaker position');
assert.equal(voice({ state: { ...state, nosAddonIds: [] } }).gain, 0,
	'hidden positions remain authoritative for every addon and role');
assert.equal(voice({ state: { ...state, gameState: 2 } }).gain, 1,
	'meeting uses ordinary living-player voice rules');
assert.equal(voice({ other: { ...swallowed, isDead: true, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0 } }, me: { ...listener, isDead: true } }).gain, 1,
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
assert.equal(megaphoneQuiet.gain, 0, 'megaphone quiet mode cannot bypass the NoS published position');

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
