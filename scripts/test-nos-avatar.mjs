import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/nos-avatar-test');
await mkdir(directory, { recursive: true });
const bundle = await build({ entryPoints: ['src/renderer/lib/nosAvatar.ts'], bundle: true, format: 'iife', globalName: 'avatars', loader: { '.png': 'file' }, outdir: directory, write: false });
for (const file of bundle.outputFiles) await writeFile(file.path, file.contents);
const html = resolve(directory, 'index.html'); await writeFile(html, '<!doctype html><title>NoS avatar test</title>');
const script = `${bundle.outputFiles.find(file => file.path.endsWith('.js')).text}
(async () => {
  const pixels = new Uint8ClampedArray([255,0,0,128, 0,255,0,255, 0,0,0,255, 0,0,255,0]);
  avatars.tintNosAvatar(pixels, '#17df49');
  const samples = [];
  for (const alive of [true, false]) for (const color of ['#17df49', '#ee33bb']) {
    const url = await avatars.getNosAvatar(alive, color);
    if (url !== await avatars.getNosAvatar(alive, color)) throw new Error('Cache mismatch');
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const expected = [1,3,5].map(i => parseInt(color.slice(i, i+2), 16));
    let matching = 0; const palette = {};
    for (let i = 0; i < data.length; i += 4) {
      // Ghost pixels are translucent; premultiplication can round channels by one byte.
      if (data[i+3] >= 120 && expected.every((v, c) => Math.abs(data[i+c] - v) <= 2)) matching++;
      if (data[i+3] > 0) { const key = [...data.slice(i, i+4)].join(','); palette[key] = (palette[key] || 0) + 1; }
    }
    samples.push({ alive, color, matching, dominant: Object.entries(palette).sort((a,b) => b[1]-a[1]).slice(0, 6), url });
  }
  return { pixels: [...pixels], samples };
})()`;
const runner = resolve(directory, 'runner.cjs');
await writeFile(runner, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async () => {
 console.log('READY');
 const window = new BrowserWindow({ show: false });
 try { await window.loadFile(${JSON.stringify(html)}); console.log('LOADED'); console.log('RESULT:' + JSON.stringify(await window.webContents.executeJavaScript(${JSON.stringify(script)}))); app.exit(0); }
 catch (error) { console.error(error); app.exit(1); }
});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [runner], { env, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
const output = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7));
assert.deepEqual(output.pixels.slice(0, 12), [23,223,73,128, 154,202,213,255, 0,0,0,255]);
assert.equal(output.pixels[15], 0);
for (const sample of output.samples) {
  await writeFile(resolve(directory, `${sample.alive ? 'alive' : 'ghost'}-${sample.color.slice(1)}.png`), Buffer.from(sample.url.split(',')[1], 'base64'));
  assert.ok(sample.matching > 100, JSON.stringify({ ...sample, url: undefined }));
}
console.log('PASS Chromium NoS avatar rendering: exact published RGB, color changes, alive/ghost, visor, alpha and cache');
