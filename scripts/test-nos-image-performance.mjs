import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const folder = await mkdtemp(join(tmpdir(), 'tanuki-nos-image-perf-'));
try {
	await mkdir(join(folder, 'Addons'));
	const hats = Array.from({ length: 800 }, (_, id) => ({ Author: 'test', Name: String(id) }));
	const files = [
		['MoreCosmic/Contents.json', Buffer.from(JSON.stringify({ hats, visors: [{ Author: 'test', Name: 'visor' }] }))],
	];
	for (let i = 0; i < 1200; i++) files.push([`MoreCosmic/hats/${i}.png`, Buffer.from([i & 255])]);
	files.push(['MoreCosmic/visors/visor.png', Buffer.from([99])]);
	await writeFile(join(folder, 'Addons', 'fixture.zip'), zip(files));
	const { indexNosAddonImages, readNosZipImage } = await load(
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

	const { NosContentsTracker } = await load(process.env.TANUKI_IMAGE_CACHE_SOURCE ?? 'src/main/nosContents.ts');
	const tracker = new NosContentsTracker();
	// Count costly renders without spending the test's time decoding hundreds of PNGs.
	let renders = 0;
	tracker.render = async () => Buffer.from([++renders & 255]);
	for (let i = 0; i < 130; i++) tracker.assets.set(String(i), {});
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
