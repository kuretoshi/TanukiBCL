import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const Jimp = createJimp({ formats: [png] });
async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { MobileCosmetics } = await bundle('src/renderer/voice/MobileCosmetics.ts');
const { NosCosmeticAssets } = await bundle('../BetterCrewlink-mobile/src/app/lib/nosCosmeticAssets.ts');
const colors = [0xff0000ff, 0x00ff00ff, 0x0000ffff];
const images = await Promise.all(
	colors.map((color) => new Jimp({ width: 300, height: 375, color }).getBuffer('image/png'))
);
const fetchOriginal = globalThis.fetch;
const nowOriginal = Date.now;
let now = nowOriginal();
Date.now = () => now;
const calls = [];
let release;
globalThis.fetch = async (url) => {
	calls.push(url);
	if (url.endsWith('late'))
		return new Promise((resolve) => {
			release = () => resolve(new Response(images[0]));
		});
	if (url.endsWith('large')) return new Response(Buffer.alloc(193 * 1024));
	if (url.endsWith('fail')) return new Response(null, { status: 404 });
	return new Response(images[url.includes('green') ? 1 : url.includes('blue') ? 2 : 0]);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const state = (parts, lobbyCode = 'ABCDEF') => ({
	lobbyCode,
	mod: 'NoS',
	players: [{ id: 1, nosCosmetics: parts }],
	nosLoadedContents: { path: 'private-game-folder' },
});
try {
	const sender = new MobileCosmetics();
	const receiver = new NosCosmeticAssets();
	const source = state({
		hat: 'nos-cosmetic://image/red',
		skin: 'nos-cosmetic://image/green',
		visor: 'nos-cosmetic://image/blue',
		hatBack: 'nos-cosmetic://image/red',
		bodyMask: 'nos-cosmetic://image/blue',
	});
	let frame = sender.frame(source);
	assert.equal(JSON.stringify(frame).includes('nos-cosmetic://'), false);
	assert.equal(frame.gameState.nosLoadedContents, undefined);
	await settle();
	const received = [];
	for (let i = 0; i < 4; i++) {
		now += 101;
		frame = sender.frame(source);
		if (frame.nosCosmeticAssets) received.push(...Object.values(frame.nosCosmeticAssets));
		receiver.receive('host1', 'ABCDEF', frame.nosCosmeticAssets);
	}
	assert.equal(calls.length, 3, 'shared layers fetch once');
	assert.equal(received.length, 3, 'shared PNGs transmit once');
	for (const [part, ref] of Object.entries(frame.gameState.players[0].nosCosmetics)) {
		assert.match(ref, /^nos-web:\/\/[a-f0-9]{64}$/);
		assert.ok(receiver.get(ref), `${part} resolves on web`);
	}
	assert.equal(source.players[0].nosCosmetics.hat, 'nos-cosmetic://image/red', 'desktop state remains untouched');
	assert.equal(sender.frame(source).nosCosmeticAssets, undefined, 'frequent frames omit image bytes');
	const refs = Object.values(frame.gameState.players[0].nosCosmetics);
	const fresh = new NosCosmeticAssets();
	fresh.receive('host1', 'ABCDEF', undefined);
	assert.equal(fresh.missingRequest(refs).length, 3, 'late join asks only for missing hashes');
	assert.equal(fresh.missingRequest(refs).length, 0, 'requests throttled');
	sender.resend([refs[0].slice(10)]);
	now += 101;
	assert.equal(
		Object.keys(sender.frame(source).nosCosmeticAssets).length,
		1,
		'selective repair resends requested image'
	);
	sender.resend();
	for (let i = 0; i < 3; i++) {
		now += 101;
		frame = sender.frame(source);
		fresh.receive('host1', 'ABCDEF', frame.nosCosmeticAssets);
	}
	assert.ok(fresh.get(refs[0]), 'new receiver can reconstruct images');
	assert.equal(
		sender.frame(state({})).gameState.players[0].nosCosmetics,
		undefined,
		'unequip removes references immediately'
	);
	assert.equal(
		sender.frame({ ...source, mod: 'NONE' }).gameState.players[0].nosCosmetics,
		undefined,
		'other mods do not receive NoS assets'
	);
	assert.equal(sender.frame(state(undefined)).nosCosmeticAssets, undefined, 'Lite state sends no images');
	receiver.receive('host2', 'ABCDEF', undefined);
	assert.equal(receiver.get(refs[0]), undefined, 'host failover clears cache');
	receiver.receive('host2', 'OTHER', { [refs[0].slice(10)]: 'https://example.com/evil.png' });
	assert.equal(receiver.get(refs[0]), undefined, 'arbitrary URLs rejected');
	sender.frame(state({ hat: 'nos-cosmetic://image/late' }));
	sender.frame(state({}, 'OTHER'));
	release();
	await settle();
	assert.equal(
		sender.frame(state({}, 'OTHER')).nosCosmeticAssets,
		undefined,
		'stale asynchronous completion cannot cross lobby'
	);
	const before = calls.length;
	sender.frame(state({ hat: 'nos-cosmetic://image/fail', skin: 'nos-cosmetic://image/large' }, 'OTHER'));
	await settle();
	assert.equal(
		sender.frame(state({ hat: 'nos-cosmetic://image/fail', skin: 'nos-cosmetic://image/large' }, 'OTHER'))
			.nosCosmeticAssets,
		undefined
	);
	assert.equal(calls.length, before + 2, 'failure backs off and oversized PNG is rejected');
	now += 5001;
	sender.frame(state({ hat: 'nos-cosmetic://image/fail' }, 'OTHER'));
	await settle();
	assert.equal(calls.length, before + 3, 'failed reads retry automatically');
	console.log(
		'PASS desktop → web: PNG layers, deduplication, cache, late join, selective resend, host/lobby changes, unequip, Lite, bounds and retry'
	);
	const gameIndex = process.argv.indexOf('--game');
	if (gameIndex >= 0) {
		const game = process.argv[gameIndex + 1];
		const built = await build({
			entryPoints: ['src/main/nosContents.ts'],
			bundle: true,
			platform: 'node',
			format: 'esm',
			write: false,
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		});
		const mainModule = resolve('.cache/mobile-nos-main-test.mjs');
		await writeFile(mainModule, built.outputFiles[0].contents);
		const { NosContentsTracker } = await import(pathToFileURL(mainModule));
		const tracker = new NosContentsTracker();
		assert.equal(tracker.update(game).status, '読み取り成功');
		const manifest = JSON.parse(
			(await readFile(join(game, 'BepInEx/MoreCosmic/LoadedContents.json'), 'utf8')).replace(/^\uFEFF/, '')
		);
		const costumes = tracker.cosmetics({
			hat: { name: 'noshat_R1_Drawing' },
			visor: { name: 'nosvisor_Dolly_Now Loading...' },
			skin: { name: Object.keys(manifest.Skins ?? {})[0] ?? '' },
			colorR: 0.2,
			colorG: 0.5,
			colorB: 0.8,
		});
		assert.ok(costumes.hat && costumes.visor);
		globalThis.fetch = async (source) => {
			const url = new URL(source);
			const bytes = await tracker.image(url.pathname.slice(1), url.searchParams.get('color'));
			return bytes ? new Response(bytes) : new Response(null, { status: 404 });
		};
		const liveSender = new MobileCosmetics(),
			liveReceiver = new NosCosmeticAssets();
		const liveState = state(costumes);
		for (let i = 0; i < 30; i++) {
			now += 101;
			const frame = liveSender.frame(liveState);
			liveReceiver.receive('live-host', 'ABCDEF', frame.nosCosmeticAssets);
			await settle();
		}
		const liveFrame = liveSender.frame(liveState);
		for (const [part, ref] of Object.entries(liveFrame.gameState.players[0].nosCosmetics)) {
			const dataUrl = liveReceiver.get(ref);
			assert.ok(dataUrl, `Actual ${part} arrives at web`);
			const decoded = await Jimp.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
			assert.equal(decoded.bitmap.width, 300);
			assert.equal(decoded.bitmap.height, 375);
		}
		console.log(
			`PASS actual NoS local PNG → desktop asset frame → web cache: ${Object.keys(costumes).join(', ')} (300x375)`
		);
	}
} finally {
	globalThis.fetch = fetchOriginal;
	Date.now = nowOriginal;
}
