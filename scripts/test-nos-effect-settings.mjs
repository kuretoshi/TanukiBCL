import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const directory = resolve('.cache/nos-effect-settings-tests');
await mkdir(directory, { recursive: true });
async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
	const output = resolve(directory, entry.split('/').at(-1).replace(/\.tsx?$/, '.mjs'));
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
const state = { mod: 'NoS', gameState: 1, map: 0, players: [] };
const player = { id: 0, name: 'speaker', nosPlayer: { hat: { name: 'noshat_catudon_Citrus_Lemon' } } };
assert.deepEqual(selectVoiceEffect(state, { voiceEffectStrength: 0 }, defaultLobbySettings, { id: 1 }, player, -1), { strength: 100, direction: 'up' });
assert.equal(selectVoiceEffect(state, { voiceEffectStrength: 0 }, { ...defaultLobbySettings, nosCitrusVoiceEffect: false }, { id: 1 }, player, -1), null);
const rainbow = { ...player, nosRole: { isRainbowStar: true } };
assert.equal(shouldApplyRainbowStarEcho(state, rainbow, defaultLobbySettings), true);
assert.equal(shouldApplyRainbowStarEcho(state, rainbow, { ...defaultLobbySettings, nosRainbowStarEcho: false }), false);
const noOp = () => {};
function render(mod, nosAddonIds, active = false) {
	return renderToStaticMarkup(React.createElement(LobbySection, {
		t: (key) => key,
		gameState: { ...state, mod, nosAddonIds, lobbyCode: active ? 'ABCDEF' : 'MENU', isHost: false },
		activeLobbySettings: active ? defaultLobbySettings : null,
		myLobbySettings: defaultLobbySettings, hostId: 0, canEditMine: true,
		editDisabledReason: '', update: noOp, onRadioOnlyModeChange: noOp, confirm: noOp,
	}));
}
for (const active of [false, true]) {
	const visible = render('NoS', ['UchuAddon'], active);
	assert.ok(visible.includes('nos_fixer_jamming_lowpass'));
	for (const key of ['nos_berserker_voice_effect', 'nos_rokurokubi_voice_effect', 'nos_citrus_voice_effect', 'nos_rainbow_star_echo'])
		assert.ok(visible.includes(key), `${key} appears in ${active ? 'current' : 'mine'} settings`);
	for (const ids of [undefined, [], ['OtherAddon']]) {
		const hidden = render('NoS', ids, active);
		assert.ok(!hidden.includes('nos_citrus_voice_effect'));
		assert.ok(!hidden.includes('nos_rainbow_star_echo'));
		assert.ok(hidden.includes('nos_berserker_voice_effect'));
	}
	assert.ok(!render('TOH4E', ['UchuAddon'], active).includes('nos_citrus_voice_effect'));
}
assert.deepEqual(readNosAddonIds(resolve(directory, 'missing')), []);
// Optional local integration: recognition must survive a renamed release ZIP.
const release = resolve('.cache/nos-3.5.3.6/UchuAddon-1.3.7.zip');
try {
	await mkdir(resolve(directory, 'game/Addons'), { recursive: true });
	await copyFile(release, resolve(directory, 'game/Addons/unrelated-filename.zip'));
	assert.deepEqual(readNosAddonIds(resolve(directory, 'game')), ['UchuAddon']);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('PASS NoS effect settings: addon recognition, conditional UI in both tabs, and effect switches');
