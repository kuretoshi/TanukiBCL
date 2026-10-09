import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve('.cache/nos-citrus-tests');
await mkdir(directory, { recursive: true });
async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	const output = resolve(directory, entry.split('/').at(-1).replace('.ts', '.mjs'));
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { selectVoiceEffect } = await bundle('src/renderer/voice/voiceEffectRules.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const state = { gameState: GameState.TASKS, mod: 'NoS', map: 4 };
const listener = { id: 1, isDead: false };
const speaker = { id: 0, name: 'レモン', nosPlayer: { hat: { name: 'noshat_catudon_Citrus_Lemon' } } };
const select = (player = speaker, game = state, me = listener) =>
	selectVoiceEffect(game, { voiceEffectStrength: 0 }, { voiceEffectEnabled: false }, me, player, -1);
const expected = { strength: 100, direction: 'up' };
for (const hat of ['noshat_catudon_Citrus_Orange', 'noshat_catudon_Citrus_Lemon']) {
	const player = { ...speaker, nosPlayer: { hat: { name: hat }, bodyType: 0 } };
	assert.deepEqual(select(player), expected);
	assert.deepEqual(select(player, { ...state, gameState: GameState.DISCUSSION }), expected);
	assert.deepEqual(select(player, { ...state, airshipMeetingByOutfit: true }), expected);
	assert.deepEqual(select(player, state, { ...listener, isDead: true }), expected);
}
for (const gameState of [GameState.MENU, GameState.LOBBY])
	assert.equal(select(speaker, { ...state, gameState }), null);
for (const mod of ['NONE', 'TOH4E', 'SUPER_NEW_ROLES']) assert.equal(select(speaker, { ...state, mod }), null);
for (const flag of ['isDead', 'disconnected', 'bugged', 'isDummy'])
	assert.equal(select({ ...speaker, [flag]: true }), null);
// Infection before the outfit changes, restored outfits, and similar IDs stay normal.
for (const hat of [undefined, '', 'noshat_Lucia_ぽんぽこたぬき', 'noshat_catudon_Citrus_Lemon_fake'])
	assert.equal(select({ ...speaker, nosPlayer: { hat: { name: hat } } }), null);
assert.equal(select({ ...speaker, nosPlayer: undefined }), null);
// Other ability effects still stop during meetings.
assert.equal(select({ ...speaker, nosPlayer: { bodyType: 3, neckLength: 40 } },
	{ ...state, gameState: GameState.DISCUSSION }), null);
console.log('NoS Citrus: transformed outfits stay disguised in tasks and meetings; reset and guard checks passed');
