import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mobile = resolve(process.argv[2] ?? 'C:/Users/tamo-/TanukiBCL-mobile-hero-effects');
const directory = await mkdtemp(join(tmpdir(), 'tanuki-wall-ear-'));
let next = 0;
async function load(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	const file = join(directory, `${next++}.mjs`);
	await writeFile(file, result.outputFiles[0].contents);
	return import(pathToFileURL(file));
}
try {
	const { defaultLobbySettings } = await load('src/common/defaultLobbySettings.ts');
	const me = { id: 1, clientId: 10, x: 12, y: -15, isDead: false, isImpostor: false };
	const other = { id: 2, clientId: 11, x: 15, y: -15, isDead: false, isImpostor: false };
	const ear = { playerId: 1, x: 12, y: -15, range: 4 };
	const state = { mod: 'NoS', gameState: 1, map: 5, closedDoors: [], currentCamera: 7, players: [me, other] };
	const input = {
		state,
		me,
		other,
		settings: { enableSpatialAudio: true },
		activeLobbySettings: { ...defaultLobbySettings, wallsBlockAudio: true },
		maxDistance: 5.32,
		impostorRadioClientId: -1,
	};
	for (const entry of ['src/renderer/voice/spatialAudio.ts', join(mobile, 'src/app/voice/spatialAudio.ts')]) {
		const { calculateVoiceAudio: mix } = await load(entry);
		const active = { ...input, state: { ...state, nosWallEars: [ear] } };
		assert.equal(mix(input).gain, 0, 'real Fungle wall blocks normal audio');
		assert(mix(active).gain > 0, 'ear bypasses the same real wall');
		assert.equal(mix(active).panMaxDistance, 4, 'ear range reaches the panner');
		assert.equal(
			mix({ ...active, state: { ...active.state, nosWallEars: [{ ...ear, range: 2 }] } }).gain,
			0,
			'ear range enforced'
		);
		assert.equal(mix({ ...active, other: { ...other, isDead: true } }).gain, 0, 'ghost privacy maintained');
		assert.equal(
			mix({
				...active,
				state: { ...active.state, comsSabotaged: true },
				activeLobbySettings: { ...input.activeLobbySettings, commsSabotage: true },
			}).gain,
			0,
			'communication restriction maintained'
		);
		assert.equal(mix({ ...active, impostorRadioClientId: other.clientId }).gain, 0, 'private radio not intercepted');
		assert.equal(
			mix({ ...active, activeLobbySettings: { ...input.activeLobbySettings, deadOnly: true } }).gain,
			0,
			'dead-only gate maintained'
		);
		assert.equal(
			mix({ ...active, state: { ...active.state, nosWallEars: [{ ...ear, playerId: 3 }] } }).gain,
			0,
			'another player cannot inherit an ear'
		);
		assert.equal(
			mix({ ...active, state: { ...active.state, nosWallEars: [{ ...ear, range: Infinity }] } }).gain,
			0,
			'invalid ear fails closed'
		);
		const { wallEarFor } = await load(
			entry.includes('src/app') ? join(mobile, 'src/app/common/WallEarState.ts') : 'src/common/WallEarState.ts'
		);
		assert.equal(wallEarFor({ ...active.state, gameState: 2 }, me), undefined, 'meeting cancels ear');
		assert.equal(wallEarFor(active.state, { ...me, isDead: true }), undefined, 'death cancels ear');
		assert.equal(wallEarFor(active.state, { ...me, x: 0 }), undefined, 'teleport cancels ear');
		assert.equal(
			wallEarFor({ ...active.state, nosWallEars: [ear, ear] }, me),
			undefined,
			'duplicate listener rejected'
		);
		console.log(`PASS ear spatial/privacy: ${entry}`);
	}
	const { validAddonChannels } = await load('src/common/AddonLink.ts');
	const channels = {
		heroes: [],
		portable: [],
		megaphones: [],
		dying: [],
		interviews: [],
		jamming: [],
		echoes: [],
		muted: [],
		speech: [],
	};
	assert(validAddonChannels(channels, Date.now()), 'old nine-channel addons remain compatible');
	assert(validAddonChannels({ ...channels, ears: [ear] }, Date.now()));
	assert(!validAddonChannels({ ...channels, ears: [ear, ear] }, Date.now()));
	assert(!validAddonChannels({ ...channels, ears: [{ ...ear, range: 0 }] }, Date.now()));
	const { readWallEarState } = await load('src/main/wallEarState.ts');
	const file = join(directory, 'ears.json');
	const now = Date.now();
	await writeFile(file, JSON.stringify({ protocol: 1, pid: 7, unixMs: now, players: [ear] }));
	assert.deepEqual(readWallEarState(7, now, file), [ear]);
	assert.deepEqual(readWallEarState(8, now, file), []);
	assert.deepEqual(readWallEarState(7, now + 1001, file), []);
	const { MobileCosmetics } = await load('src/renderer/voice/MobileCosmetics.ts');
	const frame = new MobileCosmetics().frame({ ...state, lobbyCode: 'ABCDEF', nosWallEars: [ear] });
	assert.deepEqual(
		JSON.parse(JSON.stringify(frame)).gameState.nosWallEars,
		[ear],
		'PC host relays ear state to mobile'
	);
	console.log('PASS ear protocol compatibility, validation, legacy state freshness and PC -> mobile frame');
} finally {
	await rm(directory, { recursive: true, force: true });
}
