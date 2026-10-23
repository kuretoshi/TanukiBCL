import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
	const output = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
	return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString('base64')}`);
}
const { calculateVoiceAudio } = await load('src/renderer/voice/spatialAudio.ts');
const { reverbLevels, createReverbMix, connectReverbMix } = await load('src/renderer/voice/reverbMix.ts');
const { defaultLobbySettings } = await load('src/common/defaultLobbySettings.ts');
const me = { id: 1, clientId: 1, x: -15, y: -9, isDead: false, isLocal: true };
const other = { id: 2, clientId: 2, x: -14, y: -9, isDead: true, snrPushedFalling: true };
const state = { mod: 'SUPER_NEW_ROLES', gameState: 1, map: 4, currentCamera: 7, closedDoors: [], players: [me, other] };
const input = {
	state,
	me,
	other,
	maxDistance: 5.32,
	impostorRadioClientId: -1,
	settings: { enableSpatialAudio: true, ghostVolumeAsImpostor: 40, snrPushReverbStrength: 100 },
	activeLobbySettings: { ...defaultLobbySettings },
};
const on = calculateVoiceAudio(input);
assert.equal(on.reverb, true);
assert.ok(on.gain > 0);
const off = calculateVoiceAudio({
	...input,
	activeLobbySettings: { ...input.activeLobbySettings, snrPushReverb: false },
});
assert.equal(off.reverb, false);
assert.equal(off.gain, on.gain, 'disabling reverb must not mute falling speech');
const legacyLobby = { ...input.activeLobbySettings };
delete legacyLobby.snrPushReverb;
assert.equal(calculateVoiceAudio({ ...input, activeLobbySettings: legacyLobby }).reverb, true);
for (const strength of [0, 25, 50, 100]) {
	const result = calculateVoiceAudio({ ...input, settings: { ...input.settings, snrPushReverbStrength: strength } });
	assert.equal(result.reverbStrength, strength);
	assert.equal(result.gain, on.gain);
	assert.deepEqual(reverbLevels(strength), { dry: 1 - strength / 100, wet: strength / 100 });
}
assert.deepEqual(reverbLevels(), { dry: 0, wet: 1 });
assert.deepEqual(reverbLevels(NaN), { dry: 0, wet: 1 });
assert.deepEqual(reverbLevels(-5), { dry: 1, wet: 0 });
assert.deepEqual(reverbLevels(200), { dry: 0, wet: 1 });
const meeting = calculateVoiceAudio({ ...input, state: { ...state, gameState: 2 } });
assert.equal(meeting.reverb, false);
assert.equal(meeting.reverbStrength, undefined);
const ghost = calculateVoiceAudio({
	...input,
	me: { ...me, isImpostor: true },
	other: { ...other, snrPushedFalling: false },
	activeLobbySettings: { ...input.activeLobbySettings, haunting: true, snrPushReverb: false },
	settings: { ...input.settings, snrPushReverbStrength: 0 },
});
assert.equal(ghost.reverb, true, 'ordinary ghost reverb is unaffected');
assert.equal(ghost.reverbStrength, undefined);
const node = () => ({
	targets: [],
	gain: { value: 1 },
	connect(target) {
		this.targets.push(target);
	},
});
const mix = createReverbMix({ createGain: node });
const source = node(),
	convolver = node();
assert.equal(connectReverbMix(source, convolver, mix), mix.output);
assert.deepEqual(source.targets, [convolver, mix.dry]);
assert.deepEqual(convolver.targets, [mix.wet]);
assert.deepEqual(mix.dry.targets, [mix.output]);
assert.deepEqual(mix.wet.targets, [mix.output]);
console.log(
	'PASS SNR push reverb: host toggle, local mix, legacy defaults, speech preservation, meeting reset, ghost isolation, audio routing'
);
