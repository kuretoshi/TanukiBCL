import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve('.cache/nos-berserker-tests');
await mkdir(directory, { recursive: true });
async function bundle(file) {
	const output = resolve(directory, file.split('/').at(-1).replace('.ts', '.mjs'));
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { isNosBodyLayout, readNosBodyType } = await bundle('src/main/nosBodyMemory.ts');
const { NosRoleTracker } = await bundle('src/main/nosRoleTracker.ts');
const { selectVoiceEffect } = await bundle('src/renderer/voice/voiceEffectRules.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { MapType } = await bundle('src/common/AmongusMap.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const role = { roleId: 2, roleName: 'berserker', displayName: 'バーサーカー', runtimeClass: 'Berserker+Ability' };
const state = { gameState: GameState.TASKS, mod: 'NoS', map: MapType.SKELD };
const me = { id: 1, clientId: 101, isDead: false, name: 'listener' };
const other = { id: 0, clientId: 100, name: 'speaker', nosRole: { ...role, bodyType: 2, isBerserking: true } };
const select = (speaker = other, game = state, lobby = defaultLobbySettings, listener = me) =>
	selectVoiceEffect(game, { voiceEffectStrength: 0 }, lobby, listener, speaker, -1);
const expected = { strength: 0, berserker: true };
assert.equal(
	select({ ...other, nosRole: { ...other.nosRole, bodyType: 0 } }),
	null,
	'inconsistent state disables effect'
);
assert.deepEqual(select(), expected, 'effect follows the remote speaker, not the local listener');
assert.deepEqual(
	select(other, state, defaultLobbySettings, { ...me, isDead: true }),
	expected,
	'ghost listener hears same speaker effect'
);
for (const flag of [false, undefined, null])
	assert.equal(select({ ...other, nosRole: { ...role, isBerserking: flag } }), null);
for (const mod of ['NONE', 'TOH4E', 'SUPER_NEW_ROLES']) assert.equal(select(other, { ...state, mod }), null);
for (const gameState of [GameState.MENU, GameState.LOBBY, GameState.DISCUSSION])
	assert.equal(select(other, { ...state, gameState }), null);
for (const flag of ['isDead', 'disconnected', 'bugged', 'isDummy'])
	assert.equal(select({ ...other, [flag]: true }), null);
assert.equal(select({ ...other, nosRole: { ...other.nosRole, roleName: 'destroyer' } }), null);
assert.equal(select(other, state, { ...defaultLobbySettings, nosBerserkerVoiceEffect: false }), null);
assert.equal(select(other, { ...state, map: MapType.AIRSHIP, airshipMeetingByOutfit: true }), null);
assert.deepEqual(
	select({ ...other, nosPlayer: { bodyRateX: 1, bodyRateY: 4 } }),
	expected,
	'berserking takes priority over size'
);

assert.deepEqual(
	select({ ...other, nosPlayer: { bodyType: 2, neckLength: 0 }, nosRole: { ...role } }),
	expected,
	'published BodyType activates without legacy native flags'
);
assert.equal(
	select({ ...other, nosPlayer: { bodyType: 0 }, nosRole: other.nosRole }),
	null,
	'published inactive state overrides old native flag'
);
const neck = (length, bodyType = 3) => ({
	...other,
	nosRole: { ...role, roleName: 'rokurokubi' },
	nosPlayer: { bodyType, neckLength: length, bodyRateX: 1, bodyRateY: 1 },
});
let lastPitch = 1;
for (const length of [0.1, 1, 5, 10, 20, 40, 100]) {
	const fx = select(neck(length));
	assert.ok(fx.sourceFilter.pitch >= lastPitch && fx.sourceFilter.pitch <= 2);
	lastPitch = fx.sourceFilter.pitch;
	assert.equal(fx.sourceFilter.formant, 1);
}
for (const value of [0, -1, NaN, Infinity, undefined]) assert.equal(select(neck(value)), null);
for (const bodyType of [0, 1, 2, undefined])
	assert.equal(select({ ...neck(20), nosPlayer: { ...neck(20).nosPlayer, bodyType } }), null);
assert.equal(select(neck(20), state, { ...defaultLobbySettings, nosRokurokubiVoiceEffect: false }), null);
assert.equal(select(neck(20), { ...state, gameState: GameState.DISCUSSION }), null);
assert.equal(select({ ...neck(20), isDead: true }), null);
for (const pointerSize of [4, 8]) {
	const layout = {
		pointerSize,
		controlAddress: 0x20000,
		controlClass: 0x30000,
		cosmeticsClass: 0x40000,
		playerIdOffset: 32,
		cosmeticsOffset: 40,
		bodyTypeOffset: 64,
	};
	const memory = Buffer.alloc(0x70000);
	const pointer = (address, value) =>
		pointerSize === 8 ? memory.writeBigUInt64LE(BigInt(value), address) : memory.writeUInt32LE(value, address);
	pointer(layout.controlAddress, layout.controlClass);
	memory[layout.controlAddress + layout.playerIdOffset] = 0;
	pointer(layout.controlAddress + layout.cosmeticsOffset, 0x50000);
	pointer(0x50000, layout.cosmeticsClass);
	const read = (address, size) => memory.subarray(address, address + size);
	memory.writeInt32LE(33, 0x50000 + layout.bodyTypeOffset);
	assert.throws(() => readNosBodyType(layout, 0, read), /body type/);
	memory.writeInt32LE(0, 0x50000 + layout.bodyTypeOffset);
	assert.equal(isNosBodyLayout(layout), true);
	assert.equal(isNosBodyLayout({ ...layout, bodyTypeOffset: -1 }), false);
	assert.equal(isNosBodyLayout({ ...layout, controlAddress: Number.MAX_SAFE_INTEGER + 1 }), false);
	for (const bodyType of [0, 2, 0]) {
		memory.writeInt32LE(bodyType, 0x50000 + layout.bodyTypeOffset);
		assert.equal(readNosBodyType(layout, 0, read), bodyType);
	}
	assert.throws(() => readNosBodyType(layout, 1, read), /identity/);
	pointer(0x50000, 0x60000);
	assert.throws(() => readNosBodyType(layout, 0, read), /class/);
	pointer(0x50000, layout.cosmeticsClass);
	assert.throws(() => readNosBodyType(layout, 0, () => Buffer.alloc(0)));
	const requests = [];
	const tracker = new NosRoleTracker(() => new Promise((resolve) => requests.push(resolve)));
	tracker.update(1, 'round', read);
	requests[0]([{ playerId: 0, role, bodyLayout: layout }]);
	await new Promise((resolve) => setImmediate(resolve));
	for (const bodyType of [0, 2, 0]) {
		memory.writeInt32LE(bodyType, 0x50000 + layout.bodyTypeOffset);
		const speaker = { ...other, nosRole: tracker.update(1, 'round', read).get(0) };
		assert.equal(speaker.nosRole.isBerserking, bodyType === 2);
		assert.deepEqual(select(speaker), bodyType === 2 ? expected : null);
	}
	memory.writeInt32LE(2, 0x50000 + layout.bodyTypeOffset);
	assert.equal(tracker.update(1, 'round', read).get(0).isBerserking, true);
	assert.equal(
		tracker
			.update(1, 'round', () => {
				throw Error('unreadable');
			})
			.get(0).isBerserking,
		undefined
	);
	tracker.reset();
	assert.equal(tracker.update(1, 'new-round', read).size, 0);
}

// Optional real process test: same native reader and voice rule used by the application.
const livePath = process.argv[2];
if (livePath) {
	const memoryjs = (await import('memoryjs')).default;
	const response = JSON.parse(await readFile(livePath, 'utf8'));
	const handle = memoryjs.openProcess(response.pid).handle;
	try {
		const row = response.metadata.find((row) => row.role.roleName === 'berserker');
		assert.ok(row && isNosBodyLayout(row.bodyLayout), 'live Berserker layout is valid');
		const bodyType = readNosBodyType(row.bodyLayout, row.playerId, (address, size) =>
			memoryjs.readBuffer(handle, address, size)
		);
		const active = bodyType === 2;
		const effect = select({ ...other, id: row.playerId, nosRole: { ...row.role, bodyType, isBerserking: active } });
		assert.deepEqual(effect, active ? expected : null);
		const result = { pid: response.pid, playerId: row.playerId, bodyType, active, effect };
		await writeFile(
			resolve(directory, active ? 'live-active.json' : 'live-inactive.json'),
			JSON.stringify(result, null, 2)
		);
		console.log('PASS live native state → voice rule:', JSON.stringify(result));
	} finally {
		memoryjs.closeProcess(handle);
	}
}
console.log(
	'PASS Berserker: x86/x64 native guards, activation/deactivation, speaker selection, failures, resets, settings and effect priority'
);
