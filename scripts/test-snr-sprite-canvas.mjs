import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import console from 'node:console';
const bundle = await build({
	entryPoints: ['src/main/snrSpriteCanvas.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
});
const { restoreSnrSpriteCanvas } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);
const image = {
	width: 2,
	height: 2,
	rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 1, 2, 3, 0]),
};
const canvas = restoreSnrSpriteCanvas(image, { width: 8, height: 6 }, { x: 2.076, y: 1.076 });
assert.equal(canvas.rgba.length, 8 * 6 * 4);
const expected = new Uint8Array(8 * 6 * 4);
expected.set(image.rgba.subarray(0, 8), (3 * 8 + 2) * 4);
expected.set(image.rgba.subarray(8), (4 * 8 + 2) * 4);
assert.deepEqual(canvas.rgba, expected, 'Original canvas, bottom-origin offset and every RGBA channel are preserved');
assert.deepEqual(restoreSnrSpriteCanvas(image, { width: 2, height: 2 }, { x: 0, y: 0 }), image);
for (const [rect, offset] of [
	[
		{ width: 0, height: 6 },
		{ x: 0, y: 0 },
	],
	[
		{ width: 4097, height: 6 },
		{ x: 0, y: 0 },
	],
	[
		{ width: 8, height: 6 },
		{ x: -1, y: 0 },
	],
	[
		{ width: 8, height: 6 },
		{ x: 7, y: 0 },
	],
	[
		{ width: 8, height: 6 },
		{ x: 0, y: 5 },
	],
	[
		{ width: 8, height: 6 },
		{ x: NaN, y: 0 },
	],
	[
		{ width: 8, height: 6 },
		{ x: 0.4, y: 0 },
	],
])
	assert.throws(() => restoreSnrSpriteCanvas(image, rect, offset));
console.log(
	'PASS SNR sprite: full canvas, fractional exporter offsets, bottom origin, alpha preservation and bounded geometry'
);
