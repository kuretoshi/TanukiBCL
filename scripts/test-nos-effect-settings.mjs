import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import console from 'node:console';

const directory = resolve('.cache/nos-effect-settings-tests');
await mkdir(directory, { recursive: true });
async function bundle(entry) {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		packages: 'external',
		platform: 'node',
		format: 'esm',
		write: false,
	});
	const output = resolve(
		directory,
		entry
			.split('/')
			.at(-1)
			.replace(/\.tsx?$/, '.mjs')
	);
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { readNosAddonIds } = await bundle('src/main/nosAddonImages.ts');
const { selectVoiceEffect, shouldApplyRainbowStarEcho } = await bundle('src/renderer/voice/voiceEffectRules.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const { changeNosFixerMode } = await bundle('src/common/NosFixerSettings.ts');
let fixerSettings = { ...defaultLobbySettings, ...changeNosFixerMode('lowpass', true) };
assert.equal(fixerSettings.nosFixerJammingLowpass, true);
assert.equal(fixerSettings.nosFixerJammingVoiceBlock, false);
fixerSettings = { ...fixerSettings, ...changeNosFixerMode('block', true) };
assert.equal(fixerSettings.nosFixerJammingLowpass, false);
assert.equal(fixerSettings.nosFixerJammingVoiceBlock, true);
fixerSettings = { ...fixerSettings, ...changeNosFixerMode('block', false) };
assert.equal(fixerSettings.nosFixerJammingLowpass, false);
assert.equal(fixerSettings.nosFixerJammingVoiceBlock, false);
const { default: LobbySection } = await bundle('src/renderer/settings/sections/LobbySection.tsx');
const { default: VoiceEffectsSection } = await bundle('src/renderer/settings/sections/VoiceEffectsSection.tsx');
const state = { mod: 'NoS', gameState: 1, map: 0, players: [] };
const player = { id: 0, name: 'speaker', nosPlayer: { hat: { name: 'noshat_catudon_Citrus_Lemon' } } };
assert.deepEqual(selectVoiceEffect(state, { voiceEffectStrength: 0 }, defaultLobbySettings, { id: 1 }, player, -1), {
	id: 'nosCitrus',
	tuning: { pitch: 100, reverb: 0, echo: 0 },
});
assert.deepEqual(
	selectVoiceEffect(
		state,
		{ voiceEffectStrength: 0, nosCitrusVoiceEffectStrength: 35 },
		{ ...defaultLobbySettings, nosCitrusVoiceEffectStrength: 0 },
		{ id: 1 },
		player,
		-1
	),
	{ id: 'nosCitrus', tuning: { pitch: 35, reverb: 0, echo: 0 } }
);
assert.equal(
	selectVoiceEffect(
		state,
		{ voiceEffectStrength: 0, nosCitrusVoiceEffectStrength: 0 },
		defaultLobbySettings,
		{ id: 1 },
		player,
		-1
	),
	null
);
assert.equal(
	selectVoiceEffect(
		state,
		{ voiceEffectStrength: 0 },
		{ ...defaultLobbySettings, nosCitrusVoiceEffect: false },
		{ id: 1 },
		player,
		-1
	),
	null
);
const rainbow = { ...player, nosRole: { isRainbowStar: true } };
assert.equal(shouldApplyRainbowStarEcho(state, rainbow, defaultLobbySettings), true);
assert.equal(shouldApplyRainbowStarEcho(state, rainbow, { ...defaultLobbySettings, nosRainbowStarEcho: false }), false);
assert.equal(
	shouldApplyRainbowStarEcho(state, rainbow, defaultLobbySettings, { nosRainbowStarEchoStrength: 0 }),
	false
);
const sizePlayer = { id: 2, name: 'size', nosPlayer: { bodyRateX: 1, bodyRateY: 2 } };
const fullSize = selectVoiceEffect(state, { voiceEffectStrength: 0 }, defaultLobbySettings, { id: 1 }, sizePlayer, -1);
const halfSize = selectVoiceEffect(
	state,
	{ voiceEffectStrength: 0, nosSizeVoiceEffectStrength: 50 },
	{ ...defaultLobbySettings, nosSizeVoiceEffectStrength: 0 },
	{ id: 1 },
	sizePlayer,
	-1
);
assert.equal(fullSize.id, 'nosSize');
assert.equal(halfSize.tuning.pitch, fullSize.tuning.pitch / 2);
assert.equal(
	selectVoiceEffect(
		state,
		{ voiceEffectStrength: 0, nosSizeVoiceEffectStrength: 0 },
		defaultLobbySettings,
		{ id: 1 },
		sizePlayer,
		-1
	),
	null
);
const berserker = { id: 3, name: 'berserker', nosRole: { roleName: 'berserker' }, nosPlayer: { bodyType: 2 } };
assert.deepEqual(
	selectVoiceEffect(
		state,
		{ voiceEffectStrength: 0, nosBerserkerVoiceEffectStrength: 40 },
		{ ...defaultLobbySettings, nosBerserkerVoiceEffectStrength: 0 },
		{ id: 1 },
		berserker,
		-1
	),
	{ id: 'nosBerserker', tuning: { pitch: 0, reverb: 40, echo: 40 } }
);
const noOp = () => {};
function render(mod, nosAddonIds, active = false) {
	return renderToStaticMarkup(
		React.createElement(LobbySection, {
			t: (key) => key,
			gameState: { ...state, mod, nosAddonIds, lobbyCode: active ? 'ABCDEF' : 'MENU', isHost: false },
			activeLobbySettings: active ? defaultLobbySettings : null,
			myLobbySettings: defaultLobbySettings,
			hostId: 0,
			canEditMine: true,
			editDisabledReason: '',
			update: noOp,
			onRadioOnlyModeChange: noOp,
			confirm: noOp,
		})
	);
}
function renderEffects(mod, nosAddonIds, active = false) {
	return renderToStaticMarkup(
		React.createElement(VoiceEffectsSection, {
			t: (key) => key,
			settings: { voiceEffectStrength: 100, microphone: 'default', speaker: 'default' },
			setSettings: noOp,
			gameState: { ...state, mod, nosAddonIds, lobbyCode: active ? 'ABCDEF' : 'MENU', isHost: !active },
		})
	);
}
for (const active of [false, true]) {
	const visible = renderEffects('NoS', ['UchuAddon', 'tanuki.bcl.roles'], active);
	const lobby = render('NoS', ['UchuAddon'], active);
	for (const key of [
		'nos_fixer_jamming_lowpass',
		'nos_berserker_voice_effect',
		'nos_rokurokubi_voice_effect',
		'nos_citrus_voice_effect',
		'nos_rainbow_star_echo',
	])
		assert.ok(lobby.includes(key), `${key} appears in the lobby settings`);
	assert.ok(!lobby.includes('nos_voice_effects'));
	for (const key of [
		'nos_voice_effects',
		'nos_berserker_strength',
		'nos_rokurokubi_strength',
		'nos_citrus_strength',
		'nos_rainbow_star_strength',
		'nos_voice_jamming_effect',
		'nos_megaphone_effect',
		'nos_bibiri_echo',
		'preview_target',
	])
		assert.ok(visible.includes(key), `${key} appears in personal settings`);
	assert.ok(renderEffects('SUPER_NEW_ROLES', [], active).includes('snr_voice_effects'));
	assert.ok(render('SUPER_NEW_ROLES', [], active).includes('snr_jumbo_voice'));
	assert.ok(!renderEffects('SUPER_NEW_ROLES', [], active).includes('nos_voice_effects'));
	assert.ok(!renderEffects('NoS', [], active).includes('snr_voice_effects'));
	assert.ok(!renderEffects('TOH4E', [], active).includes('nos_voice_effects'));
	assert.ok(!renderEffects('TOH4E', [], active).includes('snr_voice_effects'));
	for (const ids of [undefined, [], ['OtherAddon']]) {
		const hidden = renderEffects('NoS', ids, active);
		assert.ok(!hidden.includes('nos_citrus_strength'));
		assert.ok(!hidden.includes('nos_rainbow_star_strength'));
		for (const key of ['nos_voice_jamming_effect', 'nos_megaphone_effect', 'nos_bibiri_echo'])
			assert.ok(!hidden.includes(key), `${key} is hidden without the Tanuki addon`);
		assert.ok(hidden.includes('nos_berserker_strength'));
	}
	const tanukiOnly = renderEffects('NoS', ['tanuki.bcl.roles'], active);
	for (const key of ['nos_voice_jamming_effect', 'nos_megaphone_effect', 'nos_bibiri_echo'])
		assert.ok(tanukiOnly.includes(key), `${key} appears with the Tanuki addon`);
	assert.ok(!tanukiOnly.includes('nos_citrus_strength'));
	assert.ok(!renderEffects('TOH4E', ['UchuAddon'], active).includes('nos_citrus_strength'));
}
assert.deepEqual(readNosAddonIds(resolve(directory, 'missing')), []);
// Optional local integration: recognition must survive a renamed release ZIP.
const release = resolve('.cache/nos-3.5.3.6/UchuAddon-1.3.7.zip');
try {
	await mkdir(resolve(directory, 'game/Addons'), { recursive: true });
	await copyFile(release, resolve(directory, 'game/Addons/unrelated-filename.zip'));
	assert.deepEqual(readNosAddonIds(resolve(directory, 'game')), ['UchuAddon']);
} catch (error) {
	if (error.code !== 'ENOENT') throw error;
}
console.log('PASS NoS effect settings: local strengths, addon recognition, conditional UI, and effect switches');
