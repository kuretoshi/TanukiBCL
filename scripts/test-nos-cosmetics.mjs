import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';
const Jimp = createJimp({ formats: [png] });
const directory = await mkdtemp(join(tmpdir(), 'tbcl-nos-cosmetics-'));
try {
	const module = join(resolve('.cache'), 'nos-cosmetics-test.mjs');
	const built = await build({
		entryPoints: ['src/main/nosContents.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		write: false,
	});
	await writeFile(module, built.outputFiles[0].contents);
	const { NosContentsTracker } = await import(pathToFileURL(module));
	const root = join(directory, 'game');
	const cosmic = join(root, 'BepInEx', 'MoreCosmic');
	await mkdir(cosmic, { recursive: true });
	const tracker = new NosContentsTracker();
	assert.match(tracker.update(root).status, /読み取り失敗/);
	const source = Buffer.alloc(600 * 750 * 4);
	for (let y = 0; y < 750; y++)
		for (let x = 0; x < 600; x++) {
			const offset = (y * 600 + x) * 4;
			source[offset + (x < 300 && y < 375 ? 0 : 1)] = 255;
			source[offset + 3] = 255;
		}
	const image = await Jimp.fromBitmap({ width: 600, height: 750, data: source }).getBuffer('image/png');
	await writeFile(join(cosmic, 'sheet.png'), image);
	await writeFile(
		join(cosmic, 'mask.png'),
		await Jimp.fromBitmap({ width: 300, height: 375, data: Buffer.alloc(300 * 375 * 4, 255) }).getBuffer('image/png')
	);
	await writeFile(join(directory, 'outside.png'), image);
	const entry = {
		ProductId: 'noshat_test',
		RelatedRawLocalPath: cosmic,
		Adaptive: false,
		Images: [{ Layer: 'Main', Address: 'sheet.png', DivisionX: 2, DivisionY: 2 }],
	};
	const manifest = {
		Version: 20261005,
		Hats: {
			noshat_test: entry,
			noshat_outside: {
				...entry,
				RelatedRawLocalPath: directory,
				Images: [{ ...entry.Images[0], Address: 'outside.png' }],
			},
		},
		Visors: { nosvisor_test: { ...entry, ProductId: 'nosvisor_test' } },
		Skins: { nosskin_test: { ...entry, ProductId: 'nosskin_test' } },
	};
	await writeFile(join(cosmic, 'LoadedContents.json'), JSON.stringify(manifest));
	const now = Date.now;
	let time = now() + 2000;
	Date.now = () => time;
	try {
		assert.equal(tracker.update(root).status, '読み取り成功');
		const lobbyPlayer = {
			appearanceHatId: 'noshat_test', appearanceVisorId: 'nosvisor_test', appearanceSkinId: 'nosskin_test',
			hatId: 'hat_None', visorId: 'visor_EmptyVisor', skinId: 'skin_None', disconnected: false,
		};
		const lobby = tracker.lobbyCosmetics(lobbyPlayer, '#ff8000');
		assert.ok(lobby.hat && lobby.visor && lobby.skin, 'Lobby outfits must load without round PlayerData');
		assert.equal(new URL(lobby.hat).searchParams.get('color'), '1,0.5019607843137255,0');
		assert.equal(tracker.lobbyCosmetics({ ...lobbyPlayer, disconnected: true }, '#ff8000'), undefined);
		assert.equal(tracker.lobbyCosmetics({ ...lobbyPlayer, appearanceHatId: '', appearanceSkinId: '', appearanceVisorId: '' }), undefined,
			'Unequipping in lobby must discard previous costume images');
		const lobbyUrl = new URL(lobby.skin);
		assert.ok(await tracker.image(lobbyUrl.pathname.slice(1), lobbyUrl.searchParams.get('color')));
		const cosmetics = tracker.cosmetics({
			hat: { name: 'noshat_test' },
			visor: { name: 'nosvisor_test' },
			colorR: 1,
			colorG: 0,
			colorB: 0,
		});
		assert.ok(cosmetics.hat && cosmetics.visor);
		const url = new URL(cosmetics.hat);
		const rendered = await tracker.image(url.pathname.slice(1), url.searchParams.get('color'));
		const frame = await Jimp.read(rendered);
		assert.equal(frame.bitmap.width, 300);
		assert.equal(frame.bitmap.height, 375);
		assert.deepEqual([...frame.bitmap.data.subarray(0, 4)], [255, 0, 0, 255]);
		assert.deepEqual(
			[...frame.bitmap.data.subarray(-4)],
			[255, 0, 0, 255],
			'Use only the top left frame, not the remaining sheet'
		);
		assert.equal(tracker.cosmetics({ hat: { name: 'noshat_outside' } }), undefined);
		assert.equal(await tracker.image('unknown', '1,0,0'), undefined);
		assert.equal(await tracker.image(url.pathname.slice(1), 'invalid'), undefined);
		await writeFile(join(cosmic, 'LoadedContents.json'), '{');
		time += 2000;
		assert.match(tracker.update(root).status, /読み取り失敗/);
		assert.equal(
			await tracker.image(url.pathname.slice(1), '1,0,0'),
			undefined,
			'Discard stale registrations after manifest errors'
		);
	} finally {
		Date.now = now;
	}
	const gameIndex = process.argv.indexOf('--game');
	if (gameIndex >= 0) {
		const game = process.argv[gameIndex + 1];
		const live = new NosContentsTracker();
		const result = live.update(game);
		assert.equal(result.status, '読み取り成功');
		const examples = ['noshat_R1_Drawing', 'noshat_catudon_Citrus_Orange', 'nosvisor_Dolly_Now Loading...'];
		for (const id of examples) {
			const key = id.startsWith('noshat_') ? 'hat' : 'visor';
			const cosmetics = live.cosmetics({ [key]: { name: id }, colorR: 0.2, colorG: 0.5, colorB: 0.8 });
			assert.ok(cosmetics?.[key], `Register real local cosmetic: ${id}`);
			const url = new URL(cosmetics[key]);
			const bytes = await live.image(url.pathname.slice(1), url.searchParams.get('color'));
			assert.ok(bytes, `Decode real local cosmetic: ${id}`);
			if (cosmetics.bodyMask) {
				const maskUrl = new URL(cosmetics.bodyMask);
				const mask = await Jimp.read(await live.image(maskUrl.pathname.slice(1), maskUrl.searchParams.get('color')));
				assert.equal(
					mask.bitmap.data[(190 * 300 + 150) * 4 + 3],
					0,
					'Full-cover costume masks hide the underlying body'
				);
			}

			await writeFile(join(resolve('.cache'), id.replace(/[^a-z0-9]/gi, '_') + '.png'), bytes);
		}
		console.log('PASS actual NoS 3.5.3.5: folder hat, addon ZIP hat with extra layer, animated visor first frame');
	}
	console.log(
		'PASS NoS cosmetics: delayed manifest, product IDs, frame cropping, local path bounds, errors and stale clearing'
	);
} finally {
	assert.ok(
		resolve(directory).startsWith(resolve(tmpdir()) + '\\tbcl-nos-cosmetics-') ||
			resolve(directory).startsWith(resolve(tmpdir()) + '/tbcl-nos-cosmetics-')
	);
	await rm(directory, { recursive: true, force: true });
}
