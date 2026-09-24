import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import memoryjs from 'memoryjs';

const cache = resolve('.cache/snr-live-tests');
await mkdir(cache, { recursive: true });
async function bundle(file) {
  const out = resolve(cache, file.split('/').at(-1).replace('.ts', '.mjs'));
  const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
  await writeFile(out, result.outputFiles[0].contents);
  return import(pathToFileURL(out));
}
const { isSnrLiveLayout, readSnrLiveRoles } = await bundle('src/main/snrLiveMemory.ts');
const { SnrLiveTracker } = await bundle('src/main/snrLiveTracker.ts');
const { formatSnrRole } = await bundle('src/common/SnrRole.ts');
const memory = Buffer.alloc(0x10000);
const base = 0x10000, slot = base + 0x100, array = base + 0x200, player = base + 0x1000;
const write = (address, value) => memory.writeUInt32LE(value, address - base);
const read = (address, size) => Buffer.from(memory.subarray(address - base, address - base + size));
const field = (offset, names = null) => ({ offset, size: 2, signed: true, names });
const layout = { pid: 123, pointerSize: 4, arraySlot: slot, arrayType: 0x30000, playerType: 0x40000,
  arrayLengthOffset: 4, arrayDataOffset: 8, fields: {
    playerId: { offset: 10, size: 1, signed: false, names: null },
    role: field(4, { 11: 'Jackal', 137: 'Frankenstein', 222: 'WaveCannonJackal' }),
    modifier: field(6, { 0: 'None', 8: 'Lovers', 16: 'JumboModifier' }), ghostRole: field(8, { 0: 'None' })
  } };
