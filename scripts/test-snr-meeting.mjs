import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const directory = resolve('.cache/snr-meeting');
await mkdir(directory, { recursive: true });
async function bundle(file) {
	const output = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	const path = resolve(directory, file.replaceAll('/', '-') + '.mjs');
	await writeFile(path, output.outputFiles[0].contents);
	return import('file:///' + path.replaceAll('\\', '/'));
}
const { readSnrMeeting } = await bundle('src/main/snrMeetingMemory.ts');
const { snrMeetingPage } = await bundle('src/common/SnrMeeting.ts');
let assertions = 0;
const equal = (actual, expected) => {
	assert.deepEqual(actual, expected);
	assertions++;
};
for (const pointerSize of [4, 8]) {
	const memory = new Map();
	const base = pointerSize === 8 ? 0x100000000 : 0x100000;
	const at = (offset) => base + offset;
	const block = (address, size) => {
		const value = Buffer.alloc(size);
		memory.set(address, value);
		return value;
	};
	const put = (buffer, offset, value) =>
		pointerSize === 8 ? buffer.writeBigUInt64LE(BigInt(value), offset) : buffer.writeUInt32LE(value, offset);
	const m = {
		enabledSlot: at(1),
		pageSlot: at(4),
		areasSlot: at(8),
		listType: at(0x1000),
		itemsType: at(0x2000),
		voteAreaType: at(0x3000),
		nativeClass: at(0x4000),
		itemsOffset: pointerSize,
		countOffset: pointerSize * 2,
		versionOffset: pointerSize * 2 + 4,
		pooledPtrOffset: pointerSize,
		playerIdOffset: pointerSize * 2,
	};
	const layout = { pointerSize, arrayDataOffset: pointerSize * 2, meeting: m };
	const slots = block(base, 32),
		list = block(at(0x5000), 32),
		items = block(at(0x6000), 512 * pointerSize);
	slots[1] = 1;
	slots.writeInt32LE(1, 4);
	put(slots, 8, at(0x5000));
	put(list, 0, m.listType);
	put(list, m.itemsOffset, at(0x6000));
	list.writeInt32LE(45, m.countOffset);
	list.writeInt32LE(13, m.versionOffset);
	put(items, 0, m.itemsType);
	items.writeInt32LE(45, pointerSize);
	const ids = Array.from({ length: 45 }, (_, i) => 44 - i);
	for (let i = 0; i < ids.length; i++) {
		const wrapper = block(at(0x10000 + i * 0x100), 32),
			native = block(at(0x20000 + i * 0x100), 32);
		put(items, layout.arrayDataOffset + i * pointerSize, at(0x10000 + i * 0x100));
		put(wrapper, 0, m.voteAreaType);
		put(wrapper, m.pooledPtrOffset, at(0x20000 + i * 0x100));
		put(native, 0, m.nativeClass);
		native[m.playerIdOffset] = ids[i];
	}
	const read = (address, size) => {
		for (const [start, bytes] of memory)
			if (address >= start && address + size <= start + bytes.length)
				return bytes.subarray(address - start, address - start + size);
		throw Error('Unmapped fixture read');
	};
	const players = ids.map((id) => ({ id })).reverse();
	for (const currentPage of [1, 2, 3, 1]) {
		slots.writeInt32LE(currentPage, 4);
		const result = readSnrMeeting(layout, read);
		equal(result, { enabled: true, currentPage, playerIds: ids });
		equal(
			snrMeetingPage('SUPER_NEW_ROLES', players, result).map((p) => p.id),
			ids.slice((currentPage - 1) * 15, currentPage * 15)
		);
	}
	slots.writeInt32LE(2, 4);
	equal(
		snrMeetingPage(
			'SUPER_NEW_ROLES',
			players.filter((p) => p.id !== 28),
			readSnrMeeting(layout, read)
		)[1],
		undefined
	);
	const listMoved = block(at(0x7000), list.length);
	list.copy(listMoved);
	put(slots, 8, at(0x7000));
	const arrayMoved = block(at(0x8000), items.length);
	items.copy(arrayMoved);
	put(listMoved, m.itemsOffset, at(0x8000));
	equal(readSnrMeeting(layout, read)?.currentPage, 2);
	let pageReads = 0;
	equal(
		readSnrMeeting(layout, (a, s) => {
			if (a === m.pageSlot && ++pageReads === 2) slots.writeInt32LE(3, 4);
			return read(a, s);
		}),
		undefined
	);
	let versionReads = 0;
	equal(
		readSnrMeeting(layout, (a, s) => {
			if (a === at(0x7000) + m.versionOffset && ++versionReads === 2) listMoved.writeInt32LE(14, m.versionOffset);
			return read(a, s);
		}),
		undefined
	);
	slots.writeInt32LE(4, 4);
	equal(readSnrMeeting(layout, read), undefined);
	slots.writeInt32LE(1, 4);
	const native = memory.get(at(0x20000));
	native[m.playerIdOffset] = 255;
	equal(readSnrMeeting(layout, read), undefined);
	native[m.playerIdOffset] = 43;
	equal(readSnrMeeting(layout, read), undefined);
	native[m.playerIdOffset] = 44;
	put(native, 0, at(0x9000));
	equal(readSnrMeeting(layout, read), undefined);
	put(native, 0, m.nativeClass);
	slots[1] = 0;
	equal(readSnrMeeting(layout, read), { enabled: false, currentPage: 1, playerIds: [] });
	equal(readSnrMeeting({ ...layout, meeting: null }, read), undefined);
}
equal(snrMeetingPage('NoS', [{ id: 1 }], { enabled: true, currentPage: 1, playerIds: [1] }), undefined);
equal(
	snrMeetingPage(
		'SUPER_NEW_ROLES',
		Array.from({ length: 16 }, (_, id) => ({ id }))
	),
	[]
);
equal(snrMeetingPage('SUPER_NEW_ROLES', [{ id: 1 }]), undefined);
equal(snrMeetingPage('SUPER_NEW_ROLES', [{ id: 1 }], { enabled: true, currentPage: 1, playerIds: [1, 1] }), []);
console.log(
	`PASS SNR memory/page policy: ${assertions} x86/x64, moving references, torn read, missing identity and invalid-page assertions`
);

