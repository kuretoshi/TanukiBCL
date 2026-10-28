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
		? { nosRole: { roleName: 'busker' }, nosIsPseudocide: true }
		: { snrRole: { role: { name: 'Busker', value: 1 }, buskerPseudocideActive: true } };
	const field = mod === 'NoS' ? 'nosBuskerReviveHideVoice' : 'snrBuskerReviveHideVoice';
	const scenario = { state: { ...state, mod }, other: { ...busker, ...role } };
	assert.equal(run(scenario), 0, `${mod}: active Busker is hidden from a living impostor`);
	assert.ok(run({ ...scenario, activeLobbySettings: { ...lobby, [field]: false } }) > 0,
		`${mod}: disabled setting preserves ghost hearing`);
	const ended = mod === 'NoS'
		? { ...scenario.other, nosIsPseudocide: false }
		: { ...scenario.other, snrRole: { ...role.snrRole, buskerPseudocideActive: false } };
	assert.ok(run({ ...scenario, other: ended }) > 0,
		`${mod}: ending fake death restores ordinary ghost hearing`);
	assert.equal(run({ ...scenario, me: { ...me, isDead: true } }), 0,
		`${mod}: dead impostors are also unable to hear`);
	assert.ok(run({ ...scenario, me: { ...me, isDead: true, isImpostor: false } }) > 0,
		`${mod}: crewmate ghost listeners are unaffected`);
	assert.equal(run({ ...scenario, state: { ...state, mod, gameState: 2 } }), 0,
		`${mod}: meetings follow existing living versus ghost rules`);
}
const nos = { state: { ...state, mod: 'NoS' }, other: { ...busker,
	nosRole: { roleName: 'busker' } } };
const snr = { other: { ...busker,
	snrRole: { role: { name: 'Busker', value: 1 } } } };
assert.ok(run({ ...snr, other: { ...snr.other,
	snrRole: { ...snr.other.snrRole, buskerPseudocideActive: false } } }) > 0,
	'SNR: inactive ability leaves ordinary ghost hearing active');
assert.ok(run({ ...snr }) > 0,
	'SNR: missing ability state does not hide the voice');
assert.equal(run({ ...snr, other: { ...snr.other, isDead: false,
	snrRole: { ...snr.other.snrRole, buskerPseudocideActive: true } } }), 0,
	'SNR: active ability hides fake death independent of the death flag');
assert.ok(run({ ...nos, other: { ...nos.other, nosIsPseudocide: false } }) > 0,
	'NoS: published false leaves ordinary ghost hearing active');
assert.ok(run({ ...nos }) > 0,
	'NoS: missing fake-death state does not hide the voice');
assert.equal(run({ ...nos, other: { ...nos.other, isDead: false, nosIsPseudocide: true,
	nosRole: { roleName: 'busker' } } }), 0,
	'NoS: published true hides fake death independent of the death flag');
console.log('PASS Busker revive voice restriction for SNR and NoS');
