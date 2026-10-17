import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const result = await build({ entryPoints: ['src/renderer/lib/captureMicrophone.ts'], bundle: true,
	platform: 'node', format: 'esm', write: false });
const file = resolve('.tools/test-cache/capture-microphone.mjs');
await mkdir(resolve('.tools/test-cache'), { recursive: true });
await writeFile(file, result.outputFiles[0].contents);
const { captureMicrophone } = await import(pathToFileURL(file).href);

const calls = [];
const stream = { getTracks: () => [] };
const unavailable = { name: 'OverconstrainedError', constraint: 'deviceId' };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (request) => {
	calls.push(request);
	if (request.audio.deviceId?.exact === 'stale-id') throw unavailable;
	return stream;
} } } });

assert.deepEqual(await captureMicrophone({ echoCancellation: true }, 'selected-id'), { stream, usedDefault: false });
assert.equal(calls[0].audio.deviceId.exact, 'selected-id', 'Available selected device is used exactly');
calls.length = 0;
assert.deepEqual(await captureMicrophone({ echoCancellation: true }, 'stale-id'), { stream, usedDefault: true });
assert.equal(calls.length, 2, 'Stale device is retried once');
assert.equal(calls[0].audio.deviceId.exact, 'stale-id');
assert.equal(calls[1].audio.deviceId, undefined);
assert.equal(calls[1].audio.echoCancellation, true, 'Other audio preferences survive fallback');

calls.length = 0;
await captureMicrophone({}, 'default');
assert.equal(calls.length, 1, 'Default input does not trigger a second request');
assert.equal(calls[0].audio.deviceId, undefined);

globalThis.navigator.mediaDevices.getUserMedia = async () => { throw { name: 'NotAllowedError' }; };
await assert.rejects(captureMicrophone({}, 'selected-id'), (error) => error.name === 'NotAllowedError');
console.log('ok microphone capture: selected ID, stale ID fallback, default, permission failure');