const setRole = (role, modifier) => { memory.writeInt16LE(role, player - base + 4); memory.writeInt16LE(modifier, player - base + 6); };
write(slot, array); write(array, layout.arrayType); write(array + 4, 256); write(array + 8 + 3 * 4, player);
write(player, layout.playerType); memory[player - base + 10] = 3; setRole(11, 16);
assert.ok(isSnrLiveLayout(layout, 123));
assert.ok(!isSnrLiveLayout({ ...layout, pid: 124 }, 123));
assert.ok(!isSnrLiveLayout({ ...layout, pointerSize: 8 }, 123));
assert.equal(formatSnrRole(readSnrLiveRoles(layout, read).get(3)), 'Jackal + JumboModifier');
setRole(137, 0);
assert.equal(formatSnrRole(readSnrLiveRoles(layout, read).get(3)), 'Frankenstein');
setRole(11, 24);
assert.equal(readSnrLiveRoles(layout, read).get(3).modifier.name, 'Lovers | JumboModifier');
setRole(999, 256);
assert.equal(formatSnrRole(readSnrLiveRoles(layout, read).get(3)), 'RoleId(999) + ModifierRoleId(256)');
memory[player - base + 10] = 2;
assert.throws(() => readSnrLiveRoles(layout, read));
memory[player - base + 10] = 3;
setRole(11, 16);
let playerReads = 0;
assert.throws(() => readSnrLiveRoles(layout, (address, size) => {
  if (address === player && ++playerReads === 2) setRole(137, 0);
  return read(address, size);
}));
setRole(11, 16);
write(array + 8 + 3 * 4, 0);
assert.equal(readSnrLiveRoles(layout, read).size, 0);
write(array + 8 + 3 * 4, player);
let calls = 0, finish;
const tracker = new SnrLiveTracker(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
assert.equal(tracker.update(123, 'round1', read).size, 0);
tracker.update(123, 'round1', read);
assert.equal(calls, 1);
tracker.reset();
finish({ status: 'ok', pid: 123, liveLayout: layout });
await new Promise(resolve => setImmediate(resolve));
assert.equal(tracker.update(124, 'round2', read).size, 0);
assert.equal(calls, 2);
finish({ status: 'error' });
await new Promise(resolve => setImmediate(resolve));
tracker.update(124, 'round2', read);
assert.equal(calls, 2, 'Do not repeatedly create snapshots on failure');
tracker.reset();
assert.ok(tracker.accept(123, { status: 'ok', pid: 123, liveLayout: layout }));
assert.equal(tracker.update(123, 'round1', read).get(3).role.name, 'Jackal');
write(player, 0);
assert.equal(tracker.update(123, 'round1', read).size, 0, 'Never retain stale roles');
write(player, layout.playerType);
assert.equal(tracker.update(123, 'round1', read).get(3).role.name, 'Jackal');
console.log('PASS live roles: changes, modifier removal/flags, unknown IDs, inconsistent reads, empty array, PID switch, discovery throttling, stale clearing');
const eligibilityTracker = new SnrLiveTracker(async () => { throw new Error('Unexpected discovery'); });
eligibilityTracker.accept(123, { status: 'ok', pid: 123, liveLayout: layout, players: [{ playerId: 3, role: { value: 137 }, isNeutral: false, canKill: false }] });
setRole(222, 0);
assert.equal(eligibilityTracker.update(123, 'round', read).get(3).canKill, true);
assert.equal(eligibilityTracker.update(123, 'round', read).get(3).isNeutral, true);
setRole(137, 0);
assert.equal(eligibilityTracker.update(123, 'round', read).get(3).isNeutral, undefined, 'Do not restore pre-role-change metadata');
eligibilityTracker.accept(123, { status: 'ok', pid: 123, liveLayout: layout, players: [{ playerId: 3, role: { value: 222 }, isNeutral: true, canKill: true }] });
assert.equal(eligibilityTracker.update(123, 'round', read).get(3).canKill, undefined, 'Snapshot flags belong to the captured role, not only player ID');
setRole(11, 16);
console.log('PASS SNR ghost eligibility: current Jackal roles override absent/stale metadata, role changes discard old flags');

let automaticMetadataResolve;
let automaticMetadataCalls = 0;
const automaticMetadataTracker = new SnrLiveTracker(() => {
  automaticMetadataCalls++;
  return Promise.resolve(automaticMetadataResolve);
});
automaticMetadataResolve = { status: 'ok', pid: 123, liveLayout: layout, players: [] };
automaticMetadataTracker.update(123, 'auto-round', read);
await new Promise((resolve) => setTimeout(resolve, 1100));
automaticMetadataResolve = {
  status: 'ok', pid: 123, liveLayout: layout,
  players: [{ playerId: 3, role: { value: 137 }, isNeutral: true, canKill: true }],
};
automaticMetadataTracker.update(123, 'auto-round', read);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(automaticMetadataCalls, 2, 'Retry role metadata automatically after game start');
assert.equal(automaticMetadataTracker.update(123, 'auto-round', read).get(3).canKill, true);
console.log('PASS SNR ghost eligibility: metadata retries automatically');

if (process.argv.includes('--real-game')) {
  const sample = JSON.parse(await readFile('.cache/live-sample.json', 'utf8'));
  assert.ok(isSnrLiveLayout(sample.liveLayout, sample.pid));
  const handle = memoryjs.openProcess(sample.pid);
  try {
    for (let i = 0; i < 5; i++) {
      const roles = readSnrLiveRoles(sample.liveLayout, (a, n) => memoryjs.readBuffer(handle.handle, a, n));
      console.log('Live sample', i + 1, [...roles].map(([id, role]) => `${id}: ${formatSnrRole(role)}`).join(', '));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } finally { memoryjs.closeProcess(handle.handle); }
} else {
  const ready = resolve(cache, 'live.ready');
  const child = spawn(resolve('.cache/snr-reader-test/Among Us.exe'), ['live', ready], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let handle;
  try {
    await Promise.race([once(lines, 'line'), once(child, 'error').then(([error]) => { throw error; }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture timeout')), 15000); timer.unref(); })]);
    const result = JSON.parse(execFileSync(resolve('out/debug-reader/SnrRoleReader.exe'), [String(child.pid)], { windowsHide: true, timeout: 45000, encoding: 'utf8' }));
    assert.ok(isSnrLiveLayout(result.liveLayout, child.pid));
    handle = memoryjs.openProcess(child.pid);
    const live = () => readSnrLiveRoles(result.liveLayout, (address, size) => memoryjs.readBuffer(handle.handle, address, size));
    const command = async value => { const reply = once(lines, 'line'); child.stdin.write(value + '\n'); await reply; };
    assert.equal(formatSnrRole(live().get(3)), 'Jackal + JumboModifier');
    assert.deepEqual(live().get(3).jumbo, { currentSize: 1, maxSize: 4 });
    await command('grow');
    assert.deepEqual(live().get(3).jumbo, { currentSize: 4, maxSize: 4 });
    await command('gc');
    assert.deepEqual(live().get(3).jumbo, { currentSize: 4, maxSize: 4 });
    await command('invalid-size');
    assert.equal(live().get(3).jumbo, undefined);
    await command('role');
    assert.equal(formatSnrRole(live().get(3)), 'Frankenstein');
    await command('gc');
    assert.equal(formatSnrRole(live().get(3)), 'Frankenstein');
    await command('replace');
    assert.equal(formatSnrRole(live().get(3)), 'Jackal + JumboModifier');
    assert.deepEqual(live().get(3).jumbo, { currentSize: 1, maxSize: 4 });
    await command('gc');
    assert.equal(formatSnrRole(live().get(3)), 'Jackal + JumboModifier');
    await command('clear');
    assert.equal(live().size, 0);
    console.log('PASS x86 managed process: one snapshot then live role/modifier changes, compacting GC, array replacement, empty reset');
  } finally {
    if (handle) memoryjs.closeProcess(handle.handle);
    child.kill();
    lines.close();
    await rm(ready, { force: true });
  }
}
