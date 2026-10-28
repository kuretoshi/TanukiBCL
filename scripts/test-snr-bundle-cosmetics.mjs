import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';

const output = resolve('.tools/test-cache/snr-bundle-cosmetics.mjs');
await mkdir(resolve('.tools/test-cache'), { recursive: true });
const bundled = await build({
	entryPoints: ['src/main/snrBundleCosmetics.ts'],
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	write: false,
});
await writeFile(output, bundled.outputFiles[0].contents);
const { findSnrBundledCosmeticFile } = await import(pathToFileURL(output).href);
const workerOutput = resolve('.tools/test-cache/snr-cosmetics-worker.mjs');
await build({
	entryPoints: ['src/main/snrCosmeticsWorker.ts'],
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: workerOutput,
});
const cache = await mkdtemp(join(tmpdir(), 'snr-bundle-cosmetics-'));
try {
	const game = process.argv.includes('--game')
		? process.argv[process.argv.indexOf('--game') + 1]
		: 'C:/Program Files (x86)/Steam/steamapps/common/Among Us Super New Roles';
	const executable = join(game, 'Among Us.exe');
	const id = 'Modded_アルジャンハット_ArujanHACCHAAN';
	const file = await findSnrBundledCosmeticFile(executable, id, 'hat-front', cache);
	assert.ok(file, 'SNR bundle hat is missing');
	const image = PNG.sync.read(await readFile(file));
	assert.equal(image.width, 168);
	assert.equal(image.height, 194);
	const back = await findSnrBundledCosmeticFile(executable, id, 'hat-back', cache);
	assert.ok(back, 'SNR bundle back hat is missing');
	assert.ok(PNG.sync.read(await readFile(back)).width > 0);
	const visor = await findSnrBundledCosmeticFile(executable, 'Modded_アルジャンバイザー_ArujanHaguki', 'visor', cache);
	assert.ok(visor, 'SNR bundle visor is missing');
	assert.ok(PNG.sync.read(await readFile(visor)).height > 0);
	assert.equal(await findSnrBundledCosmeticFile(executable, id, 'hat-front', cache), file);
	assert.equal(await findSnrBundledCosmeticFile(executable, 'Modded_missing_Name', 'hat-front', cache), undefined);
	const worker = new Worker(pathToFileURL(workerOutput));
	try {
		const workerCache = join(cache, 'worker');
		const response = await new Promise((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
			worker.postMessage({
				id: 1,
				gameExecutable: executable,
				productId: id,
				part: 'hat-front',
				cacheRoot: workerCache,
			});
		});
		assert.equal(response.id, 1);
		assert.ok(response.file);
		assert.equal(PNG.sync.read(await readFile(response.file)).width, 168);
	} finally {
		await worker.terminate();
	}
	process.stdout.write('PASS installed SNR Unity bundle product ID, sprite decode, cache and missing ID\n');
} finally {
	await rm(cache, { recursive: true, force: true });
}
