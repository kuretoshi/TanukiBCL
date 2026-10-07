import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function verifyInstalledCosmetics(game, findSnrCosmeticFile) {
	const root = join(game, 'SuperNewRolesNext', 'CustomCosmetics');
	let checked = 0;
	for (const folder of await readdir(root, { withFileTypes: true })) {
		if (!folder.isDirectory() || folder.name.endsWith('.bundle')) continue;
		for (const file of await readdir(join(root, folder.name))) {
			const match = /^(.*)_(front|back|idle)\.png$/.exec(file);
			if (!match) continue;
			const part = match[2] === 'back' ? 'hat-back' : match[2] === 'idle' ? 'visor' : 'hat-front';
			assert.equal(
				findSnrCosmeticFile(join(game, 'Among Us.exe'), `Modded_${folder.name}_${match[1]}`, part),
				join(root, folder.name, file)
			);
			checked++;
		}
	}
	assert.ok(checked > 0);
	console.log(`PASS actual SNR CustomCosmetics: ${checked} local images resolved`);
}

const temp = await mkdtemp(join(tmpdir(), 'snr-local-cosmetics-'));
try {
	async function bundle(source, name) {
		const result = await build({
			entryPoints: [source],
			bundle: true,
			platform: 'node',
			format: 'esm',
			loader: { '.png': 'dataurl' },
			write: false,
		});
		const file = join(temp, name);
		await writeFile(file, result.outputFiles[0].contents);
		return import(pathToFileURL(file));
	}
	globalThis.Image = class {
		set src(value) {
			this.url = value;
		}
	};
	const { getCosmetic, cosmeticType } = await bundle('src/renderer/lib/cosmetics.ts', 'renderer.mjs');
	for (const [part, type] of [
		['hat-front', cosmeticType.hat],
		['hat-back', cosmeticType.hat_back],
		['visor', cosmeticType.visor],
		['skin', cosmeticType.skin],
	]) {
		const url = new URL(getCosmetic(0, true, type, 'Modded_めめ村クローゼット_gutierrez', 'SUPER_NEW_ROLES'));
		assert.equal(url.protocol, 'snr-cosmetic:');
		assert.equal(url.host, part);
		assert.equal(decodeURIComponent(url.pathname.slice(1)), 'Modded_めめ村クローゼット_gutierrez');
	}
	const adaptive = new URL(
		getCosmetic(4, true, cosmeticType.hat, 'Modded_Multiverse Costume SEL_test', 'SUPER_NEW_ROLES')
	);
	assert.equal(adaptive.searchParams.get('adaptive'), '1');
	assert.equal(adaptive.searchParams.get('color'), '4');
	const { findSnrCosmeticFile } = await bundle('src/main/snrCosmetics.ts', 'main.mjs');
	const folder = join(temp, 'SuperNewRolesNext', 'CustomCosmetics', 'めめ村クローゼット');
	await mkdir(folder, { recursive: true });
	for (const suffix of ['front', 'back', 'idle']) await writeFile(join(folder, `test_${suffix}.png`), 'fixture');
	for (const [part, suffix] of [
		['hat-front', 'front'],
		['hat-back', 'back'],
		['visor', 'idle'],
		['skin', 'front'],
	]) {
		assert.equal(
			findSnrCosmeticFile(join(temp, 'Among Us.exe'), 'Modded_めめ村クローゼット_test', part),
			join(folder, `test_${suffix}.png`)
		);
	}
	assert.equal(findSnrCosmeticFile(join(temp, 'Among Us.exe'), 'Modded_missing_test', 'hat-front'), undefined);
	assert.equal(findSnrCosmeticFile(join(temp, 'Among Us.exe'), 'hat_None', 'hat-front'), undefined);
	const game = process.argv[process.argv.indexOf('--game') + 1];
	if (process.argv.includes('--game')) {
		await verifyInstalledCosmetics(game, findSnrCosmeticFile);
	}
	console.log(
		'PASS SNR: local-only image URLs before CDN initialization, parts, adaptive colors, Japanese packages, missing images'
	);
} finally {
	await rm(temp, { recursive: true, force: true });
}