if (process.argv.includes('--unit-only')) process.exit(0);
// Use an Electron host for memoryjs; never open or modify the real game process.
const require = createRequire(import.meta.url);
const electron = require('electron');
for (const arch of ['x64', 'x86']) {
	const output = resolve(directory, arch);
	const compiler = arch === 'x86' ? 'C:/Program Files (x86)/dotnet/dotnet.exe' : 'dotnet';
	const hostArgs = [
		'publish',
		'scripts/fixtures/snr-reader/Host/Host.csproj',
		'-c',
		'Release',
		'-r',
		`win-${arch}`,
		'--self-contained',
		'true',
		'-o',
		output,
		'-v',
		'quiet',
	];
	execFileSync('dotnet', hostArgs, { windowsHide: true, stdio: 'pipe' });
	execFileSync(
		'dotnet',
		['build', 'scripts/fixtures/snr-reader/Plugin/Plugin.csproj', '-c', 'Release', '-o', output, '-v', 'quiet'],
		{ windowsHide: true, stdio: 'pipe' }
	);
	const readerDir = resolve(directory, `reader-${arch}`);
	execFileSync(
		'dotnet',
		[
			'build',
			'tools/SnrRoleReader/SnrRoleReader.csproj',
			'-c',
			'Release',
			'-r',
			`win-${arch}`,
			'--no-self-contained',
			'-o',
			readerDir,
			'-v',
			'quiet',
		],
		{ windowsHide: true, stdio: 'pipe' }
	);
	const child = spawn(resolve(output, 'Among Us.exe'), ['live', resolve(output, 'ready')], { windowsHide: true });
	const lines = [];
	const reader = createInterface({ input: child.stdout });
	reader.on('line', (line) => lines.push(line));
	const wait = async (predicate) => {
		const end = Date.now() + 15000;
		while (!predicate()) {
			if (Date.now() > end) throw Error('Fixture timeout');
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	try {
		await wait(() => lines.includes('ready'));
		const discovery = JSON.parse(
			execFileSync(compiler, [resolve(readerDir, 'SnrRoleReader.dll'), String(child.pid)], {
				windowsHide: true,
				encoding: 'utf8',
			})
		);
		assert.equal(discovery.status, 'ok');
		assert.equal(discovery.liveLayout.pointerSize, arch === 'x64' ? 8 : 4);
		assert.ok(discovery.liveLayout.meeting, 'Real CLR discovery must resolve the manager and native field metadata');
		const input = resolve(output, 'layout.json');
		await writeFile(input, JSON.stringify(discovery.liveLayout));
		const runner = resolve(output, 'read.cjs');
		await build({
			stdin: {
				contents: `const fs=require('fs'),m=require('memoryjs');const {readSnrMeeting}=require(${JSON.stringify(resolve('src/main/snrMeetingMemory.ts'))});const h=m.openProcess(${child.pid}).handle;try {console.log('SAMPLE:'+JSON.stringify(readSnrMeeting(JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8')),(a,s)=>m.readBuffer(h,a,s))));}finally{m.closeProcess(h);}`,
				resolveDir: process.cwd(),
				loader: 'ts',
			},
			bundle: true,
			platform: 'node',
			format: 'cjs',
			packages: 'external',
			outfile: runner,
		});
		const sample = () => {
			const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') };
			const out = execFileSync(electron, [runner], { env, windowsHide: true, encoding: 'utf8' });
			return JSON.parse(
				out
					.split(/\r?\n/)
					.find((l) => l.startsWith('SAMPLE:'))
					.slice(7)
			);
		};
		equal(sample(), { enabled: true, currentPage: 1, playerIds: Array.from({ length: 45 }, (_, i) => 44 - i) });
		const command = async (value) => {
			const start = lines.length;
			child.stdin.write(value + '\n');
			await wait(() => lines.slice(start).includes(value));
		};
		for (const page of [2, 3, 1]) {
			await command(`page-${page}`);
			equal(sample().currentPage, page);
		}
		await command('gc');
		equal(
			sample().playerIds,
			Array.from({ length: 45 }, (_, i) => 44 - i)
		);
		await command('meeting-replace');
		equal(
			sample().playerIds,
			Array.from({ length: 45 }, (_, i) => i)
		);
		await command('meeting-off');
		equal(sample(), { enabled: false, currentPage: 1, playerIds: [] });
		console.log(
			`PASS live ${arch} CLR SNR page switching, compacting GC and list replacement using ONE snapshot discovery`
		);
	} finally {
		reader.close();
		child.kill();
	}
}
