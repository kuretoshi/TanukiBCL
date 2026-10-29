import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-portable-megaphone-'));
try {
	async function bundle(entry) {
		const result = await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', write: false });
		const file = join(directory, entry.split('/').at(-1).replace('.ts', '.mjs'));
		await writeFile(file, result.outputFiles[0].contents);
		return import(pathToFileURL(file));
	}
	const { readPortableMegaphoneState } = await bundle('src/main/portableMegaphoneState.ts');
	const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
	const { selectVoiceEffect } = await bundle('src/renderer/voice/voiceEffectRules.ts');
	const { GameState } = await bundle('src/common/AmongUsState.ts');
	const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
	const file = join(directory, 'state.json');
	const now = Date.now();
	const snapshot = { protocol: 1, pid: 123, unixMs: now, players: [{ playerId: 2, extraRange: 5 }] };
	async function read(data = snapshot, pid = 123, time = now) {
		await writeFile(file, JSON.stringify(data));
		return readPortableMegaphoneState(pid, time, file);
	}
	assert.deepEqual(await read(), snapshot.players);
	assert.deepEqual(await read(snapshot, 456), []);
	assert.deepEqual(await read(snapshot, 123, now + 501), []);
	assert.deepEqual(await read(snapshot, 123, now - 101), []);
	for (const players of [[{ playerId: 2, extraRange: -1 }], [{ playerId: 2, extraRange: 31 }], [...snapshot.players, ...snapshot.players]])
		assert.deepEqual(await read({ ...snapshot, players }), []);
	await writeFile(file, '{');
	assert.deepEqual(readPortableMegaphoneState(123, now, file), []);
	const other = { id: 2, x: 8, y: 0 };
	const me = { id: 1, x: 0, y: 0 };
	const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: GameState.TASKS, nosPortableMegaphones: snapshot.players };
	const input = { state, settings: { enableSpatialAudio: true }, activeLobbySettings: {}, me, other,
		maxDistance: defaultLobbySettings.maxDistance, impostorRadioClientId: -1 };
	const result = calculateVoiceAudio(input);
	assert.equal(result.gain, 1);
	assert.equal(result.panMaxDistance, 10.32); // Ordinary BCL default 5.32 + 5.
	assert.equal(calculateVoiceAudio({ ...input, other: { ...other, x: 10.33 } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, state: { ...state, nosPortableMegaphones: [] } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, maxDistance: 7 }).panMaxDistance, 12); // Follow host's BCL range.
	assert.equal(calculateVoiceAudio({ ...input, other: { ...other, id: 3 } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, other: { ...other, isDead: true } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, other: { ...other, nosPlayer: { isJammed: true } } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, activeLobbySettings: { deadOnly: true } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, activeLobbySettings: { commsSabotage: true }, state: { ...state, comsSabotaged: true } }).gain, 0);
	assert.equal(calculateVoiceAudio({ ...input, state: { ...state, gameState: GameState.DISCUSSION } }).panMaxDistance, null);
	assert.equal(calculateVoiceAudio({ ...input, state: { ...state, mod: 'NONE' } }).gain, 0);
	assert.equal(selectVoiceEffect(state, {}, {}, me, other, -1), null); // Amplifier has no laser distortion.
	console.log('Portable megaphone: default/custom range, OFF, stale identity, dead/meeting/jamming/comms restrictions and undistorted voice passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
