import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cache = resolve('.cache/nos-addon-data-tests');
await mkdir(cache, { recursive: true });
async function load(entry) {
	const output = resolve(cache, entry.split('/').at(-1).replace('.ts', '.mjs'));
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { isNosLayout, readNosSnapshot } = await load('src/main/nosSnapshotMemory.ts');
const { readTanukiAddonData } = await load('src/common/TanukiAddonData.ts');
function fixture(pointerSize) {
	const layout = {
		pid: 42,
		pointerSize,
		schemaVersion: 20261009,
		latestSlotAddress: 0x40000,
		snapshot: {
			localMicPositionX: 0,
			localMicPositionY: 4,
			playersLength: 8,
			players: 16,
			radiosLength: 24,
			radios: 32,
			addonData: 40,
		},
		playerData: {
			size: 176,
			playerId: 0,
			isKiller: 1,
			isImpostor: 2,
			isCrewmate: 3,
			isNeutral: 4,
			isImpostorlike: 5,
			isJammed: 6,
			nameLength: 7,
			name: 8,
			speakerPositionX: 72,
			speakerPositionY: 76,
			bodyRateX: 80,
			bodyRateY: 84,
			colorR: 88,
			colorG: 92,
			colorB: 96,
			bodyType: 160,
			neckLength: 164,
			addonData: 168,
			skin: { offset: 100, nameLength: 0, name: 2, capacity: 8, size: 20 },
			hat: { offset: 120, nameLength: 0, name: 2, capacity: 8, size: 20 },
			visor: { offset: 140, nameLength: 0, name: 2, capacity: 8, size: 20 },
		},
		radioData: { size: 80, kind: 0, hearableMask: 4, nameLength: 8, name: 12 },
	};
	const header = Buffer.alloc(44),
		players = Buffer.alloc(352),
		slot = Buffer.alloc(pointerSize);
	const pointer = (buffer, value, offset) =>
		pointerSize === 8 ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeUInt32LE(value, offset);
	pointer(slot, 0x50000, 0);
	pointer(header, 0x60000, 16);
	header.writeInt32LE(2, 8);
	header.writeInt32LE(0x544b0001, 40);
	players[0] = 1;
	players[176] = 2;
	players.writeInt32LE(0x544b0101 | (7 << 2), 168); // Super + portable 3.5
	players.writeInt32LE(0x544b0002, 344); // Evil
	const read = (address, size) => {
		const source = new Map([
			[0x40000, slot],
			[0x50000, header],
			[0x60000, players],
		]).get(address);
		assert(source && source.length >= size);
		return Buffer.from(source.subarray(0, size));
	};
	return { layout, header, players, read };
}
for (const pointerSize of [4, 8]) {
	const f = fixture(pointerSize);
	assert(isNosLayout(f.layout, 42));
	let snapshot = readNosSnapshot(f.layout, f.read);
	assert.deepEqual(readTanukiAddonData(snapshot), {
		heroes: [
			{ playerId: 1, kind: 'super' },
			{ playerId: 2, kind: 'evil' },
		],
		portable: [{ playerId: 1, extraRange: 3.5 }],
	});
	f.players.writeInt32LE(0x544b0000, 168);
	f.players.writeInt32LE(0x544b0000, 344);
	assert.deepEqual(
		readTanukiAddonData(readNosSnapshot(f.layout, f.read)),
		{ heroes: [], portable: [] },
		'zero effects clear old state, no stale fallback'
	);
	for (const invalid of [0, 0x544b0003, 0x544b0200, 0x544b00f4, 0x544b0004]) {
		f.players.writeInt32LE(invalid, 168);
		assert.equal(
			readTanukiAddonData(readNosSnapshot(f.layout, f.read)),
			undefined,
			'foreign or malformed data falls back'
		);
	}
	f.players.writeInt32LE(0x544b0000, 168);
	f.header.writeInt32LE(0x12345678, 40);
	assert.equal(readTanukiAddonData(readNosSnapshot(f.layout, f.read)), undefined, 'global marker required');
	const legacy = structuredClone(f.layout);
	delete legacy.snapshot.addonData;
	delete legacy.playerData.addonData;
	assert(isNosLayout(legacy, 42));
	assert.equal(readTanukiAddonData(readNosSnapshot(legacy, f.read)), undefined, 'old NoS remains readable');
	const next = structuredClone(f.layout);
	next.schemaVersion = 20261104; // Synthetic future fixture, not a released version claim.
	assert(isNosLayout(next, 42));
	delete next.playerData.addonData;
	assert(!isNosLayout(next, 42), 'unpaired optional addon fields are rejected');
	const outside = structuredClone(f.layout);
	outside.playerData.addonData = 175;
	assert(!isNosLayout(outside, 42));
	f.header.writeInt32LE(0x544b0001, 40);
	let reads = 0;
	assert.throws(
		() =>
			readNosSnapshot(f.layout, (address, size) => {
				const bytes = f.read(address, size);
				if (address === 0x60000 && ++reads === 2) bytes[168] ^= 1;
				return bytes;
			}),
		/changed during read/,
		'addon field is included in coherent snapshot checks'
	);
}
for (let hero = 0; hero <= 2; hero++)
	for (let half = -1; half <= 60; half++) {
		const data = 0x544b0000 | hero | (half < 0 ? 0 : 0x100 | (half << 2));
		const result = readTanukiAddonData({ addonData: 0x544b0001, players: [{ playerId: 1, addonData: data }] });
		const v2 = readTanukiAddonData({
			addonData: 0x54420000 | 12345,
			players: [{ playerId: 1, addonData: 0x544cfe00 | (data & 511) }],
		});
		assert.deepEqual(v2, result, 'v2 endpoint and all player flags preserve scalar states');
		assert.equal(result.heroes.length, hero ? 1 : 0);
		assert.deepEqual(result.portable, half < 0 ? [] : [{ playerId: 1, extraRange: half / 2 }]);
	}
console.log('PASS NoS AddonData: x86/x64, 186 states, legacy fallback, tag/range/layout guards, clears and torn reads');
