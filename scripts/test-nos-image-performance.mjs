import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm, rename, unlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';

async function load(file) {
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
	const module = { exports: {} };
	const { createRequire } = await import('node:module');
	new Function('require', 'module', 'exports', result.outputFiles[0].text)(
		createRequire(import.meta.url),
		module,
		module.exports
	);
	return module.exports;
}
// A stored ZIP fixture with real headers; no image decoding is needed to index it.
function crc32(bytes) {
	let crc = -1;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ -1) >>> 0;
}
function zip(files) {
	const local = [],
		central = [];
	let offset = 0;
	for (const [path, bytes] of files) {
		const name = Buffer.from(path),
			header = Buffer.alloc(30),
			directory = Buffer.alloc(46);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc32(bytes), 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(name.length, 26);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(crc32(bytes), 16);
		directory.writeUInt32LE(bytes.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(offset, 42);
		local.push(header, name, bytes);
		central.push(directory, name);
		offset += header.length + name.length + bytes.length;
	}
	const directory = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

async function verifyAddonCache(readNosAddonIds, folder, files) {
	const archive = join(folder, 'Addons', 'fixture.zip');
	const originalOpen = fs.openSync,
		originalRead = fs.readSync;
	let opens = 0,
		reads = 0;
	fs.openSync = (...args) => {
		opens++;
		return originalOpen(...args);
	};
	fs.readSync = (...args) => {
		reads++;
		return originalRead(...args);
	};
	try {
		assert.deepEqual(readNosAddonIds(folder), ['audit.initial']);
		const cold = { opens, reads };
		for (let i = 0; i < 5; i++) assert.deepEqual(readNosAddonIds(folder), ['audit.initial']);
		assert.equal(opens, cold.opens, 'unchanged ZIPs must not be reopened for addon detection');
		assert.equal(reads, cold.reads, 'unchanged ZIP entry tables and metadata must not be reread');
		console.log(
			`NoS addon detection: cold ${cold.opens} opens / ${cold.reads} reads; 5 unchanged checks: 0 extra reads`
		);
	} finally {
		fs.openSync = originalOpen;
		fs.readSync = originalRead;
	}

	const previous = await stat(archive);
	const replacement = zip([['addon.meta', Buffer.from('{"Id":"audit.changed","Hidden":True}')], ...files.slice(1)]);
	assert.equal(replacement.length, previous.size);
	await writeFile(archive, replacement);
	await utimes(archive, previous.atime, previous.mtime);
	assert.deepEqual(
		readNosAddonIds(folder),
		['audit.changed'],
		'same-size edits with restored mtime invalidate the cache'
	);
	const added = join(folder, 'Addons', 'added.zip');
	await writeFile(added, zip([['nested/addon.meta', Buffer.from('{"Id":"audit.second"}')]]));
	assert.deepEqual(readNosAddonIds(folder), ['audit.changed', 'audit.second'], 'new addons are discovered');
	await unlink(archive);
	assert.deepEqual(readNosAddonIds(folder), ['audit.second'], 'removed addons stop being detected');
	await writeFile(archive, zip(files));
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.second'], 'a recreated path is read afresh');
	await rename(added, join(folder, 'Addons', 'RENAMED.ZIP'));
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.second'], 'renames and uppercase extensions work');
	await writeFile(join(folder, 'Addons', 'broken.zip'), Buffer.from('broken'));
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.second'], 'a bad ZIP does not hide valid addons');
	await writeFile(join(folder, 'Addons', 'broken.zip'), zip([['addon.meta', Buffer.from('{"Id":"audit.recovered"}')]]));
	assert.deepEqual(
		readNosAddonIds(folder),
		['audit.initial', 'audit.recovered', 'audit.second'],
		'bad ZIPs can recover'
	);

	const originalStat = fs.statSync;
	fs.statSync = (file, ...args) => {
		if (file === fs.realpathSync(archive)) throw new Error('temporarily unreadable');
		return originalStat(file, ...args);
	};
	try {
		assert.deepEqual(
			readNosAddonIds(folder),
			['audit.recovered', 'audit.second'],
			'unreadable cached addons fail closed'
		);
	} finally {
		fs.statSync = originalStat;
	}
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.recovered', 'audit.second']);

	const originalRealpath = fs.realpathSync;
	fs.realpathSync = (file, ...args) =>
		file === archive ? resolve(folder, '..', 'outside.zip') : originalRealpath(file, ...args);
	try {
		assert.deepEqual(
			readNosAddonIds(folder),
			['audit.recovered', 'audit.second'],
			'recheck path bounds before cache hits'
		);
	} finally {
		fs.realpathSync = originalRealpath;
	}
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.recovered', 'audit.second']);
	await writeFile(archive, replacement);
	let stats = 0;
	fs.statSync = (file, ...args) => {
		const value = originalStat(file, ...args);
		if (file === fs.realpathSync(archive) && ++stats === 2) return { ...value, ctimeNs: value.ctimeNs + 1n };
		return value;
	};
	try {
		assert.deepEqual(readNosAddonIds(folder), ['audit.recovered', 'audit.second'], 'reject ZIPs changed during a read');
	} finally {
		fs.statSync = originalStat;
	}
	assert.deepEqual(readNosAddonIds(folder), ['audit.changed', 'audit.recovered', 'audit.second']);
	await writeFile(archive, zip(files));
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.recovered', 'audit.second']);
	assert.deepEqual(
		readNosAddonIds(join(folder, 'missing')),
		[],
		'switching game directories cannot reuse stale addons'
	);
	assert.deepEqual(readNosAddonIds(folder), ['audit.initial', 'audit.recovered', 'audit.second']);
}

async function verifyImageColorCache(NosContentsTracker, folder) {
	const Jimp = createJimp({ formats: [png] });
	const file = join(folder, 'color-cache.png');
	const pixels = Buffer.alloc(300 * 375 * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = 255;
		pixels[i + 3] = 255;
	}
	await writeFile(file, await Jimp.fromBitmap({ width: 300, height: 375, data: pixels }).getBuffer('image/png'));
	const tracker = new NosContentsTracker();
	const readFile = fs.promises.readFile;
	let sourceReads = 0;
	fs.promises.readFile = (...args) => {
		if (String(args[0]).endsWith('color-cache.png')) sourceReads++;
		return readFile(...args);
	};
	try {
		tracker.root = fs.realpathSync(folder);
		const base = { file, extraInFront: false, columns: 1, rows: 1, adaptive: false };
		tracker.assets.set('fixed', base);
		tracker.assets.set('mask', { ...base, mask: true });
		tracker.assets.set('adaptive', { ...base, adaptive: true });
		tracker.costumes.set('hat:fixed', { hat: 'fixed', bodyMask: 'mask' });
		tracker.costumes.set('hat:adaptive', { hat: 'adaptive' });
		const colors = ['1,0,0', '0,1,0', '0,0,1'];
		let renders = 0;
		const render = tracker.render.bind(tracker);
		tracker.render = (...args) => {
			renders++;
			return render(...args);
		};
		for (const key of ['fixed', 'mask']) {
			const before = renders;
			const output = await Promise.all(colors.map((color) => tracker.image(key, color)));
			assert.ok(output.every(Buffer.isBuffer));
			assert.equal(renders - before, 1, `${key}: concurrent different player colors share one render`);
			assert.ok(output.every((bytes) => bytes.equals(output[0])));
		}
		const before = renders;
		const adaptive = await Promise.all(colors.map((color) => tracker.image('adaptive', color)));
		assert.equal(renders - before, 3, 'adaptive costumes still render each player color');
		assert.ok(adaptive.every(Buffer.isBuffer));
		assert.ok(!adaptive[0].equals(adaptive[1]) && !adaptive[1].equals(adaptive[2]));
		const appearance = (name, color) => {
			const [colorR, colorG, colorB] = color.split(',').map(Number);
			return tracker.cosmetics({ hat: { name }, colorR, colorG, colorB });
		};
		const fixedUrls = colors.map((color) => appearance('fixed', color));
		assert.ok(fixedUrls.every((urls) => urls.hat === fixedUrls[0].hat && urls.bodyMask === fixedUrls[0].bodyMask));
		assert.equal(new Set(colors.map((color) => appearance('adaptive', color).hat)).size, 3);
		assert.equal(tracker.images.size, 5, 'one fixed image, one mask and three tinted images');
		assert.equal(
			await tracker.image('fixed', 'invalid'),
			undefined,
			'invalid colors cannot bypass validation via cache'
		);
		assert.equal(await tracker.image('fixed', '2,0,0'), undefined);
		assert.equal(sourceReads, 1, 'fixed, mask and three adaptive outputs share one source PNG decode');
		const changed = Buffer.from(pixels);
		for (let i = 0; i < changed.length; i += 4) {
			changed[i] = 0;
			changed[i + 2] = 255;
		}
		await writeFile(file, await Jimp.fromBitmap({ width: 300, height: 375, data: changed }).getBuffer('image/png'));
		assert.ok(await tracker.image('adaptive', '0.5,0.5,0.5'));
		assert.equal(sourceReads, 2, 'replaced source files are decoded again for new tints');
		const late = new NosContentsTracker();
		late.root = tracker.root;
		late.assets.set('late', { ...base, adaptive: true });
		let release, started;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const reading = new Promise((resolve) => {
			started = resolve;
		});
		fs.promises.readFile = async (...args) => {
			started();
			await gate;
			return readFile(...args);
		};
		const pending = late.image('late', '0,1,0');
		await reading;
		late.clear();
		release();
		assert.ok(await pending);
		assert.equal(late.decoded.size, 0, 'late decodes cannot repopulate a cleared manifest cache');
		assert.equal(late.decodedBytes, 0);
		console.log('NoS PNG renders across 3 player colors: fixed 3 -> 1, mask 3 -> 1, adaptive remains 3');
		console.log(
			'NoS source PNG reads/decodes across all five outputs: 5 -> 1; source replacement and late completion guarded'
		);
	} finally {
		fs.promises.readFile = readFile;
	}
}

async function verifyDecodedBudget(NosContentsTracker, folder) {
	const Jimp = createJimp({ formats: [png] });
	const pngBytes = await Jimp.fromBitmap({
		width: 1024,
		height: 1024,
		data: Buffer.alloc(1024 * 1024 * 4, 255),
	}).getBuffer('image/png');
	const tracker = new NosContentsTracker();
	tracker.root = fs.realpathSync(folder);
	const files = Array.from({ length: 5 }, (_, i) => join(folder, `budget-${i}.png`));
	await Promise.all(files.map((file) => writeFile(file, pngBytes)));
	for (const file of files) await tracker.source(file);
	assert.ok(tracker.decodedBytes <= 16 * 1024 * 1024, 'decoded RGBA cache has a byte budget');
	assert.equal(tracker.decoded.size, 4, 'only four 4MiB sources fit');
	const readFile = fs.promises.readFile;
	let reads = 0;
	fs.promises.readFile = (...args) => {
		reads++;
		return readFile(...args);
	};
	try {
		await tracker.source(files[4]);
		assert.equal(reads, 0, 'recent sources remain cached');
		await tracker.source(files[0]);
		assert.equal(reads, 1, 'oldest decoded source is evicted');
	} finally {
		fs.promises.readFile = readFile;
	}
	tracker.clear();
	assert.equal(tracker.decodedBytes, 0);
}
const folder = await mkdtemp(join(tmpdir(), 'tanuki-nos-image-perf-'));
try {
	await mkdir(join(folder, 'Addons'));
	const hats = Array.from({ length: 800 }, (_, id) => ({ Author: 'test', Name: String(id) }));
	const files = [
		['addon.meta', Buffer.from('{"Id":"audit.initial","Hidden":True}')],
		['MoreCosmic/Contents.json', Buffer.from(JSON.stringify({ hats, visors: [{ Author: 'test', Name: 'visor' }] }))],
	];
	for (let i = 0; i < 1200; i++) files.push([`MoreCosmic/hats/${i}.png`, Buffer.from([i & 255])]);
	files.push(['MoreCosmic/visors/visor.png', Buffer.from([99])]);
	await writeFile(join(folder, 'Addons', 'fixture.zip'), zip(files));
	const { indexNosAddonImages, readNosZipImage, readNosAddonIds } = await load(
		process.env.TANUKI_IMAGE_INDEX_SOURCE ?? 'src/main/nosAddonImages.ts'
	);
	const start = performance.now();
	const index = indexNosAddonImages(folder);
	const duration = performance.now() - start;
	assert.equal(index.size, 801);
	const unique = new Set(index.values());
	console.log(
		`800 hats / 1200 images: ${unique.size} image tables, ${[...unique].reduce((n, table) => n + table.size, 0)} entries, ${duration.toFixed(1)} ms`
	);
	assert.equal(unique.size, 2, 'share one image table per category instead of copying it per costume');
	assert.equal(index.get('noshat_test_0').size, 1200);
	assert.equal(index.get('nosvisor_test_visor').size, 1, 'category boundaries remain separate');
	assert.deepEqual(readNosZipImage(index.get('noshat_test_799').get('1199.png')), Buffer.from([1199 & 255]));
	await verifyAddonCache(readNosAddonIds, folder, files);

	const { NosContentsTracker } = await load(process.env.TANUKI_IMAGE_CACHE_SOURCE ?? 'src/main/nosContents.ts');
	await verifyImageColorCache(NosContentsTracker, folder);
	await verifyDecodedBudget(NosContentsTracker, folder);
	const tracker = new NosContentsTracker();
	// Count costly renders without spending the test's time decoding hundreds of PNGs.
	let renders = 0;
	tracker.render = async () => Buffer.from([++renders & 255]);
	for (let i = 0; i < 130; i++) tracker.assets.set(String(i), { adaptive: true });
	for (let i = 0; i < 128; i++) await tracker.image(String(i), '1,0,0');
	await tracker.image('0', '1,0,0'); // Keep this frequently used image resident.
	await tracker.image('128', '1,0,0');
	assert.equal(tracker.images.size, 128, 'cache stays bounded');
	await tracker.image('0', '1,0,0');
	await tracker.image('127', '1,0,0');
	assert.equal(renders, 129, 'crossing the limit must not rerender recent images');
	await tracker.image('1', '1,0,0');
	assert.equal(renders, 130, 'only the least recently used image was evicted');
	let finish;
	tracker.render = () => {
		renders++;
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	const pending = tracker.image('129', '1,0,0');
	const duplicate = tracker.image('129', '1,0,0');
	finish(Buffer.from([1]));
	assert.deepEqual(await pending, await duplicate);
	assert.equal(renders, 131, 'concurrent identical requests share rendering');
	tracker.render = async () => {
		throw new Error('bad image');
	};
	assert.equal(await tracker.image('129', '0,0,0'), undefined);
	tracker.render = async () => Buffer.from([2]);
	assert.deepEqual(await tracker.image('129', '0,0,0'), Buffer.from([2]), 'failed images can be retried');
	tracker.images.clear();
	let failDisplaced;
	tracker.render = () => new Promise((resolve) => (failDisplaced = resolve));
	const displaced = tracker.image('0', '0,1,0');
	let replacements = 0;
	tracker.render = async () => {
		replacements++;
		return Buffer.from([3]);
	};
	for (let i = 1; i <= 128; i++) await tracker.image(String(i), '0,1,0');
	await tracker.image('0', '0,1,0');
	failDisplaced(undefined);
	assert.equal(await displaced, undefined);
	await tracker.image('0', '0,1,0');
	assert.equal(replacements, 129, 'an evicted request failing late must not remove its replacement');
	console.log('PASS NoS image index sharing, ZIP reads, bounded LRU, concurrent requests and retry');
} finally {
	assert.ok(
		resolve(folder).startsWith(resolve(tmpdir()) + '\\tanuki-nos-image-perf-') ||
			resolve(folder).startsWith(resolve(tmpdir()) + '/tanuki-nos-image-perf-')
	);
	await rm(folder, { recursive: true, force: true });
}
