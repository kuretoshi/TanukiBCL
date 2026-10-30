import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';

const entry = resolve('src/main/nosContents.ts');
const result = await build({
	entryPoints: [entry],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node',
	plugins: [
		{
			name: 'optional-baseline',
			setup(builder) {
				builder.onLoad({ filter: /[\\/]nosContents\.ts$/ }, async ({ path }) =>
					process.env.TANUKI_NOS_ZIP_LAZY_BASELINE
						? {
								contents: await readFile(process.env.TANUKI_NOS_ZIP_LAZY_BASELINE, 'utf8'),
								loader: 'ts',
								resolveDir: dirname(path),
							}
						: undefined
				);
			},
		},
	],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
	createRequire(import.meta.url),
	module,
	module.exports
);
const { NosContentsTracker } = module.exports;

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
	for (const [file, bytes] of files) {
		const name = Buffer.from(file),
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

const Jimp = createJimp({ formats: [png] });
const picture = await new Jimp({ width: 1, height: 1, color: 0xff0000ff }).getBuffer('image/png');
const folder = await mkdtemp(join(tmpdir(), 'tanuki-nos-zip-lazy-'));
const roots = [join(folder, 'first'), join(folder, 'second'), join(folder, 'missing-addons')];
const prefix = 'pack/MoreCosmic/';
const archive = zip([
	[
		`${prefix}Contents.json`,
		Buffer.from(
			JSON.stringify({ hats: [{ Author: 'fixture', Name: 'zip' }], visors: [{ Author: 'fixture', Name: 'visor' }] })
		),
	],
	...['front', 'extra', 'mask', 'back', 'back-extra'].map((name) => [`${prefix}hats/${name}.png`, picture]),
	[`${prefix}visors/visor.png`, picture],
	[`${prefix}hats/../../outside.png`, picture],
]);
for (const root of roots) {
	await mkdir(join(root, 'BepInEx', 'MoreCosmic'), { recursive: true });
	await mkdir(join(root, 'Cosmetics'));
	await writeFile(join(root, 'Cosmetics', 'local.png'), picture);
}
for (const root of roots.slice(0, 2)) {
	await mkdir(join(root, 'Addons'));
	await writeFile(join(root, 'Addons', 'fixture.zip'), archive);
}
await writeFile(join(folder, 'outside.png'), picture);

const original = {
	existsSync: fs.existsSync,
	readdirSync: fs.readdirSync,
	openSync: fs.openSync,
	readSync: fs.readSync,
	closeSync: fs.closeSync,
	now: Date.now,
};
const handles = new Set();
const counts = { indexProbes: 0, directories: 0, opens: 0, reads: 0 };
const addonDirectories = new Set(roots.map((root) => resolve(root, 'Addons')));
fs.existsSync = (...args) => {
	if (addonDirectories.has(resolve(String(args[0])))) counts.indexProbes++;
	return original.existsSync(...args);
};
fs.readdirSync = (...args) => {
	if (addonDirectories.has(resolve(String(args[0])))) counts.directories++;
	return original.readdirSync(...args);
};
fs.openSync = (...args) => {
	const handle = original.openSync(...args);
	if (String(args[0]).endsWith('.zip')) {
		counts.opens++;
		handles.add(handle);
	}
	return handle;
};
fs.readSync = (...args) => {
	if (handles.has(args[0])) counts.reads++;
	return original.readSync(...args);
};
fs.closeSync = (handle) => {
	handles.delete(handle);
	return original.closeSync(handle);
};
let now = 10000,
	revision = 0;
Date.now = () => now;
const tracker = new NosContentsTracker();
const image = (Address, extra = {}) => ({ Layer: 'Main', Address, DivisionX: 1, DivisionY: 1, ...extra });
const local = { ProductId: 'local', RelatedRawLocalPath: 'Cosmetics', Images: [image('local.png')] };
const mixed = {
	Version: 20261005,
	Hats: {
		local,
		noshat_fixture_zip: {
			ProductId: 'zip-hat',
			Images: [
				image('front.png', { ExAddress: 'extra.png', MaskAddress: 'mask.png' }),
				image('back.png', { Layer: 'Back', ExAddress: 'back-extra.png' }),
			],
		},
	},
	Visors: { nosvisor_fixture_visor: { ProductId: 'zip-visor', Images: [image('visor.png')] } },
};
async function publish(root, contents) {
	const file = join(root, 'BepInEx', 'MoreCosmic', 'LoadedContents.json');
	await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
	const stamp = new Date(1700000000000 + ++revision * 1000);
	await utimes(file, stamp, stamp);
	now += 2001;
	return tracker.update(root);
}
function expectNoIndex(label) {
	assert.deepEqual(
		counts,
		{ indexProbes: 0, directories: 0, opens: 0, reads: 0 },
		`${label} must not touch addon ZIPs`
	);
}

try {
	assert.equal((await publish(roots[0], { Version: 20261005, Hats: { local } })).status, '読み取り成功');
	assert.ok(tracker.lobbyCosmetics({ skinId: '', visorId: '', hatId: 'local' })?.hat);
	expectNoIndex('local-only manifest');
	await publish(roots[0], { Version: 20261005, Hats: {}, Visors: {}, Skins: {} });
	expectNoIndex('empty manifest');
	assert.match((await publish(roots[0], '{broken')).status, /読み取り失敗/);
	expectNoIndex('malformed JSON');
	assert.match((await publish(roots[0], { ...mixed, Version: 1 })).status, /未対応/);
	expectNoIndex('unsupported version');
	await publish(roots[0], { Version: 20261005, Hats: { invalid: { Images: [image('front.png', { DivisionX: 0 })] } } });
	expectNoIndex('invalid image definition');
	await publish(roots[0], {
		Version: 20261005,
		Hats: {
			missing: { ...local, Images: [image('missing.png')] },
			escaped: { ...local, RelatedRawLocalPath: '..', Images: [image('outside.png')] },
		},
	});
	assert.equal(
		tracker.lobbyCosmetics({ hatId: 'missing' }),
		undefined,
		'missing local images do not fall back to ZIPs'
	);
	assert.equal(tracker.lobbyCosmetics({ hatId: 'escaped' }), undefined, 'local path containment is retained');
	expectNoIndex('unavailable or escaped local images');

	await publish(roots[0], mixed);
	assert.deepEqual(
		counts,
		{ indexProbes: 1, directories: 1, opens: 2, reads: 4 },
		'mixed manifest indexes the actual ZIP once, including Contents.json'
	);
	const parts = tracker.lobbyCosmetics({ hatId: 'zip-hat', visorId: 'zip-visor' });
	assert.deepEqual(Object.keys(parts).sort(), ['bodyMask', 'hat', 'hatBack', 'visor']);
	const assets = [...tracker.assets.values()];
	assert.equal(assets.length, 5, 'local hat plus ZIP front/back/mask/visor are registered');
	assert.ok(
		assets.some(
			(asset) => asset.file.entry === `${prefix}hats/front.png` && asset.extra.entry === `${prefix}hats/extra.png`
		)
	);
	assert.ok(
		assets.some(
			(asset) => asset.file.entry === `${prefix}hats/back.png` && asset.extra.entry === `${prefix}hats/back-extra.png`
		)
	);
	assert.ok(assets.some((asset) => asset.mask && asset.file.entry === `${prefix}hats/mask.png`));
	for (const url of Object.values(parts)) {
		const key = new URL(url).pathname.slice(1);
		assert.ok((await tracker.image(key, '1,1,1'))?.length > 24, 'registered ZIP images still render');
	}
	for (let index = 0; index < 5; index++) tracker.update(roots[0]);
	now += 2001;
	tracker.update(roots[0]);
	assert.equal(counts.indexProbes, 1, 'repeated lookups and unchanged manifest checks do not index again');
	await publish(roots[0], { ...mixed, revision: 2 });
	assert.equal(counts.indexProbes, 2, 'new manifest revision discards the lazy index');
	await publish(roots[1], { Version: 20261005, Hats: { local } });
	assert.equal(counts.indexProbes, 2, 'switching to a local-only game directory does not index');
	await publish(roots[1], mixed);
	assert.equal(counts.indexProbes, 3);
	assert.ok(
		[...tracker.assets.values()]
			.filter((asset) => typeof asset.file !== 'string')
			.every((asset) => asset.file.archive === join(roots[1], 'Addons', 'fixture.zip')),
		'new root cannot retain old archive entries'
	);
	tracker.update(roots[0]);
	assert.equal(counts.indexProbes, 4, 'returning to the first root creates its own index');

	await publish(roots[0], {
		Version: 20261005,
		Hats: { noshat_fixture_zip: { Images: [image('missing.png'), image('../../outside.png', { Layer: 'Back' })] } },
	});
	assert.equal(counts.indexProbes, 5, 'missing ZIP entries share one index attempt');
	assert.equal(
		tracker.lobbyCosmetics({ hatId: 'noshat_fixture_zip' }),
		undefined,
		'missing and unsafe archive paths remain unavailable'
	);
	const directories = counts.directories;
	await publish(roots[2], mixed);
	assert.equal(counts.indexProbes, 6, 'absent addon folder is probed once per manifest');
	assert.equal(counts.directories, directories);
	assert.ok(tracker.lobbyCosmetics({ hatId: 'local' })?.hat, 'local images work when addon folder is absent');
	assert.equal(tracker.lobbyCosmetics({ hatId: 'zip-hat', visorId: 'zip-visor' }), undefined);
	tracker.update(roots[2]);
	assert.equal(counts.indexProbes, 6, 'empty index remains reusable for the current manifest');
	console.log(
		'PASS lazy NoS ZIP index: zero ZIP work for local/empty/invalid/unsupported manifests; one index for mixed front/back/extra/mask/visor, manifest/root reset, missing paths and real PNG rendering'
	);
} finally {
	Object.assign(fs, {
		existsSync: original.existsSync,
		readdirSync: original.readdirSync,
		openSync: original.openSync,
		readSync: original.readSync,
		closeSync: original.closeSync,
	});
	Date.now = original.now;
	assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
	assert.ok(basename(folder).startsWith('tanuki-nos-zip-lazy-'));
	await rm(folder, { recursive: true, force: true });
}
