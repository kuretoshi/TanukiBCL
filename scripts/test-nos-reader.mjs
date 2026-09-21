import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import memoryjs from 'memoryjs';

const cache = resolve('.cache/nos-reader-tests');
await mkdir(cache, { recursive: true });
async function bundle(file) {
  const output = resolve(cache, file.split('/').at(-1).replace('.ts', '.mjs'));
  const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
  await writeFile(output, result.outputFiles[0].contents);
  return import(pathToFileURL(output));
}
const { isNosLayout, readNosSnapshot } = await bundle('src/main/nosSnapshotMemory.ts');
const { NosSnapshotTracker } = await bundle('src/main/nosSnapshotTracker.ts');
const { isNosPaletteLayout, readNosPalette } = await bundle('src/main/nosPalette.ts');
const { nosColorHex, findNosColorIndex } = await bundle('src/common/NosSnapshot.ts');
assert.equal(nosColorHex({ colorR: .25, colorG: .5, colorB: .75 }), '#4080bf');
assert.equal(findNosColorIndex({ colorR: .25, colorG: .5, colorB: .75 }, [['#000000'], ['#3f7fbf']]), 1);
assert.equal(findNosColorIndex(undefined, [['#000000']]), -1);
const fixture = resolve(cache, 'fixture');
execFileSync('dotnet', ['publish', 'scripts/fixtures/nos-reader/Host/Host.csproj', '-c', 'Release', '-o', fixture], { windowsHide: true, stdio: 'pipe' });
const child = spawn(resolve(fixture, 'Among Us.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout });
let handle;
try {
  await Promise.race([once(lines, 'line'), once(child, 'error').then(([error]) => { throw error; }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('NoS fixture timeout')), 15000).unref(); })]);
  handle = memoryjs.openProcess(child.pid);
  const read = (address, size) => memoryjs.readBuffer(handle.handle, address, size);
  const paletteResponse = JSON.parse(execFileSync(resolve('out/nos-reader/TbclSnapshotReader.exe'), ['palette', String(child.pid)], { windowsHide: true, timeout: 45000, encoding: 'utf8' }));
  const palette = paletteResponse.metadata;
  assert.ok(isNosPaletteLayout(palette, child.pid), JSON.stringify(paletteResponse));
  assert.equal(isNosPaletteLayout(palette, child.pid + 1), false);
  assert.equal(isNosPaletteLayout({ ...palette, stride: 2 }, child.pid), false);
  assert.equal(readNosPalette(palette, read)[3], '#4080bf', 'Read lobby RGB before any role snapshot publication');
  const published = once(lines, 'line');
  const response = JSON.parse(execFileSync(resolve('out/nos-reader/TbclSnapshotReader.exe'), ['layout', String(child.pid)], { windowsHide: true, timeout: 45000, encoding: 'utf8' }));
  await published;
  const layout = response.metadata;
  assert.ok(isNosLayout(layout, child.pid), JSON.stringify(response));
  assert.equal(isNosLayout({ ...layout, pid: child.pid + 1 }, child.pid), false);
  assert.equal(isNosLayout({ ...layout, playerData: { ...layout.playerData, name: 10000 } }, child.pid), false);
  assert.equal(isNosLayout({ ...layout, schemaVersion: 0 }, child.pid), false);
  const live = () => readNosSnapshot(layout, read);
  const first = live();
  assert.deepEqual(first.localMicPosition, { x: 1, y: -1 });
  assert.equal(first.players[0].name, 'テスト');
  assert.equal(first.players[0].isNeutral, true);
  assert.equal(first.players[0].colorB, .75);
  const command = async value => { const reply = once(lines, 'line'); child.stdin.write(value + '\n'); await reply; };
  await command('color');
  assert.equal(readNosPalette(palette, read)[3], '#ff4000', 'Lobby color changes remain live');
  await command('gc');
  assert.equal(readNosPalette(palette, read)[3], '#ff4000', 'Follow the static slot after a managed GC');
  await command('team');
  assert.equal(live().players[0].isNeutral, false);
  assert.equal(live().players[0].isImpostor, true);
  let finish, calls = 0;
  const tracker = new NosSnapshotTracker(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(tracker.update(child.pid, 'round', read), undefined);
  finish(layout); await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.update(child.pid, 'round', read), undefined, 'Wait for publication after entering a round');
  await command('team');
  assert.equal(tracker.update(child.pid, 'round', read).players[0].name, 'テスト');
  assert.equal(calls, 1);
  assert.equal(tracker.update(child.pid, 'lobby', read), undefined, 'Returning to lobby must discard the previous game publication');
  await command('team');
  assert.equal(tracker.update(child.pid, 'lobby', read).players[0].colorB, .75, 'Lobby publishes RGB without starting a game');
  assert.equal(calls, 1, 'Lobby reuses the resolved layout');
  const now = Date.now;
  let time = now(), attempts = 0;
  const retrying = new NosSnapshotTracker(async () => {
    if (++attempts === 1) throw new Error('Static storage not initialized yet');
    return layout;
  });
  try {
    Date.now = () => time;
    retrying.update(child.pid, 'lobby', read);
    await new Promise(resolve => setImmediate(resolve));
    retrying.update(child.pid, 'lobby', read);
    assert.equal(attempts, 1, 'Do not create snapshots repeatedly while initialization is pending');
    time += 30000;
    retrying.update(child.pid, 'lobby', read);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2, 'Retry initialization in the same lobby');
    retrying.update(child.pid, 'lobby', read);
    await command('team');
    assert.equal(retrying.update(child.pid, 'lobby', read).players[0].colorB, .75);
  } finally { Date.now = now; }
  assert.equal(tracker.update(child.pid, 'round', () => { throw new Error('unavailable'); }), undefined);
  tracker.reset();
  tracker.update(child.pid, 'round2', read);
  tracker.reset(); finish(layout); await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.update(child.pid + 1, 'round3', read), undefined);
  await command('clear');
  assert.equal(live().players.length, 0);
  console.log('PASS NoS x86: enable once, live unmanaged snapshots, UTF-16 name, RGB, team changes, empty/reset, PID guard, stale clearing');
} finally {
  if (handle) memoryjs.closeProcess(handle.handle);
  child.kill(); lines.close();
}
