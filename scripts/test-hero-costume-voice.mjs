import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-hero-costume-'));
async function load(path, name) {
	const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
	const output = join(directory, `${name}.mjs`);
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
try {
	const commonRoot = process.env.TANUKI_HERO_COMMON ?? 'src/common';
	const rules = process.env.TANUKI_HERO_RULES ?? 'src/renderer/voice/voiceEffectRules.ts';
	const { GameState } = await load(`${commonRoot}/AmongUsState.ts`, 'states');
	const { validHeroTransform, isHeroTransformed } = await load(`${commonRoot}/HeroTransformState.ts`, 'policy');
	const { selectVoiceEffect } = await load(rules, 'effects');
	const { readHeroTransformState } = await load('src/main/heroTransformState.ts', 'reader');
	const me = { id: 1, name: 'listener' };
	const speaker = { id: 2, name: 'original', appearanceName: 'transformed' };
	const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: GameState.TASKS, players: [me, speaker] };
	const select = (game = state, other = speaker) =>
		selectVoiceEffect(game, { voiceEffectStrength: 100 }, { voiceEffectEnabled: true }, me, other, -1);
	assert.deepEqual(
		select(),
		{ id: 'disguise', tuning: { pitch: -100, reverb: 0, echo: 0 } },
		'ordinary disguise retains its effect'
	);
	for (const kind of ['super', 'evil']) {
		const entry = { playerId: 2, kind };
		assert(validHeroTransform(entry));
		const transformed = { ...state, nosHeroTransforms: [entry] };
		assert(isHeroTransformed(transformed, 2));
		assert.equal(select(transformed), null, `${kind} costume keeps normal voice`);
		assert.equal(select({ ...transformed, nosHeroTransforms: [] }).id, 'disguise', 'end clears exemption');
		assert.equal(select({ ...transformed, nosHeroTransforms: [{ playerId: 3, kind }] }).id, 'disguise');
	}
	for (const invalid of [null, {}, { playerId: 256, kind: 'super' }, { playerId: 2, kind: 'other' }])
		assert(!validHeroTransform(invalid));
	for (const gameState of [GameState.MENU, GameState.LOBBY, GameState.DISCUSSION])
		assert(!isHeroTransformed({ ...state, gameState, nosHeroTransforms: [{ playerId: 2, kind: 'super' }] }, 2));
	assert(!isHeroTransformed({ ...state, mod: 'NONE', nosHeroTransforms: [{ playerId: 2, kind: 'super' }] }, 2));
	assert(!isHeroTransformed({ ...state, nosHeroTransforms: {} }, 2));
	assert.deepEqual(
		select({
			...state,
			gameState: GameState.DISCUSSION,
			nosHeroTransforms: [{ playerId: 2, kind: 'super' }],
			nosVoiceJamming: [{ playerId: 2, muted: false, lowpass: false, pitch: 1.5 }],
		}),
		{ id: 'nosVoiceJamming', tuning: { pitch: -100, reverb: 0, echo: 0 } }
	);
	const path = join(directory, 'transforms.json');
	const envelope = { protocol: 1, pid: 123, unixMs: 10000, players: [{ playerId: 2, kind: 'super' }] };
	await writeFile(path, JSON.stringify(envelope));
	assert.deepEqual(readHeroTransformState(123, 10000, path), envelope.players);
	assert.deepEqual(readHeroTransformState(124, 10000, path), [], 'separate game process');
	assert.deepEqual(readHeroTransformState(123, 11001, path), [], 'lost heartbeat expires');
	assert.deepEqual(readHeroTransformState(123, 9800, path), [], 'future heartbeat rejected');
	for (const data of [
		null,
		{ ...envelope, protocol: 2 },
		{ ...envelope, players: [envelope.players[0], envelope.players[0]] },
		{ ...envelope, players: [{ playerId: 2, kind: 'other' }] },
		{ ...envelope, players: [] },
	]) {
		await writeFile(path, JSON.stringify(data));
		assert.deepEqual(readHeroTransformState(123, 10000, path), []);
	}
	console.log(
		'PASS Hero costumes: both transformations preserve normal voice; ordinary disguise and Jamminger retained; PID/heartbeat/cleanup guards'
	);
	if (process.env.TANUKI_HERO_LIVE_PID) {
		const live = readHeroTransformState(Number(process.env.TANUKI_HERO_LIVE_PID));
		assert(live.length > 0, 'live NoS must currently have an active transformation');
		assert.equal(select({ ...state, nosHeroTransforms: live }, { ...speaker, id: live[0].playerId }), null);
		console.log('PASS live NoS transformation -> desktop state reader -> normal voice policy');
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
