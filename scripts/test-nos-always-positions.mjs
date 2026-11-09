import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
	entryPoints: ['src/renderer/voice/spatialAudio.ts'], bundle: true,
	platform: 'node', format: 'esm', write: false,
});
const { calculateVoiceAudio } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const base = {
	state: { mod: 'NoS', gameState: 1, map: -1, currentCamera: -1, closedDoors: [], nosLocalMicPosition: { x: 20, y: 4 } },
	me: { id: 1, clientId: 1, x: 0, y: 0, isDead: false, isImpostor: false },
	other: { id: 2, clientId: 2, x: 100, y: 100, isDead: false, isImpostor: false, nosPlayer: { speakerPositionX: 21, speakerPositionY: 6 } },
	settings: { enableSpatialAudio: true }, activeLobbySettings: { maxDistance: 5 },
	maxDistance: 5, impostorRadioClientId: -1,
};
let checks = 0;
function check(actual, expected, description) { assert.deepEqual(actual, expected, description); checks++; }
const run = changes => calculateVoiceAudio({ ...base, ...changes });
for (const flag of [undefined, false, true]) {
	const activeLobbySettings = { ...base.activeLobbySettings, ...(flag === undefined ? {} : { nosVoicePositions: flag }) };
	check(run({ activeLobbySettings }).panPosition, [1, 2], 'all NoS roles use both published coordinates regardless of saved flag');
	check(run({ activeLobbySettings }).gain, 1, 'physical body distance does not override published positions');
}
check(run({ state: { ...base.state, nosLocalMicPosition: { x: 0, y: 0 } }, other: { ...base.other, nosPlayer: { speakerPositionX: 0, speakerPositionY: 0 } } }).panPosition, [0, 0], 'zero coordinates are valid');
check(run({ other: { ...base.other, x: 21, y: 6, nosPlayer: undefined } }).panPosition, [1, 2], 'missing remote publication falls back to its physical position');
check(run({ state: { ...base.state, nosLocalMicPosition: undefined }, me: { ...base.me, x: 20, y: 4 } }).panPosition, [1, 2], 'missing local publication falls back to its physical position');
for (const bad of [NaN, Infinity]) {
	check(run({ other: { ...base.other, x: 21, y: 6, nosPlayer: { speakerPositionX: bad, speakerPositionY: 6 } } }).panPosition, [1, 2], 'invalid remote coordinates use the physical position');
	check(run({ state: { ...base.state, nosLocalMicPosition: { x: bad, y: 4 } }, me: { ...base.me, x: 20, y: 4 } }).panPosition, [1, 2], 'invalid local coordinates use the physical position');
}
for (const mod of ['NONE', 'SUPER_NEW_ROLES', 'TOH4E']) {
	check(run({ state: { ...base.state, mod } }).gain, 0, 'NoS coordinates never affect another mod');
}
for (const mode of ['quiet', 'normal']) {
	check(run({ state: { ...base.state, nosAddonIds: ['UchuAddon'] }, other: { ...base.other, x: 21, y: 6, nosPlayer: { speakerPositionX: 1000, speakerPositionY: 1000 } }, activeLobbySettings: { ...base.activeLobbySettings, nosGluttonySwallowVoice: mode } }).gain, 0, 'legacy swallow settings never bypass the published hidden position');
}
check(run({ state: { ...base.state, gameState: 2 } }).panPosition, [0, 0], 'meetings stay centered');
check(run({ other: { ...base.other, disconnected: true } }).gain, 0, 'disconnect still blocks voice');
check(run({ settings: { enableSpatialAudio: false } }).gain, 1, 'directional audio OFF still uses NoS hearing coordinates');
check(run({ settings: { enableSpatialAudio: false } }).panPosition, [0, 0], 'directional audio OFF only centers the sound');
check(run({ me: { ...base.me, x: 20, y: 4 }, other: { ...base.other, x: 21, y: 6 }, rokuroBodyOrigin: true }).panPosition, [1, 2], 'additional Rokuro body source retains its physical origin and published listener');
const before = JSON.stringify(base); run({}); check(JSON.stringify(base), before, 'input snapshots remain untouched');
console.log(`PASS mandatory NoS voice positions: ${checks} checks`);
