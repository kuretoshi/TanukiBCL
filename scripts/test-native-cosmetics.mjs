import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import { pathToFileURL } from 'node:url';
import { unityBundleFixture } from './native-voice/unity-bundle-fixture.mjs';
import { zipFixture } from './native-voice/zip-fixture.mjs';
const root = resolve(import.meta.dirname, '..'),
	exe = resolve(process.argv[2] ?? 'src-tauri/target/debug/tanuki-bcl-tauri.exe');
const dir = join(root, '.tools/native-cosmetics', `run-${Date.now()}`),
	game = join(dir, 'game');
await mkdir(join(game, 'BepInEx/MoreCosmic'), { recursive: true });
await mkdir(join(game, 'sprites'), { recursive: true });
const png = (w, h, offset) => {
	const data = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		data[i * 4] = (i * 17 + offset) % 256;
		data[i * 4 + 1] = (i * 53 + offset) % 256;
		data[i * 4 + 2] = (i * 101 + offset) % 256;
		data[i * 4 + 3] = (i * 37 + offset) % 256;
	}
	return PNG.sync.write({ width: w, height: h, data });
};
for (const [name, w, h, n] of [
	['main', 12, 8, 1],
	['extra', 12, 8, 77],
	['mask', 12, 8, 127],
	['large', 315, 390, 41],
])
	await writeFile(join(game, `sprites/${name}.png`), png(w, h, n));
