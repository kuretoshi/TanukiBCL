import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import memoryjs from 'memoryjs';

const cache = resolve('.cache/nos-reader-tests');
await mkdir(cache, { recursive: true });
async function bundle(file) {
	const output = resolve(cache, file.split('/').at(-1).replace('.ts', '.mjs'));
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { isNosLayout, readNosSnapshot } = await bundle('src/main/nosSnapshotMemory.ts');
const { NosSnapshotTracker, NosReaderUnexpectedExitError } = await bundle('src/main/nosSnapshotTracker.ts');
const {
	isNosPaletteLayout,
	readNosPalette,
	NosPaletteTracker,
	NosReaderUnexpectedExitError: NosPaletteReaderUnexpectedExitError,
} = await bundle('src/main/nosPalette.ts');
const { nosColorHex, findNosColorIndex, isNosRadioData, canHearNosJackalRadio } =
	await bundle('src/common/NosSnapshot.ts');
assert.equal(nosColorHex({ colorR: 0.25, colorG: 0.5, colorB: 0.75 }), '#4080bf');
assert.equal(findNosColorIndex({ colorR: 0.25, colorG: 0.5, colorB: 0.75 }, [['#000000'], ['#3f7fbf']]), 1);
assert.equal(findNosColorIndex(undefined, [['#000000']]), -1);
assert.equal(isNosRadioData({ kind: 1, hearableMask: 3, nameLength: 2, name: '無線' }), true);
assert.equal(isNosRadioData({ kind: 1, hearableMask: 3, nameLength: 2, name: '無線'.repeat(100) }), false);
assert.equal(isNosRadioData({ kind: 1, hearableMask: 2 ** 32, nameLength: 2, name: '無線' }), false);
const jackalA = [{ kind: 1, hearableMask: 1 << 1, nameLength: 0, name: '' }];
const jackalB = [{ kind: 1, hearableMask: 1 << 3, nameLength: 0, name: '' }];
assert.equal(canHearNosJackalRadio(jackalA, 1), true);
assert.equal(canHearNosJackalRadio(jackalA, 3), false);
assert.equal(canHearNosJackalRadio(jackalB, 1), false);
assert.equal(canHearNosJackalRadio(jackalB, 3), true);
assert.equal(canHearNosJackalRadio([{ ...jackalA[0], kind: 0 }], 1), false);
const architecture = process.argv.includes('--x64') ? 'x64' : 'x86';
const fixture = resolve(cache, `fixture-${architecture}`);
execFileSync(
	'dotnet',
	[
		'publish',
		'scripts/fixtures/nos-reader/Host/Host.csproj',
		'-c',
		'Release',
		'-r',
		`win-${architecture}`,
		'-o',
		fixture,
	],
	{
		windowsHide: true,
		stdio: 'pipe',
	}
);
const child = spawn(resolve(fixture, 'Among Us.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout });
let handle;
try {
	await Promise.race([
		once(lines, 'line'),
		once(child, 'error').then(([error]) => {
			throw error;
		}),
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error('NoS fixture timeout')), 15000).unref();
		}),
	]);
	handle = memoryjs.openProcess(child.pid);
	const read = (address, size) => memoryjs.readBuffer(handle.handle, address, size);
	const paletteResponse = JSON.parse(
		execFileSync(resolve(`out/nos-reader/${architecture}/TbclSnapshotReader.exe`), ['palette', String(child.pid)], {
			windowsHide: true,
			timeout: 45000,
			encoding: 'utf8',
		})
	);
	const palette = paletteResponse.metadata;
	assert.ok(isNosPaletteLayout(palette, child.pid), JSON.stringify(paletteResponse));
	assert.equal(isNosPaletteLayout(palette, child.pid + 1), false);
	assert.equal(isNosPaletteLayout({ ...palette, stride: 2 }, child.pid), false);
	assert.equal(readNosPalette(palette, read)[3], '#4080bf', 'Read lobby RGB before any role snapshot publication');
	const published = once(lines, 'line');
	const response = JSON.parse(
		execFileSync(resolve(`out/nos-reader/${architecture}/TbclSnapshotReader.exe`), ['layout', String(child.pid)], {
			windowsHide: true,
			timeout: 45000,
			encoding: 'utf8',
		})
	);
	await published;
	const layout = response.metadata;
	assert.ok(isNosLayout(layout, child.pid), JSON.stringify(response));
	assert.equal(layout.schemaVersion, 20261009);
	assert.equal(layout.playerData.skin.capacity, 128);
	assert.equal(layout.playerData.size, 888);
	const legacyPlayer = {
		...layout.playerData,
		size: 104,
		skin: null,
		hat: null,
		visor: null,
		bodyType: undefined,
		neckLength: undefined,
	};
	const legacy = { ...layout, schemaVersion: 20260928, playerData: legacyPlayer };
	assert.ok(isNosLayout(legacy, child.pid));
	assert.equal(readNosSnapshot(legacy, read).players[0].name, 'テスト');
	assert.equal(readNosSnapshot(legacy, read).players[0].skin, undefined);
	assert.equal(readNosSnapshot(layout, read).players[0].skin.name, 'Test');
	assert.equal(readNosSnapshot(layout, read).players[0].hat.name, '');
	assert.equal(
		isNosLayout(
			{ ...layout, playerData: { ...layout.playerData, skin: { ...layout.playerData.skin, offset: 10000 } } },
			child.pid
		),
		false
	);
	assert.equal(isNosLayout({ ...layout, pid: child.pid + 1 }, child.pid), false);
	assert.equal(isNosLayout({ ...layout, playerData: { ...layout.playerData, name: 10000 } }, child.pid), false);
	assert.equal(isNosLayout({ ...layout, schemaVersion: 0 }, child.pid), false);
	const live = () => readNosSnapshot(layout, read);
	const first = live();
	assert.deepEqual(first.localMicPosition, { x: 1, y: -1 });
	assert.equal(first.players[0].name, 'テスト');
	assert.equal(first.players[0].isNeutral, true);
	assert.equal(first.players[0].colorB, 0.75);
	assert.equal(first.players[0].bodyRateX, 1.25);
	assert.equal(first.players[0].bodyRateY, 0.75);
	assert.equal(first.players[0].bodyType, 3);
	assert.equal(first.players[0].neckLength, 5);
	for (const field of ['bodyType', 'neckLength']) {
		assert.equal(
			isNosLayout({ ...layout, playerData: { ...layout.playerData, [field]: undefined } }, child.pid),
			false
		);
		assert.equal(
			isNosLayout({ ...layout, playerData: { ...layout.playerData, [field]: layout.playerData.size } }, child.pid),
			false
		);
	}
	const header = read(first.publication, layout.snapshot.players + layout.pointerSize);
	const playerAddress =
		layout.pointerSize === 8
			? Number(header.readBigUInt64LE(layout.snapshot.players))
			: header.readUInt32LE(layout.snapshot.players);
	for (const [field, value] of [
		['bodyType', -1],
		['bodyType', 33],
		['neckLength', -1],
		['neckLength', NaN],
		['neckLength', Infinity],
	]) {
		const corruptRead = (address, size) => {
			const buffer = Buffer.from(read(address, size));
			if (address === playerAddress) {
				if (field === 'bodyType') buffer.writeInt32LE(value, layout.playerData[field]);
				else buffer.writeFloatLE(value, layout.playerData[field]);
			}
			return buffer;
		};
		assert.throws(() => readNosSnapshot(layout, corruptRead), /Invalid NoS (body state|float)/);
	}
	assert.equal(first.players[0].isJammed, true);
	assert.deepEqual(first.radios, [{ kind: 1, hearableMask: 0xb, nameLength: 6, name: 'Jackal' }]);
	const legacyLayout = structuredClone(layout);
	legacyLayout.schemaVersion = 20261005;
	delete legacyLayout.playerData.bodyType;
	delete legacyLayout.playerData.neckLength;
	delete legacyLayout.snapshot.radiosLength;
	delete legacyLayout.snapshot.radios;
	delete legacyLayout.radioData;
	delete legacyLayout.playerData.bodyRateX;
	delete legacyLayout.playerData.bodyRateY;
	delete legacyLayout.playerData.isJammed;
	assert.ok(isNosLayout(legacyLayout, child.pid));
	assert.deepEqual(readNosSnapshot(legacyLayout, read).radios, []);
	const command = async (value) => {
		const reply = once(lines, 'line');
		child.stdin.write(value + '\n');
		await reply;
	};
	const readStar = () => JSON.parse(execFileSync(
		resolve(`out/nos-reader/${architecture}/TbclSnapshotReader.exe`), ['roles', String(child.pid)],
		{ windowsHide: true, timeout: 45000, encoding: 'utf8' }
	)).metadata[0].role.isRainbowStar;
	assert.equal(readStar(), false, 'No Star modifier means no echo');
	for (const [value, expected] of [['star-on', true], ['star-yellow', false], ['star-unknown', null], ['star-clear', false]]) {
		await command(value);
		assert.equal(readStar(), expected, `Managed Star state: ${value}`);
	}
	await command('neck');
	assert.equal(live().players[0].neckLength, 12);
	assert.equal(live().players[0].bodyType, 3);
	await command('normal');
	assert.equal(live().players[0].neckLength, 0);
	assert.equal(live().players[0].bodyType, 0);
	await command('berserk');
	assert.equal(live().players[0].bodyType, 2);
	await command('color');
	assert.equal(readNosPalette(palette, read)[3], '#ff4000', 'Lobby color changes remain live');
	await command('gc');
	assert.equal(readNosPalette(palette, read)[3], '#ff4000', 'Follow the static slot after a managed GC');
	await command('team');
	assert.equal(live().players[0].isNeutral, false);
	assert.equal(live().players[0].isImpostor, true);
	assert.equal(live().players[0].isJammed, false);
	let finish,
		calls = 0;
	const tracker = new NosSnapshotTracker(() => {
		calls++;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	assert.equal(tracker.update(child.pid, 'round', read), undefined);
	finish(layout);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(tracker.update(child.pid, 'round', read), undefined, 'Wait for publication after entering a round');
	await command('team');
	assert.equal(tracker.update(child.pid, 'round', read).players[0].name, 'テスト');
	assert.equal(calls, 1);
	assert.equal(
		tracker.update(child.pid, 'lobby', read),
		undefined,
		'Returning to lobby must discard the previous game publication'
	);
	await command('team');
	assert.equal(
		tracker.update(child.pid, 'lobby', read).players[0].colorB,
		0.75,
		'Lobby publishes RGB without starting a game'
	);
	assert.equal(calls, 1, 'Lobby reuses the resolved layout');
	const now = Date.now;
	let time = now(),
		attempts = 0;
	const retrying = new NosSnapshotTracker(async () => {
		if (++attempts === 1) throw new Error('Static storage not initialized yet');
		return layout;
	});
	try {
		Date.now = () => time;
		retrying.update(child.pid, 'lobby', read);
		await new Promise((resolve) => setImmediate(resolve));
		retrying.update(child.pid, 'lobby', read);
		assert.equal(attempts, 1, 'Do not create snapshots repeatedly while initialization is pending');
		time += 5000;
		retrying.update(child.pid, 'lobby', read);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(attempts, 2, 'Retry initialization in the same lobby');
		retrying.update(child.pid, 'lobby', read);
		await command('team');
		assert.equal(retrying.update(child.pid, 'lobby', read).players[0].colorB, 0.75);
	} finally {
		Date.now = now;
	}

	let recoveryCalls = 0;
	const recovering = new NosSnapshotTracker(async () => {
		recoveryCalls++;
		return layout;
	});
	const unreadable = () => {
		throw new Error('stale address');
	};
	try {
		Date.now = () => time;
		recovering.update(child.pid, 'round', read);
		await new Promise((resolve) => setImmediate(resolve));
		recovering.update(child.pid, 'round', read);
		await command('team');
		assert.ok(recovering.update(child.pid, 'round', read));
		recovering.update(child.pid, 'round', unreadable);
		time += 100;
		assert.ok(recovering.update(child.pid, 'round', read), 'Transient failure recovers without restarting helper');
		assert.equal(recoveryCalls, 1);
		recovering.update(child.pid, 'round', unreadable);
		time += 4999;
		recovering.update(child.pid, 'round', unreadable);
		assert.equal(recoveryCalls, 1);
		time += 1;
		recovering.update(child.pid, 'round', unreadable);
		recovering.update(child.pid, 'round', read);
		recovering.update(child.pid, 'round', read);
		assert.equal(recoveryCalls, 2, 'Re-resolve invalid addresses once, without overlapping helpers');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(recovering.update(child.pid, 'round', read), undefined, 'Do not restore old publications');
		await command('team');
		assert.ok(recovering.update(child.pid, 'round', read), 'Same round automatically recovers');
		time += 3001;
		assert.equal(recovering.update(child.pid, 'round', read), undefined);
		time += 5000;
		recovering.update(child.pid, 'round', read);
		recovering.update(child.pid, 'round', read);
		assert.equal(recoveryCalls, 3, 'Stopped publications also re-resolve automatically');
		await new Promise((resolve) => setImmediate(resolve));
		recovering.update(child.pid, 'round', read);
		await command('team');
		assert.ok(recovering.update(child.pid, 'round', read));

		let terminatedAttempts = 0;
		const terminated = new NosSnapshotTracker(async () => {
			terminatedAttempts++;
			if (terminatedAttempts <= 2) throw new NosReaderUnexpectedExitError('Reader was terminated');
			return layout;
		});
		terminated.update(child.pid, 'round', read);
		await new Promise((resolve) => setImmediate(resolve));
		terminated.update(child.pid, 'round', read);
		assert.equal(terminatedAttempts, 1);
		time += 5000;
		terminated.update(child.pid, 'round', read);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(terminatedAttempts, 2, 'Retry a terminated helper in the same round');
		time += 9999;
		terminated.update(child.pid, 'round', read);
		assert.equal(terminatedAttempts, 2, 'Back off after repeated helper failures');
		time += 1;
		terminated.update(child.pid, 'round', read);
		await new Promise((resolve) => setImmediate(resolve));
		terminated.update(child.pid, 'round', read);
		await command('team');
		assert.ok(terminated.update(child.pid, 'round', read), 'Recover after helper failures without leaving the round');
	} finally {
		Date.now = now;
	}
	let paletteAttempts = 0;
	const terminatedPalette = new NosPaletteTracker(async () => {
		paletteAttempts++;
		throw new NosPaletteReaderUnexpectedExitError('Reader was terminated');
	});
	terminatedPalette.update(child.pid, read);
	await new Promise((resolve) => setImmediate(resolve));
	terminatedPalette.reset();
	terminatedPalette.update(child.pid, read);
	assert.equal(paletteAttempts, 1, 'Palette lookup also stops after a terminated reader');
	assert.equal(
		tracker.update(child.pid, 'round', () => {
			throw new Error('unavailable');
		}),
		undefined
	);
	assert.match(tracker.message, /unavailable/);
	tracker.reset();
	tracker.update(child.pid, 'round2', read);
	tracker.reset();
	finish(layout);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(tracker.update(child.pid + 1, 'round3', read), undefined);
	await command('clear');
	assert.equal(live().players.length, 0);
	console.log(
		`PASS NoS ${architecture}: costumes, legacy layout, UTF-16 name, RGB, team changes, empty/reset, PID guard, stale clearing`
	);
} finally {
	if (handle) memoryjs.closeProcess(handle.handle);
	child.kill();
	lines.close();
}
