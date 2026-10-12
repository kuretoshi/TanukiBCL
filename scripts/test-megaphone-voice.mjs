import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-megaphone-'));
try {
	async function bundle(entry) {
		const result = await build({
			entryPoints: [resolve(entry)],
			bundle: true,
			platform: 'node',
			format: 'esm',
			write: false,
		});
		const file = join(directory, entry.split('/').at(-1).replace('.ts', '.mjs'));
		await writeFile(file, result.outputFiles[0].contents);
		return import(pathToFileURL(file));
	}
	const { readMegaphoneState } = await bundle('src/main/megaphoneState.ts');
	const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
	const { selectVoiceEffect } = await bundle('src/renderer/voice/voiceEffectRules.ts');
	const { GameState } = await bundle('src/common/AmongUsState.ts');
	const file = join(directory, 'state.json');
	const now = Date.now();
	const snapshot = { protocol: 1, pid: 123, unixMs: now, players: [{ playerId: 2, energy: 0.5, range: 11 }] };
	async function read(data = snapshot, pid = 123, time = now) {
		await writeFile(file, JSON.stringify(data));
		return readMegaphoneState(pid, time, file);
	}
	assert.deepEqual(await read(), snapshot.players);
	const recordingState = { ...snapshot, players: [{ ...snapshot.players[0], phase: 'charging', shotId: 1 }] };
	assert.deepEqual(await read(recordingState), recordingState.players);
	assert.deepEqual(await read({ ...snapshot, players: [{ ...snapshot.players[0], phase: 'firing' }] }), []);
	assert.deepEqual(await read({ ...snapshot, players: [{ ...snapshot.players[0], phase: 'bad', shotId: 1 }] }), []);
	assert.deepEqual(await read(snapshot, 456), []);
	assert.deepEqual(await read(snapshot, 123, now + 501), []);
	assert.deepEqual(await read(snapshot, 123, now - 101), []);
	for (const players of [
		[{ playerId: 2, energy: 2, range: 11 }],
		[{ playerId: 2, energy: 0.5, range: 100 }],
		[...snapshot.players, ...snapshot.players],
	])
		assert.deepEqual(await read({ ...snapshot, players }), []);
	await writeFile(file, '{');
	assert.deepEqual(readMegaphoneState(123, now, file), []);
	const speaker = { id: 2, x: 8, y: 0 };
	const me = { id: 1, x: 0, y: 0 };
	const state = { mod: 'NoS', gameState: GameState.TASKS, nosMegaphones: snapshot.players };
	const input = {
		state,
		settings: {},
		activeLobbySettings: {},
		me,
		other: speaker,
		maxDistance: 2,
		impostorRadioClientId: -1,
	};
	assert.equal(calculateVoiceAudio(input).gain, 1); // audible beyond ordinary range
	assert.equal(calculateVoiceAudio({ ...input, other: { ...speaker, x: 10 } }).gain, 0.5);
	assert.equal(calculateVoiceAudio({ ...input, other: { ...speaker, x: 12 } }).gain, 0);
	assert.equal(
		calculateVoiceAudio({ ...input, state: { ...state, nosMegaphones: [{ playerId: 2, energy: 0, range: 2 }] } }).gain,
		0
	);
	assert.equal(calculateVoiceAudio({ ...input, other: { ...speaker, nosPlayer: { isJammed: true } } }).gain, 0);
	const select = (game = state, other = speaker) => selectVoiceEffect(game, {}, {}, me, other, -1);
	assert.ok(select().sourceFilter);
	const unprocessed = { ...state, nosMegaphones: snapshot.players.map((entry) => ({ ...entry, voiceEffect: false })) };
	assert.equal(select(unprocessed), null);
	assert.equal(calculateVoiceAudio({ ...input, state: unprocessed }).gain, 1);
	assert.deepEqual(await read({ ...snapshot, players: unprocessed.nosMegaphones }), unprocessed.nosMegaphones);
	assert.deepEqual(await read({ ...snapshot, players: [{ ...snapshot.players[0], voiceEffect: 'false' }] }), []);
	assert.equal(select({ ...state, nosMegaphones: [] }), null);
	assert.equal(select({ ...state, gameState: GameState.DISCUSSION }), null);
	assert.equal(select({ ...state, mod: 'NONE' }), null);
	assert.equal(select(state, { ...speaker, isDead: true }), null);
	console.log('Megaphone snapshot freshness, identity, expanding range, jamming and effect cleanup checks passed.');
} finally {
	await rm(directory, { recursive: true, force: true });
}
