import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'tbcl-329-'));
try {
	async function bundle(file) {
		const result = await build({
			entryPoints: [file],
			bundle: true,
			platform: 'node',
			format: 'esm',
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
			write: false,
		});
		const output = join(directory, file.split('/').at(-1).replace('.ts', '.mjs'));
		await writeFile(output, result.outputFiles[0].contents);
		return import(pathToFileURL(output));
	}
	const { compareAppVersions, requiredAppVersion, mismatchedAppVersions } = await bundle('src/common/appVersion.ts');
	assert.equal(compareAppVersions('3.2.9', '3.2.10'), -1);
	assert.equal(compareAppVersions('3.2.10', '3.2.9'), 1);
	assert.equal(compareAppVersions('3.2.9', '3.2.9'), 0);
	assert.equal(compareAppVersions('3.2.9', '4.0.0'), -1);
	assert.equal(compareAppVersions('invalid', '3.2.9'), undefined);
	assert.equal(compareAppVersions('3.2.9', '3.2.9-extra'), undefined);
	assert.equal(requiredAppVersion('3.2.9', '3.2.10', false, []), '3.2.10');
	assert.equal(requiredAppVersion('3.2.10', '3.2.9', false, []), undefined);
	assert.equal(requiredAppVersion('3.2.9', '3.2.9', false, ['3.3.0']), undefined);
	assert.equal(requiredAppVersion('3.2.9', undefined, false, ['3.3.0']), undefined);
	assert.equal(requiredAppVersion('3.2.9', '3.2.9', true, ['3.2.8', '3.2.9']), undefined);
	assert.equal(requiredAppVersion('3.2.9', '3.2.9', true, ['3.2.10', '3.3.0']), '3.3.0');
	const peers = [
		{ name: 'Older', version: '3.2.8' },
		{ name: 'Same', version: '3.2.9' },
		{ name: 'Newer', version: '3.2.10' },
		{ name: 'Invalid', version: 'invalid' },
	];
	assert.deepEqual(mismatchedAppVersions('3.2.9', peers).map((peer) => peer.name), ['Older', 'Newer']);
	assert.deepEqual(mismatchedAppVersions('3.2.10', peers).map((peer) => peer.name), ['Older', 'Same']);
	assert.deepEqual(mismatchedAppVersions('3.2.9', []).map((peer) => peer.name), []);
	assert.deepEqual(mismatchedAppVersions('3.2.9', [peers[1], peers[3]]), []);
	const { NosContentsTracker } = await bundle('src/main/nosContents.ts');
	const tracker = new NosContentsTracker();
	const now = Date.now;
	let time = now();
	Date.now = () => time;
	try {
		assert.match(tracker.update(directory).status, /読み取り失敗/);
		const cosmic = join(directory, 'BepInEx', 'MoreCosmic');
		await mkdir(cosmic, { recursive: true });
		const manifest = join(cosmic, 'LoadedContents.json');
		await writeFile(manifest, '\uFEFF' + JSON.stringify({ Hats: [{ Name: 'Test', Path: 'hat.png', X: 4, Y: 2 }] }));
		time += 2000;
		assert.equal(tracker.update(directory).data.Hats[0].Path, 'hat.png');
		await writeFile(manifest, '{');
		time += 2000;
		assert.match(tracker.update(directory).status, /読み取り失敗/);
		assert.equal(tracker.update(directory).data, undefined);
	} finally {
		Date.now = now;
	}
	console.log('PASS 3.2.9: numeric version comparison and NoS manifest loading/retry/errors');
} finally {
	await rm(directory, { recursive: true, force: true });
}
