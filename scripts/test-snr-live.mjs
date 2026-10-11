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
const x64Base = 0x100000000, x64Memory = Buffer.alloc(0x5000);
const x64Address = (offset) => x64Base + offset;
const x64WritePointer = (offset, value) => x64Memory.writeBigUInt64LE(BigInt(value), offset);
const x64WriteInt = (offset, value) => x64Memory.writeInt32LE(value, offset);
const x64Read = (address, size) => Buffer.from(x64Memory.subarray(address - x64Base, address - x64Base + size));
const x64 = { ...layout, pointerSize: 8, arraySlot: x64Address(0x100), arrayType: x64Address(0x300),
  playerType: x64Address(0x400), arrayLengthOffset: 8, arrayDataOffset: 16,
  fields: { playerId: field(150), role: field(144), modifier: field(146, { 16: 'JumboModifier' }), ghostRole: field(148) },
  jumbo: { abilityType: x64Address(0x500), dataType: x64Address(0x600), listType: x64Address(0x700),
    itemsType: x64Address(0x800), abilitiesOffset: 72, itemsOffset: 8, countOffset: 16,
    currentOffset: 36, dataOffset: 40, maxOffset: 8 } };
const x64Array = x64Address(0x200), x64Player = x64Address(0x1100), x64List = x64Address(0x1200);
const x64Items = x64Address(0x1300), x64Ability = x64Address(0x1400), x64Data = x64Address(0x1500);
x64WritePointer(0x100, x64Array);
x64WritePointer(0x200, x64.arrayType);
x64WriteInt(0x208, 256);
x64WritePointer(0x210 + 3 * 8, x64Player);
x64WritePointer(0x1100, x64.playerType);
x64Memory[0x1100 + 150] = 3;
x64Memory.writeInt16LE(1, 0x1100 + 144);
x64Memory.writeInt16LE(16, 0x1100 + 146);
x64WritePointer(0x1100 + 72, x64List);
x64WritePointer(0x1200, x64.jumbo.listType);
x64WritePointer(0x1200 + 8, x64Items);
x64WriteInt(0x1200 + 16, 1);
x64WriteInt(0x1200 + 20, 99); // The adjacent list version must not be read as part of count.
x64WritePointer(0x1300, x64.jumbo.itemsType);
x64WriteInt(0x1300 + 8, 4);
x64WritePointer(0x1300 + 16, x64Ability);
x64WritePointer(0x1400, x64.jumbo.abilityType);
x64WritePointer(0x1400 + 40, x64Data);
x64Memory.writeFloatLE(2.4, 0x1400 + 36);
x64WritePointer(0x1500, x64.jumbo.dataType);
x64Memory.writeFloatLE(7.2, 0x1500 + 8);
assert.ok(isSnrLiveLayout(x64, 123));
assert.equal(readSnrLiveRoles(x64, x64Read).get(3).jumbo.currentSize.toFixed(1), '2.4');
assert.equal(readSnrLiveRoles(x64, x64Read).get(3).jumbo.maxSize.toFixed(1), '7.2');
console.log('PASS x64 live roles: jumbo current/max size, pointer stride, separate list count/version');
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


const originalClock = Date.now;
let testTime = originalClock();
Date.now = () => testTime;
try {
  setRole(137, 0);
  let discoveries = 0;
  let team = { value: 2, name: 'Neutral' };
  const result = () => ({ status: 'ok', pid: 123, liveLayout: layout, players: [{ playerId: 3, role: { value: 137 }, isNeutral: true, canKill: true, assignedTeam: team, winnerTeam: team, teamTag: { value: 0, name: null } }] });
  const detailed = new SnrLiveTracker(async () => { discoveries++; return result(); });
  detailed.accept(123, result());
  assert.equal(detailed.update(123, 'details', read).get(3).assignedTeam.name, 'Neutral');
  assert.equal(detailed.update(123, 'details', read).get(3).teamTag.value, 0);
  team = { value: 1, name: 'Impostor' };
  testTime += 5001;
  detailed.update(123, 'details', read);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(discoveries, 1, 'Reuse the existing five-second refresh, do not add a snapshot loop');
  assert.equal(detailed.update(123, 'details', read).get(3).winnerTeam.name, 'Impostor');
  setRole(222, 0);
  assert.equal(detailed.update(123, 'details', read).get(3).assignedTeam, undefined, 'Never apply team metadata from a previous role');
  detailed.reset();
  assert.equal(detailed.update(124, 'new-process', read).size, 0);
  await new Promise(resolve => setImmediate(resolve));
  let retries = 0;
  const recovering = new SnrLiveTracker(async () => { retries++; return { status: 'error' }; });
  recovering.update(123, 'retry', read);
  await new Promise(resolve => setImmediate(resolve));
  recovering.update(123, 'retry', read);
  assert.equal(retries, 1);
  testTime += 10001;
  recovering.update(123, 'retry', read);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retries, 2, 'Retry failed initial discovery automatically after ten seconds');
  console.log('PASS SNR details: automatic team refresh, zero values, role change clearing and throttled retry');
} finally {
  Date.now = originalClock;
  setRole(11, 16);
}

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
