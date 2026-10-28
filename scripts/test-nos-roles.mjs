import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cache = resolve('.cache/nos-role-tests');
await mkdir(cache, { recursive: true });
async function bundle(file) {
	const output = resolve(cache, file.split('/').at(-1).replace('.ts', '.mjs'));
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { NosRoleTracker } = await bundle('src/main/nosRoleTracker.ts');
const { isNosPlayerRoles, formatNosRole } = await bundle('src/common/NosRole.ts');
const role = { roleId: 71, roleName: 'aliceU', displayName: 'アリス', runtimeClass: 'Hori.Scripts.Role.Neutral.AliceU+Instance' };
const rows = [{ playerId: 0, role }];
assert.equal(isNosPlayerRoles(rows), true);
for (const isRainbowStar of [true, false, null, undefined])
	assert.equal(isNosPlayerRoles([{ playerId: 0, role: { ...role, isRainbowStar } }]), true);
assert.equal(isNosPlayerRoles([{ playerId: 0, role: { ...role, isRainbowStar: 1 } }]), false);
assert.equal(isNosPlayerRoles([...rows, ...rows]), false);
assert.equal(isNosPlayerRoles([{ playerId: 256, role }]), false);
assert.equal(isNosPlayerRoles([{ playerId: 0, role: { ...role, displayName: 123 } }]), false);
assert.equal(formatNosRole(role), 'NoS: アリス');

const originalNow = Date.now;
let now = 10000;
Date.now = () => now;
const requests = [];
const tracker = new NosRoleTracker((pid) => new Promise((resolve, reject) => requests.push({ pid, resolve, reject })));
const settle = () => new Promise((resolve) => setImmediate(resolve));
try {
	assert.equal(tracker.update(1, 'round1').size, 0);
	tracker.update(1, 'round1');
	assert.equal(requests.length, 1, 'pending request does not overlap');
	requests[0].resolve(rows);
	await settle();
	assert.equal(tracker.update(1, 'round1').get(0).displayName, 'アリス');
	now += 2000;
	tracker.update(1, 'round1');
	assert.equal(requests.length, 2);
	assert.equal(tracker.update(2, 'round2').size, 0, 'process/round change clears roles immediately');
	assert.equal(requests.length, 2, 'session change waits for old helper');
	requests[1].resolve([{ playerId: 0, role: { ...role, displayName: '古い役職' } }]);
	await settle();
	assert.equal(tracker.update(2, 'round2').size, 0, 'late result cannot populate new session');
	assert.equal(requests.length, 3);
	requests[2].resolve(rows);
	await settle();
	now += 5001;
	assert.equal(tracker.update(2, 'round2').size, 0, 'stale roles expire while helper is pending');
	requests[3].reject(new Error('read failed'));
	await settle();
	assert.match(tracker.message, /read failed/);
	now += 2000;
	tracker.update(2, 'round2');
	requests[4].resolve([{ playerId: 0, role: {} }]);
	await settle();
	assert.equal(tracker.update(2, 'round2').size, 0, 'invalid response is rejected');
	assert.match(tracker.message, /未対応/);
} finally {
	Date.now = originalNow;
	tracker.reset();
}
console.log('PASS NoS roles: validation, polling, process/round changes, late responses, expiry and failures');
