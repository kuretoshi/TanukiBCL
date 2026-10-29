import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-jamminger-'));
const common = process.env.TANUKI_JAM_COMMON ?? 'src/common/VoiceJammingState.ts';
const rules = process.env.TANUKI_JAM_RULES ?? 'src/renderer/voice/voiceEffectRules.ts';
async function load(path, name) {
	const bundle = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
	const output = join(directory, `${name}.mjs`);
	await writeFile(output, bundle.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
try {
	const { validVoiceJamming, voiceJammingFor, applyVoiceJamming } = await load(common, 'policy');
	const { selectVoiceEffect } = await load(rules, 'effects');
	const { readVoiceJammingState } = await load('src/main/voiceJammingState.ts', 'reader');
	const entry = { playerId: 2, muted: true, lowpass: false, pitch: 1.5 };
	const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: 3, nosVoiceJamming: [entry] }; // DISCUSSION
	const { GameState } = await load('src/common/AmongUsState.ts', 'states');
	state.gameState = GameState.DISCUSSION;
	assert(validVoiceJamming(entry));
	for (const invalid of [
		null,
		{ ...entry, muted: 'true' },
		{ ...entry, playerId: 256 },
		{ ...entry, lowpass: 1 },
		{ ...entry, pitch: NaN },
		{ ...entry, pitch: 3 },
	])
		assert(!validVoiceJamming(invalid));
	assert.equal(voiceJammingFor(state, 2).muted, true);
	assert.equal(voiceJammingFor(state, 1), undefined, 'only the target is force-muted');
	for (const gameState of [GameState.TASKS, GameState.LOBBY, GameState.MENU])
		assert.equal(voiceJammingFor({ ...state, gameState }, 2), undefined, 'meeting end always releases the effect');
	assert.equal(voiceJammingFor({ ...state, mod: 'NONE' }, 2), undefined);
	assert.equal(voiceJammingFor({ ...state, nosVoiceJamming: {} }, 2), undefined);
	const muted = { gain: 1, muffle: false };
	applyVoiceJamming(state, 2, muted);
	assert.equal(muted.gain, 0, 'receive-side gain enforces forced mute');
	const filtered = { gain: 0.7, muffle: false };
	applyVoiceJamming({ ...state, nosVoiceJamming: [{ ...entry, muted: false, lowpass: true }] }, 2, filtered);
	assert.equal(filtered.gain, 0.7, 'low-pass keeps ordinary voice volume');
	assert.equal(filtered.muffle.frequency, 1200);
	const untouched = { gain: 0, muffle: false };
	applyVoiceJamming(state, 1, untouched);
	assert.equal(untouched.gain, 0, 'jamming never unmutes an otherwise inaudible voice');
	assert.equal(selectVoiceEffect(state, {}, {}, {}, { id: 2 }, 0).sourceFilter.pitch, 1.5);
	assert.equal(selectVoiceEffect(state, {}, {}, {}, { id: 2, disconnected: true }, 0), null);
	const path = join(directory, 'state.json');
	const envelope = { protocol: 1, pid: 123, unixMs: 10000, players: [entry] };
	await writeFile(path, JSON.stringify(envelope));
	assert.deepEqual(readVoiceJammingState(123, 10000, path), [entry]);
	assert.deepEqual(readVoiceJammingState(124, 10000, path), [], 'do not bind to another game process');
	assert.deepEqual(readVoiceJammingState(123, 11001, path), [], 'lost heartbeat releases forced mute');
	assert.deepEqual(readVoiceJammingState(123, 9800, path), [], 'reject future data');
	for (const data of [
		{ ...envelope, protocol: 2 },
		{ ...envelope, players: [entry, entry] },
		{ ...envelope, players: [{ ...entry, pitch: 100 }] },
	]) {
		await writeFile(path, JSON.stringify(data));
		assert.deepEqual(readVoiceJammingState(123, 10000, path), []);
	}
	console.log(
		'PASS Voice Jamminger: target-only mute/lowpass, synchronized pitch, meeting scope, PID binding and stale/replay validation'
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
