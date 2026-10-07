import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
	return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { CameraLocation, MapType } = await bundle('src/common/AmongusMap.ts');
const names = [
	'readCurrentCamera',
	'readCommsSabotage',
	'readShipSystems',
	'readClosedDoors',
	'readTaskAppearance',
	'readPlayers',
];
const source = ts.createSourceFile(
	'GameReader.ts',
	await readFile('src/main/GameReader.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const methods = [];
function visit(node) {
	if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.push(node.getText(source));
	ts.forEachChild(node, visit);
}
visit(source);
assert.equal(methods.length, names.length);
const reader = vm.runInNewContext(
	ts.transpileModule('({' + methods.join(',') + '})', { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
		.outputText,
	{
		GameState,
		CameraLocation,
		MapType,
		voiceDebugEnabled: true,
		readBuffer: (_handle, address) => {
			if (address === 2) throw new Error('stale player');
			return Buffer.alloc(1);
		},
	}
);
const offsets = Object.fromEntries(
	[
		'miniGame',
		'objectCachePtr',
		'planetSurveillanceMinigame_currentCamera',
		'planetSurveillanceMinigame_camarasCount',
		'surveillanceMinigame_FilteredRoomsCount',
		'HudOverrideSystemType_isActive',
		'hqHudSystemType_CompletedConsoles',
		'shipStatus_systems',
		'deconDoorLowerOpen',
		'deconDoorUpperOpen',
		'shipstatus_allDoors',
		'playerCount',
		'playerAddrPtr',
		'door_isOpen',
	].map((key, i) => [key, 100 + i])
);
const memory = new Map();
const write = (address, offset, value) => memory.set(`${address}:${offset}`, value);
reader.offsets = { ...offsets, player: { offsets: [], bufferLength: 1 } };
reader.gameAssembly = { modBaseAddr: 1 };
reader.readMemory = (_type, address, offset) => memory.get(`${address}:${offset}`) ?? 0;
write(1, offsets.miniGame, 50);
write(50, offsets.objectCachePtr, 1);
write(50, offsets.planetSurveillanceMinigame_camarasCount, 6);
const local = { x: -12.9364, y: -2.7928 };
for (const map of [MapType.POLUS, MapType.AIRSHIP]) {
	for (const id of [0, 5, 6]) {
		write(50, offsets.planetSurveillanceMinigame_currentCamera, id);
		assert.equal(reader.readCurrentCamera(map, local), id <= 5 ? id : CameraLocation.NONE);
	}
}
write(50, offsets.surveillanceMinigame_FilteredRoomsCount, 4);
assert.equal(reader.readCurrentCamera(MapType.THE_SKELD, local), CameraLocation.Skeld);
assert.equal(reader.readCurrentCamera(MapType.THE_SKELD, { x: 0, y: 0 }), CameraLocation.NONE);
write(50, offsets.objectCachePtr, 0);
assert.equal(reader.readCurrentCamera(MapType.THE_SKELD, local), CameraLocation.NONE);
write(200, offsets.HudOverrideSystemType_isActive, 1);
write(200, offsets.hqHudSystemType_CompletedConsoles, 1);
for (const map of [
	MapType.AIRSHIP,
	MapType.POLUS,
	MapType.THE_SKELD,
	MapType.SUBMERGED,
	MapType.FUNGLE,
	MapType.MIRA_HQ,
])
	assert.equal(reader.readCommsSabotage(200, map), true);
write(200, offsets.hqHudSystemType_CompletedConsoles, 2);
assert.equal(reader.readCommsSabotage(200, MapType.MIRA_HQ), false);
write(10, offsets.shipStatus_systems, 99);
write(20, undefined, 14);
write(21, undefined, 200);
write(22, undefined, 18);
write(23, undefined, 201);
write(201, offsets.deconDoorLowerOpen, 0);
write(201, offsets.deconDoorUpperOpen, 1);
reader.readDictionary = (_ptr, _size, callback) => {
	callback(20, 21);
	callback(22, 23);
};
const deconDoors = [];
assert.equal(reader.readShipSystems(10, MapType.MIRA_HQ, deconDoors), false);
assert.deepEqual(deconDoors, [0]);
for (const stride of [4, 8]) {
	reader.is_64bit = stride === 8;
	write(10, offsets.shipstatus_allDoors, 1000);
	write(1000, offsets.playerCount, 30);
	for (let door = 0; door < 16; door++) {
		write(1000 + offsets.playerAddrPtr + door * stride, undefined, 2000 + door * 100);
		write(2000 + door * 100 + offsets.door_isOpen, undefined, door % 2);
	}
	const closed = [];
	reader.readClosedDoors(10, MapType.AIRSHIP, closed);
	assert.deepEqual(closed, [0, 2, 4, 6, 8, 10, 12, 14]);
	reader.readClosedDoors(10, MapType.MIRA_HQ, closed);
	assert.equal(closed.length, 8);
}
reader.hasDisguisedAppearance = (player) => !!player.disguised;
const players = [
	{ id: 1, currentOutfit: 1 },
	{ id: 2, currentOutfit: 1 },
	{ id: 3, currentOutfit: 0, disconnected: true },
];
assert.equal(reader.readTaskAppearance(players, MapType.AIRSHIP).airshipMeetingByOutfit, true);
players[0].disguised = true;
assert.equal(reader.readTaskAppearance(players, MapType.AIRSHIP).mixupSabotaged, true);
assert.equal(reader.readTaskAppearance(players, MapType.AIRSHIP).airshipMeetingByOutfit, false);
reader.amongUs = { handle: 1 };
reader.parsePlayer = (address) => ({ clientId: address, nameHash: 100002 });
reader.applySnrCosmeticAppearance = () => {};
reader.isLocalGame = true;
const addresses = [];
reader.offsetAddress = (pointer) => {
	addresses.push(pointer);
	return { address: addresses.length - 1, last: 0 };
};
const parsed = reader.readPlayers(100, 50, 1, 1, GameState.TASKS);
assert.equal(addresses.length, 40, 'player count is bounded');
assert.equal(addresses[1] - addresses[0], 8);
assert.equal(parsed.length, 38, 'null and stale player pointers are skipped');
assert.equal(reader.gameCode, '3', 'local lobby code uses the host hash');
console.log(
	'PASS game reader: camera bounds/position, comms, decontamination, 32/64-bit door strides, disguises, stale pointers and player-count limit'
);
