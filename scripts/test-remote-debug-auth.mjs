import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-remote-auth-'));
try {
	const output = join(directory, 'remote-auth.mjs');
	const built = await build({ entryPoints: ['src/main/remoteDebugAuth.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, built.outputFiles[0].contents);
	const { verifyRemoteDebugPassword } = await import(pathToFileURL(output));
	const endpoint = 'https://auth.example.test/v1/debug-auth/verify';
	let calls = 0;
	const request = async (url, options) => {
		calls++;
		assert.equal(url, endpoint);
		assert.equal(options.method, 'POST');
		assert.equal(options.redirect, 'error');
		assert.deepEqual(JSON.parse(options.body), { password: 'test' });
		assert.ok(options.signal);
		return new Response(JSON.stringify({ authorized: true }), { status: 200 });
	};
	assert.equal(await verifyRemoteDebugPassword('test', endpoint, request), 'authorized');
	for (const invalid of ['', null, {}, 'x'.repeat(1025)])
		assert.equal(await verifyRemoteDebugPassword(invalid, endpoint, request), 'denied');
	for (const invalid of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?q=test', 'bad'])
		assert.equal(await verifyRemoteDebugPassword('test', invalid, request), 'unavailable');
	assert.equal(calls, 1);
	for (const status of [401, 429, 500, 302]) {
		assert.equal(await verifyRemoteDebugPassword('test', endpoint, async () => new Response('{}', { status })), status === 401 ? 'denied' : 'unavailable');
	}
	for (const body of ['broken', 'x'.repeat(1025), '{"authorized":"true"}', '{"authorized":false}']) {
		assert.notEqual(await verifyRemoteDebugPassword('test', endpoint, async () => new Response(body)), 'authorized');
	}
	assert.equal(await verifyRemoteDebugPassword('test', endpoint, async () => { throw new Error('offline'); }), 'unavailable');
	console.log('PASS remote debug authentication: HTTPS, invalid input, denial, outages, no redirects');
} finally {
	await rm(directory, { recursive: true, force: true });
}
