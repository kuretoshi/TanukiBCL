import assert from 'node:assert/strict';
import { build } from 'esbuild';

const output = await build({ entryPoints: ['src/renderer/voice/spatialAudio.ts'], bundle: true, write: false,
	platform: 'node', format: 'esm' });
const { calculateVoiceAudio } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
const me = { id: 1, clientId: 1, x: 0, y: 0, isDead: false, isImpostor: true, isLocal: true };
const busker = { id: 2, clientId: 2, x: 1, y: 0, isDead: true, isImpostor: false };
const settings = { enableSpatialAudio: true, ghostVolumeAsImpostor: 50 };
const state = { mod: 'SUPER_NEW_ROLES', gameState: 1, map: 0, currentCamera: 0, closedDoors: [] };
const lobby = { maxDistance: 5.32, haunting: true, snrBuskerReviveHideVoice: true,
	nosBuskerReviveHideVoice: true, wallsBlockAudio: false };
const run = (changes = {}) => calculateVoiceAudio({ state, me, other: busker, settings,
	activeLobbySettings: lobby, maxDistance: 5.32, impostorRadioClientId: -1, ...changes }).gain;

for (const mod of ['SUPER_NEW_ROLES', 'NoS']) {
	const role = mod === 'NoS'
		? { nosRole: { roleName: 'busker', buskerReviveRemaining: 5 } }
		: { snrRole: { role: { name: 'Busker', value: 1 }, buskerReviveRemaining: 5 } };
	const field = mod === 'NoS' ? 'nosBuskerReviveHideVoice' : 'snrBuskerReviveHideVoice';
	const scenario = { state: { ...state, mod }, other: { ...busker, ...role } };
	assert.equal(run(scenario), 0, `${mod}: active Busker is hidden from a living impostor`);
	assert.ok(run({ ...scenario, activeLobbySettings: { ...lobby, [field]: false } }) > 0,
		`${mod}: disabled setting preserves ghost hearing`);
	assert.ok(run({ ...scenario, other: { ...scenario.other, [mod === 'NoS' ? 'nosRole' : 'snrRole']:
		{ ...role[mod === 'NoS' ? 'nosRole' : 'snrRole'], buskerReviveRemaining: 0 } } }) > 0,
		`${mod}: timer expiry restores ordinary ghost hearing`);
	assert.equal(run({ ...scenario, me: { ...me, isDead: true } }), 0,
		`${mod}: dead impostors are also unable to hear`);
	assert.ok(run({ ...scenario, me: { ...me, isDead: true, isImpostor: false } }) > 0,
		`${mod}: crewmate ghost listeners are unaffected`);
	assert.equal(run({ ...scenario, state: { ...state, mod, gameState: 2 } }), 0,
		`${mod}: meetings follow existing living versus ghost rules`);
}
console.log('PASS Busker revive voice restriction for SNR and NoS');
