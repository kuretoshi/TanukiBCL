import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { PNG } from 'pngjs';
const cache = resolve('.cache/snr-adaptive-color');
await mkdir(cache, { recursive: true });
const bundle = await build({
	entryPoints: ['src/main/avatarGenerator.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
	loader: { '.png': 'dataurl' },
	plugins: [
		{
			name: 'electron-data-dir',
			setup(b) {
				if (process.env.TANUKI_SNR_COLOR_BASELINE)
					b.onLoad({ filter: /[\\/]avatarGenerator\.ts$/ }, async (args) => ({
						contents: await readFile(process.env.TANUKI_SNR_COLOR_BASELINE, 'utf8'),
						loader: 'ts',
						resolveDir: resolve(args.path, '..'),
					}));
				b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
				b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
					contents: `export const app={getPath:()=>${JSON.stringify(cache)}};`,
				}));
			},
		},
	],
});
await writeFile(join(cache, 'generator.mjs'), bundle.outputFiles[0].contents);
const { GenerateHat } = await import(pathToFileURL(join(cache, 'generator.mjs')));
const image = new PNG({ width: 300, height: 375 });
image.data.fill(0);
image.data.set([255, 0, 0, 255, 0, 0, 255, 128, 0, 255, 0, 255, 50, 50, 50, 0]);
const input = join(cache, 'input.png');
await writeFile(input, PNG.sync.write(image));
const colors = [
	['#117f2d', '#0a4d2e'],
	['#203040', '#506070'],
];
const first = await GenerateHat(pathToFileURL(input), colors, 0);
assert.ok(first, 'Local file URL can be read without unsupported fetch(file:)');
const decoded = PNG.sync.read(await readFile(first));
assert.equal(decoded.width, 300);
assert.equal(decoded.height, 375);
assert.deepEqual(
	[...decoded.data.subarray(0, 16)],
	[17, 127, 45, 255, 10, 77, 46, 128, 154, 202, 213, 255, 50, 50, 50, 0]
);
const second = await GenerateHat(pathToFileURL(input), colors, 1);
assert.notEqual(first, second);
assert.deepEqual([...PNG.sync.read(await readFile(second)).data.subarray(0, 4)], [32, 48, 64, 255]);
for (let i = 3; i < image.data.length; i += 4) assert.equal(decoded.data[i], image.data[i]);
console.log(
	'PASS actual SNR recoloring: local file URLs, body/shadow/visor masks, color changes and full canvas/alpha preservation'
);
