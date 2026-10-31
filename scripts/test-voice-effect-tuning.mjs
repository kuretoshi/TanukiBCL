import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/common/VoiceEffectTuning.ts'], bundle: true,
	platform: 'node', format: 'esm', write: false,
});
const {
	voiceEffectDefinitions, normalizeVoiceEffectTuning, getVoiceEffectTuning,
	voicePitchRatio, combineVoiceEffectTunings, isNeutralVoiceEffectTuning,
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);

const neutral = { pitch: 0, reverb: 0, echo: 0 };
const ids = Object.keys(voiceEffectDefinitions);
assert.equal(ids.length, 11);
for (const id of ids) {
	const definition = voiceEffectDefinitions[id];
	const legacy = { [definition.strengthKey]: 37 };
	assert.deepEqual(getVoiceEffectTuning(legacy, id), {
		pitch: definition.pitchSign * 37,
		reverb: definition.reverb ? 37 : 0,
		echo: definition.echo ? 37 : 0,
	});
	assert.deepEqual(getVoiceEffectTuning({ [definition.strengthKey]: 0 }, id), neutral);
	assert.deepEqual(getVoiceEffectTuning({ ...legacy, voiceEffectTunings: { [id]: neutral } }, id), neutral);
}

// Changing one role/axis must leave the other roles and stored legacy values alone.
const settings = {
	voiceEffectStrength: 63, nosRainbowStarEchoStrength: 24,
	voiceEffectTunings: {
		disguise: { pitch: -26, reverb: 41, echo: 0 },
		nosRainbowStar: { pitch: 19, reverb: 72, echo: 33 },
	},
};
const original = structuredClone(settings);
assert.deepEqual(getVoiceEffectTuning(settings, 'disguise'), { pitch: -26, reverb: 41, echo: 0 });
assert.deepEqual(getVoiceEffectTuning(settings, 'nosRainbowStar'), { pitch: 19, reverb: 72, echo: 33 });
assert.deepEqual(getVoiceEffectTuning({ ...settings, voiceEffectTunings: {
	...settings.voiceEffectTunings, disguise: { ...settings.voiceEffectTunings.disguise, echo: 87 },
} }, 'nosRainbowStar'), settings.voiceEffectTunings.nosRainbowStar);
assert.deepEqual(settings, original);

const loaded = JSON.parse(JSON.stringify(settings));
for (const id of ids) assert.deepEqual(getVoiceEffectTuning(loaded, id), getVoiceEffectTuning(settings, id));
assert.deepEqual(normalizeVoiceEffectTuning({ pitch: -901, reverb: 150, echo: -4 }), { pitch: -100, reverb: 100, echo: 0 });
assert.deepEqual(normalizeVoiceEffectTuning({ pitch: Infinity, reverb: NaN, echo: '42' }), neutral);
assert.deepEqual(getVoiceEffectTuning({ nosRainbowStarEchoStrength: 28, voiceEffectTunings: {
	nosRainbowStar: { pitch: -12 },
} }, 'nosRainbowStar'), { pitch: -12, reverb: 28, echo: 0 });

assert.equal(voicePitchRatio(-100), 0.5);
assert.equal(voicePitchRatio(0), 1);
assert.equal(voicePitchRatio(100), 2);
assert.equal(voicePitchRatio(NaN), 1);
assert.equal(voicePitchRatio(999), 2);
for (const pitch of [-75, -25, 25, 75]) assert.ok(Math.abs(voicePitchRatio(pitch) * voicePitchRatio(-pitch) - 1) < 1e-12);

const a = { pitch: 100, reverb: 40, echo: 20 };
const b = { pitch: 100, reverb: 60, echo: 10 };
const c = { pitch: -100, reverb: 30, echo: 90 };
for (const profiles of [[a, b, c], [a, c, b], [c, b, a], [b, a, c]]) {
	assert.deepEqual(combineVoiceEffectTunings(profiles), { pitch: 100, reverb: 60, echo: 90 });
}
assert.deepEqual(combineVoiceEffectTunings([a, c]), { pitch: 0, reverb: 40, echo: 90 });
assert.deepEqual(combineVoiceEffectTunings([]), neutral);
assert.equal(isNeutralVoiceEffectTuning(neutral), true);
for (const axis of ['pitch', 'reverb', 'echo']) assert.equal(isNeutralVoiceEffectTuning({ ...neutral, [axis]: 1 }), false);
console.log('PASS voice tuning: 11 legacy presets, independent axes/roles, persistence, bounds, pitch symmetry and order-independent combined effects');
