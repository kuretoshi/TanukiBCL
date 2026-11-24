import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';
import process from 'node:process';
import { PNG } from 'pngjs';
const source = await build({
	entryPoints: ['src/renderer/voice/MobileCosmetics.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	loader: { '.png': 'dataurl' },
});
const { MobileCosmetics } = await import(
	`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].contents).toString('base64')}`
);
const png = new PNG({ width: 300, height: 375 });
png.data.fill(255);
const bytes = PNG.sync.write(png),
	originalFetch = globalThis.fetch,
	originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
const calls = [];
globalThis.Image = class {
	set src(value) {
		this.value = value;
	}
};
globalThis.fetch = async (url) => {
	calls.push(url);
	return new globalThis.Response(bytes, { headers: { 'X-Tanuki-Snr-Scale': url.includes('visor') ? '1' : '0' } });
};
const settle = () => new Promise((done) => setTimeout(done, 20));
try {
	const sender = new MobileCosmetics();
	const player = {
		id: 1,
		colorId: 28,
		currentOutfit: 0,
		hatId: 'Modded_Test_Hat',
		skinId: 'Modded_Test_Skin',
		visorId: 'Modded_Test_Visor',
		appearanceHatId: '',
		appearanceSkinId: '',
		appearanceVisorId: '',
		snrHat2Id: 'Modded_Test_SecondHat',
		snrVisor2Id: 'Modded_Test_SecondVisor',
	};
	const state = { mod: 'SUPER_NEW_ROLES', lobbyCode: 'ABCDEF', players: [player] };
	let frame;
	for (let i = 0; i < 6; i++) {
		now += 101;
		frame = sender.frame(state);
		await settle();
	}
	frame = sender.frame(state);
	assert.equal(calls.length, 7, 'Seven local parts use the existing bounded PNG queue');
	assert.ok(calls.every((url) => new URL(url).searchParams.get('color') === '28'));
	const remote = frame.gameState.players[0];
	assert.equal(Object.keys(remote.snrCosmetics).length, 7);
	assert.ok(Object.values(remote.snrCosmetics).every((ref) => /^nos-web:\/\/[a-f0-9]{64}$/.test(ref)));
	assert.deepEqual(remote.snrCosmeticScale, { visor: true, visor2: true });
	assert.equal(player.snrCosmetics, undefined, 'Original desktop state is preserved');
	assert.equal(frame.nosCosmeticAssets, undefined, 'Identical completed PNG bytes transmit only once');
	player.currentOutfit = 1;
	player.appearanceColorId = 6;
	player.appearanceHatId = 'Modded_Test_Disguise';
	player.appearanceSkinId = 'skin_None';
	player.appearanceVisorId = 'visor_EmptyVisor';
	sender.frame(state);
	await settle();
	assert.ok(calls.some((url) => url.includes('Disguise') && new URL(url).searchParams.get('color') === '6'));
	player.snrHat2Id = undefined;
	player.snrVisor2Id = undefined;
	frame = sender.frame(state);
	assert.equal(frame.gameState.players[0].snrCosmetics.hat2, undefined);
	assert.equal(frame.gameState.players[0].snrCosmetics.visor2, undefined);
	assert.equal(sender.frame({ ...state, mod: 'NONE' }).gameState.players[0].snrCosmetics, undefined);
	process.env.BETTERCREWLINK_LITE = '1';
	const beforeLite = calls.length;
	assert.equal(sender.frame(state).gameState.players[0].snrCosmetics, undefined);
	assert.equal(calls.length, beforeLite, 'Lite must not fetch or relay SNR costume assets');
	console.log(
		'PASS mobile SNR host: seven slots, completed PNG hashes, color/disguise, IsSNR flags, unequip and unchanged wire limits'
	);
} finally {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
	delete globalThis.Image;
	delete process.env.BETTERCREWLINK_LITE;
}
