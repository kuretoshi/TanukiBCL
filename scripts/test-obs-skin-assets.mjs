import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await build({ entryPoints: ['src/renderer/voice/ObsSkinAssets.ts'], bundle: true,
	platform: 'node', format: 'esm', write: false });
const file = resolve('.tools/test-cache/obs-skin-assets.mjs');
await mkdir(resolve('.tools/test-cache'), { recursive: true });
await writeFile(file, output.outputFiles[0].contents);
const { ObsSkinAssets, obsAppearance } = await import(pathToFileURL(file).href);

const player = {
	hatId: 'old-hat', skinId: 'old-skin', visorId: 'old-visor', colorId: 2,
	appearanceHatId: 'Modded_Hat', appearanceSkinId: 'Modded_Skin', appearanceVisorId: 'Modded_Visor',
	appearanceColorId: 4, currentOutfit: 0,
};
assert.equal(obsAppearance(player, 'SUPER_NEW_ROLES').skinSource, 'snr-cosmetic://skin/Modded_Skin');
const nos = { ...player, nosPlayer: { skin: { name: 'NoS skin' } },
	nosCosmetics: { skin: 'nos-cosmetic://image/skin.png', bodyMask: 'nos-cosmetic://image/mask.png' } };
assert.equal(obsAppearance(nos, 'NoS').skinId, 'NoS skin');
assert.equal(obsAppearance(nos, 'NoS').bodyMaskSource, 'nos-cosmetic://image/mask.png');

const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; return { ok: true, arrayBuffer: async () => png }; };
try {
	const assets = new ObsSkinAssets();
	const source = 'snr-cosmetic://skin/Modded_Skin';
	assets.setActive('LOBBY:SUPER_NEW_ROLES', [source]);
	const image = await assets.get(source);
	assert.equal(image, `data:image/png;base64,${png.toString('base64')}`);
	assert.equal(await assets.get(source), image);
	assert.equal(calls, 1, 'Repeated OBS requests use cached PNG');
	assert.equal(await assets.get('snr-cosmetic://skin/Other'), undefined, 'Inactive images cannot be fetched');
	assets.setActive('NEXT:SUPER_NEW_ROLES', []);
	assert.equal(await assets.get(source), undefined, 'Old lobby images cannot be fetched');
} finally {
	globalThis.fetch = originalFetch;
}
console.log('ok OBS SNR/NoS skin selection and image relay cache');
