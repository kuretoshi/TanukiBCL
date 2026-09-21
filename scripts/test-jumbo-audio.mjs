import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/jumbo-audio-test');
await mkdir(directory, { recursive: true });
const bundled = await build({ entryPoints: ['src/renderer/voiceEffect.ts'], bundle: true, format: 'iife', globalName: 'effects', write: false });
const test = `${bundled.outputFiles[0].text}
(async () => {
  const results = [];
  for (const strength of [0, 50, 100]) {
    const context = new OfflineAudioContext(1, 48000 * 2, 48000);
    const source = context.createOscillator(); source.frequency.value = 1000;
    const input = context.createGain(); input.gain.value = 0.2;
    source.connect(input);
    const effect = effects.createVoiceDisguiseEffect(context, null, strength);
    effects.updateVoiceDisguiseEffect(effect, strength, 'down', 1, true);
    input.connect(effect.input); effect.output.connect(context.destination); source.start();
    const samples = (await context.startRendering()).getChannelData(0).slice(48000);
    let peak = 0, best = 0, rms = 0;
    for (const value of samples) rms += value * value;
    for (let frequency = 300; frequency <= 1100; frequency++) {
      let re = 0, im = 0;
      for (let i = 0; i < samples.length; i++) {
        const phase = 2 * Math.PI * frequency * i / 48000;
        re += samples[i] * Math.cos(phase); im += samples[i] * Math.sin(phase);
      }
      const power = re * re + im * im;
      if (power > best) { best = power; peak = frequency; }
    }
    results.push({ strength, peak, rms: Math.sqrt(rms / samples.length) });
    effects.disconnectVoiceDisguiseEffect(effect);
  }
  return results;
})()`;
const runner = resolve(directory, 'runner.cjs');
await writeFile(runner, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL('about:blank');
    console.log('RESULT:' + JSON.stringify(await window.webContents.executeJavaScript(${JSON.stringify(test)})));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [runner], { env, windowsHide: true, timeout: 60000, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || String(result.error));
const rows = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT:')).slice(7));
for (const [index, expected] of [1000, 700, 400].entries()) {
  assert.ok(Math.abs(rows[index].peak - expected) <= 3, JSON.stringify(rows));
  assert.ok(rows[index].rms > 0.05 && rows[index].rms < 0.2, JSON.stringify(rows));
}
console.log('PASS Chromium audio rendering: normal/half/max growth', rows);