const image = (address, extra, front = false, mask) => ({
	Layer: 'Main',
	Address: `${address}.png`,
	ExAddress: extra ? `${extra}.png` : undefined,
	ExIsFront: front,
	MaskAddress: mask ? `${mask}.png` : undefined,
	DivisionX: 2,
	DivisionY: 2,
});
const costume = (id, images, adaptive = false) => ({
	ProductId: id,
	RelatedRawLocalPath: 'sprites',
	Adaptive: adaptive,
	Images: images,
});
const manifest = {
	Version: 20261005,
	Hats: {
		fixed: costume('fixed', [image('main', 'extra'), { ...image('extra'), Layer: 'Back' }]),
		adaptive: costume('adaptive', [image('main', 'extra', true, 'mask')], true),
		crop: costume('crop', [{ ...image('large'), DivisionX: 1, DivisionY: 1 }]),
		bad: costume('bad', [{ ...image('main'), DivisionX: 5 }]),
	},
	Visors: { visor: costume('visor', [image('extra')]) },
	Skins: { skin: costume('skin', [image('main')], true) },
};
await mkdir(join(game, 'Addons'), { recursive: true });
await writeFile(
	join(game, 'Addons/fixture.zip'),
	zipFixture([
		[
			'fixture/MoreCosmic/Contents.json',
			Buffer.from(
				JSON.stringify({
					hats: [
						{ Author: 'Fixture', Name: 'HatA' },
						{ Author: 'Fixture', Name: 'HatB' },
					],
				})
			),
		],
		['fixture/MoreCosmic/hats/main.png', png(12, 8, 21)],
	])
);
for (const name of ['HatA', 'HatB']) {
	const id = `noshat_Fixture_${name}`;
	manifest.Hats[id] = { ...costume(id, [image('main')], true), RelatedRawLocalPath: undefined };
}
await writeFile(join(game, 'BepInEx/MoreCosmic/LoadedContents.json'), '\ufeff' + JSON.stringify(manifest));
const oracleFile = join(dir, 'oracle.cjs');
await build({
	stdin: {
		contents:
			"export {NosContentsTracker} from './src/main/nosContents';export {findSnrCosmeticFile} from './src/main/snrCosmetics';",
		resolveDir: root,
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: oracleFile,
	logLevel: 'warning',
});
const { NosContentsTracker, findSnrCosmeticFile } = createRequire(import.meta.url)(oracleFile);
const tracker = new NosContentsTracker();
tracker.update(game);
const requests = [];
for (const hat of ['fixed', 'adaptive', 'crop', 'bad', 'noshat_Fixture_HatA', 'noshat_Fixture_HatB'])
	for (const rgb of [
		[1, 0, 0],
		[0.2, 0.5, 0.8],
		[1, 1, 1],
	])
		requests.push({
			player: {
				id: 1,
				nosPlayer: {
					hat: { name: hat },
					visor: { name: 'visor' },
					skin: { name: 'skin' },
					colorR: rgb[0],
					colorG: rgb[1],
					colorB: rgb[2],
				},
			},
		});
await mkdir(join(game, 'SuperNewRolesNext/CustomCosmetics/pack'), { recursive: true });
await writeFile(join(game, 'SuperNewRolesNext/CustomCosmetics/pack/hat_front.png'), png(12, 8, 13));
requests.push({ player: {}, snrId: 'Modded_<b>pack</b>_hat', snrPart: 'hat-front' });
const bundleDirectory = join(game, 'SuperNewRolesNext/CustomCosmetics/generated.bundle');
await mkdir(bundleDirectory, { recursive: true });
await writeFile(join(bundleDirectory, 'generated.bundle'), unityBundleFixture().bundle);
requests.push({ player: {}, snrId: 'Modded_bundlepack_hat', snrPart: 'hat-front' });
const bundleOracleFile = join(dir, 'bundle-oracle.mjs');
await build({
	stdin: { contents: "export {findSnrBundledCosmeticFile} from './src/main/snrBundleCosmetics';", resolveDir: root },
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['unity-asset-reader-node', 'unity-asset-reader-texture', 'pngjs'],
	outfile: bundleOracleFile,
	logLevel: 'warning',
});
const { findSnrBundledCosmeticFile } = await import(pathToFileURL(bundleOracleFile));
const input = join(dir, 'input.json'),
	output = join(dir, 'output.json');
await writeFile(input, JSON.stringify({ root: game, requests, palette: [['#ff0000', '#880000']] }));
await new Promise((done, fail) => {
	const p = spawn(exe, ['--rust-cosmetic-probe', input, '--probe-output', output], {
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let errors = '';
	p.stderr.on('data', (b) => (errors += b));
	p.once('error', fail);
	p.once('exit', (code) => (code ? fail(new Error(errors)) : done()));
});
const native = JSON.parse(await readFile(output));
let checked = 0;
for (const [index, request] of requests.entries()) {
	if (request.snrId) {
		const source =
			findSnrCosmeticFile(join(game, 'Among Us.exe'), request.snrId, request.snrPart) ??
			(await findSnrBundledCosmeticFile(
				join(game, 'Among Us.exe'),
				request.snrId,
				request.snrPart,
				join(dir, 'cache')
			));
		assert.ok(source, 'Generated UnityFS texture is readable by the release parser');
		const actual = PNG.sync.read(Buffer.from(native.results[index].images.snr, 'base64')),
			expected = PNG.sync.read(await readFile(source));
		assert.deepEqual(actual.data, expected.data, 'SNR UnityFS/folder texture pixels');
		checked++;
		continue;
	}
	const sources = tracker.cosmetics(request.player.nosPlayer);
	assert.deepEqual(Object.keys(native.results[index].images).sort(), Object.keys(sources).sort());
	for (const [part, source] of Object.entries(sources)) {
		const url = new URL(source),
			expected = await tracker.image(url.pathname.slice(1), url.searchParams.get('color'));
		const actual = native.results[index].images[part];
		if (!expected) {
			assert.equal(actual, null);
			continue;
		}
		const a = PNG.sync.read(Buffer.from(actual, 'base64')),
			b = PNG.sync.read(expected);
		assert.equal(a.width, b.width);
		assert.equal(a.height, b.height);
		assert.deepEqual(a.data, b.data, `${index}:${part}`);
		checked++;
	}
}
const report = {
	passed: true,
	requests: requests.length,
	imagesCompared: checked,
	checks: [
		'release NoS renderer pixel parity',
		'fixed/adaptive colors',
		'front/back/extras/body masks',
		'sprite sheets and cropping',
		'invalid divisions',
		'SNR folder and markup IDs',
	],
};
await writeFile(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, directory: dir }));
