import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Execute production parsing and pointer traversal against counted native-memory substitutes.
const source = ts.createSourceFile(
	'GameReader.ts',
	await readFile(process.env.TANUKI_GAME_READER_BASELINE ?? 'src/main/GameReader.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const required = new Set(['parsePlayer', 'readMemory', 'offsetAddress', 'formatRoleLabel', 'hashCode']);
const methods = [];
function visit(node) {
	if (
		ts.isMethodDeclaration(node) &&
		(required.has(node.name.getText(source)) || node.name.getText(source) === 'readPosition')
	)
		methods.push(node.getText(source));
	ts.forEachChild(node, visit);
}
visit(source);
assert.equal(methods.filter((method) => !method.startsWith('private readPosition')).length, required.size);
const code = ts.transpileModule('({' + methods.join(',') + '})', {
	compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const pointerOffsets = { friendCode: 64, puid: 72, outfitsPtr: 88, rolePtr: 104, taskPtr: 112, objectPtr: 128 };
const pointerNames = Object.keys(pointerOffsets);

function fixture({ x64 = false, local = false, layout = 'adjacent', bufferLength = x64 ? 132 : 92 } = {}) {
	const bytes = new Map();
	const calls = [];
	const stringReads = [];
	const base = x64 ? 0x123400000000 : 0x100000;
	const ptr = base + 0x100;
	let objectPtr = base + 0x2000;
	let shortPosition = false;
	const pointerValues = Object.fromEntries(pointerNames.map((name, index) => [name, base + 0x3000 + index * 0x100]));
	pointerValues.objectPtr = objectPtr;
	const xOffsets = x64 ? [224, 64, 16, 176] : [152, 44, 8, 124];
	const yOffsets = [...xOffsets];
	yOffsets[3] += layout === 'noncontiguous' ? 8 : 4;
	if (layout === 'unequal-prefix') yOffsets[0] += 16;
	const positionAddresses = new Set();
	const put = (address, buffer) => buffer.forEach((byte, index) => bytes.set(address + index, byte));
	const rawBytes = (address, length) =>
		Buffer.from(Array.from({ length }, (_, index) => bytes.get(address + index) ?? 0));
	const pointer = (address, value) => {
		const buffer = Buffer.alloc(x64 ? 8 : 4);
		if (x64) buffer.writeBigUInt64LE(BigInt(value));
		else buffer.writeUInt32LE(value);
		put(address, buffer);
	};
	const float = (address, value) => {
		const buffer = Buffer.alloc(4);
		buffer.writeFloatLE(value);
		put(address, buffer);
	};
	const chain = (start, offsets, value, extra = 0) => {
		let address = start;
		for (let index = 0; index < offsets.length - 1; index++) {
			const next = base + 0x10000 + extra + index * 0x1000;
			pointer(address + offsets[index], next);
			address = next;
		}
		const result = address + offsets.at(-1);
		float(result, value);
		return result;
	};
	function writePosition(x, y) {
		positionAddresses.clear();
		positionAddresses.add(chain(objectPtr, xOffsets, x));
		chain(objectPtr, yOffsets, y, layout === 'unequal-prefix' ? 0x10000 : 0);
	}
	function writeObject() {
		const outfit = Buffer.alloc(4);
		put(objectPtr + 32, outfit);
		bytes.set(objectPtr + 36, 0);
		bytes.set(objectPtr + 37, 0);
	}
	for (const [name, offset] of Object.entries(pointerOffsets)) pointer(ptr + offset, pointerValues[name]);
	writePosition(15.5, -2.25);
	writeObject();
	const readMemoryRaw = (_handle, address, type) => {
		assert.notEqual(address, 0, 'never read a null address');
		calls.push({ type, address });
		if (type === 'uint64') return Number(rawBytes(address, 8).readBigUInt64LE());
		if (type === 'uint32' || type === 'int32') return rawBytes(address, 4).readUInt32LE();
		if (type === 'float') return rawBytes(address, 4).readFloatLE();
		if (type === 'boolean') return rawBytes(address, 1)[0] !== 0;
		if (type === 'byte') return rawBytes(address, 1)[0];
		throw new Error(`Unexpected native type: ${type}`);
	};
	const readBuffer = (_handle, address, length) => {
		assert.notEqual(address, 0, 'never read a null address');
		calls.push({ type: 'buffer', address, length });
		return rawBytes(address, shortPosition && positionAddresses.has(address) ? 4 : length);
	};
	const reader = vm.runInNewContext(code, { readMemoryRaw, readBuffer, RainbowColorId: -99 });
	reader.amongUs = { handle: 1 };
	reader.is_64bit = x64;
	reader.playercolors = Array(18);
	reader.rainbowColor = 99;
	reader.offsets = {
		player: {
			localX: local ? xOffsets : [7],
			localY: local ? yOffsets : [11],
			remoteX: local ? [9] : xOffsets,
			remoteY: local ? [13] : yOffsets,
			currentOutfit: [32],
			isDummy: [36],
			inVent: [37],
		},
	};
	let reported;
	reader.PlayerStruct = {
		getOffsetByName: (name) => pointerOffsets[name],
		report: () => {
			// Structron's pointer fields are UINTs; x64 parsing must replace their truncated low halves.
			reported = {
				...Object.fromEntries(pointerNames.map((name) => [name, pointerValues[name] >>> 0])),
				id: 2,
				clientId: 20,
				name: 555,
				disconnected: 0,
				dead: 0,
				color: 2,
				impostor: 0,
			};
			return { data: reported };
		},
	};
	reader.readString = (address) => {
		stringReads.push(address);
		return address === 555 ? 'Crewmate' : `string:${address}`;
	};
	return {
		reader,
		calls,
		stringReads,
		pointerValues,
		ptr,
		get reported() {
			return reported;
		},
		parse(length = bufferLength) {
			return reader.parsePlayer(ptr, rawBytes(ptr, length), local ? 20 : 99);
		},
		writePosition,
		shortPosition: () => (shortPosition = true),
		nullPosition: () => pointer(objectPtr + xOffsets[0], 0),
		nullObject: () => {
			pointerValues.objectPtr = 0;
			pointer(ptr + pointerOffsets.objectPtr, 0);
		},
		replaceObject() {
			objectPtr += 0x1000;
			pointerValues.objectPtr = objectPtr;
			pointer(ptr + pointerOffsets.objectPtr, objectPtr);
			writeObject();
			writePosition(-7.25, 0);
		},
	};
}

const pointerCalls = (f) =>
	f.calls.filter(({ address }) => pointerNames.some((name) => address === f.ptr + pointerOffsets[name]));
for (const x64 of [false, true]) {
	for (const local of [false, true]) {
		const f = fixture({ x64, local });
		const player = f.parse();
		assert.equal(player.x, 15.5);
		assert.equal(player.y, -2.25);
		assert.equal(player.isLocal, local, 'correct local/remote offset branch');
		assert.equal(player.bugged, false);
		assert.equal(
			f.calls.filter(({ type }) => type === 'buffer').length,
			1,
			'adjacent coordinates use one eight-byte read'
		);
		assert.equal(f.calls.filter(({ type }) => type === 'float').length, 0, 'no duplicate scalar coordinate reads');
		assert.equal(
			f.calls.length,
			x64 ? 8 : 7,
			'three shared pointer reads, one coordinate read, three other fields and x64 tail fallback'
		);
		assert.equal(pointerCalls(f).length, x64 ? 1 : 0, 'only x64 objectPtr extends beyond the existing buffer');
		for (const name of pointerNames)
			assert.equal(f.reported[name], f.pointerValues[name], `${name} preserves its full address`);
		assert.equal(player.friendCode, `string:${f.pointerValues.friendCode}`);
		assert.equal(player.playerUid, `string:${f.pointerValues.puid}`);
		f.calls.length = 0;
		f.writePosition(0, -10.5);
		const moved = f.parse();
		assert.equal(moved.x, 0, 'X=0 remains a valid coordinate');
		assert.equal(moved.y, -10.5, 'coordinate values are read again on every parse');
		f.replaceObject();
		const replaced = f.parse();
		assert.equal(
			replaced.objectPtr,
			f.pointerValues.objectPtr,
			'replacement object is observed without a pointer cache'
		);
		assert.equal(replaced.x, -7.25);
		assert.equal(replaced.y, 0, 'Y=0 remains a valid coordinate');
	}
}

for (const x64 of [false, true]) {
	for (const layout of ['noncontiguous', 'unequal-prefix']) {
		const f = fixture({ x64, layout });
		const player = f.parse();
		assert.equal(player.x, 15.5);
		assert.equal(player.y, -2.25);
		assert.equal(f.calls.filter(({ type }) => type === 'buffer').length, 0, `${layout} preserves the generic path`);
		assert.equal(f.calls.filter(({ type }) => type === 'float').length, 2);
		assert.equal(f.calls.length, x64 ? 12 : 11);
	}
	const short = fixture({ x64 });
	short.shortPosition();
	assert.equal(short.parse().x, 15.5, 'short coordinate buffer falls back to scalar reads');
	assert.equal(short.calls.filter(({ type }) => type === 'float').length, 2);
	const missingPosition = fixture({ x64 });
	missingPosition.nullPosition();
	const missing = missingPosition.parse();
	assert.equal(missing.bugged, true, 'null pointer chains keep unreadable coordinates invalid');
	assert.equal(missing.x, 9999);
	assert.equal(missing.y, 9999);
	assert.equal(missingPosition.calls.filter(({ type }) => type === 'buffer' || type === 'float').length, 0);
	const missingObject = fixture({ x64 });
	missingObject.nullObject();
	assert.equal(missingObject.parse(), undefined, 'null player object is rejected before coordinate reads');
}

for (const length of [0, 68, 72, 80, 132, 136]) {
	const f = fixture({ x64: true, bufferLength: length });
	const player = f.parse();
	const missing = pointerNames.filter((name) => pointerOffsets[name] + 8 > length);
	assert.equal(pointerCalls(f).length, missing.length, 'only complete pointers may be read from the supplied buffer');
	for (const name of pointerNames)
		assert.equal(f.reported[name], f.pointerValues[name], `${name} survives a ${length}-byte buffer`);
	assert.equal(player.objectPtr, f.pointerValues.objectPtr);
	assert.equal(player.x, 15.5);
}

console.log(
	'PASS native reads: x86 player 11 -> 7 calls; x64 132-byte player 17 -> 8 calls; local/remote, generic layout and short-buffer fallbacks, null guards, full x64 pointers and fresh frames'
);
