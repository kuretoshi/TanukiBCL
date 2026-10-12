import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'tanuki-recording-'));
function context() {
 const nodes = [];
 const played = [];
 function node() {
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const value = { gain: param(), frequency: param(), delayTime: param(), connect() {}, disconnect() {}, start() { played.push(this.buffer); }, stop() { this.stopped = true; } };
  nodes.push(value); return value;
 }
 return { sampleRate: 8, currentTime: 0, played, nodes,
  createScriptProcessor: node, createGain: node, createDelay: node, createBiquadFilter: node, createBufferSource: node,
  createBuffer(channels, length, rate) { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data }; },
 };
}
try {
 for (const [index, entry] of ['src/renderer/voice/megaphoneRecording.ts', ...(process.env.TANUKI_MOBILE_RECORDING_SOURCE ? [process.env.TANUKI_MOBILE_RECORDING_SOURCE] : [])].entries()) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
  const file = join(dir, `${index}.mjs`); await writeFile(file, result.outputFiles[0].contents);
  const { createMegaphoneRecording } = await import(pathToFileURL(file));
  const ctx = context(); const source = ctx.createGain(); const destination = ctx.createGain();
  let enabled = true;
  const recording = createMegaphoneRecording(ctx, source, destination, () => enabled);
  const processor = ctx.nodes.find(n => n.onaudioprocess);
  const feed = data => processor.onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from(data) } });
  const charge = { playerId: 1, shotId: 1, phase: 'charging', voiceEffect: true };
  try {
   feed([9]); // audio before the charge is excluded
   recording.update(charge, true); feed([0.25, 0.5]);
   enabled = false; feed([1]); enabled = true;
   recording.update({ ...charge, phase: 'firing' }, true);
   assert.deepEqual(Array.from(ctx.played[0].getChannelData(0)), [0.25, 0.5, 0]);
   recording.update({ ...charge, phase: 'firing' }, true);
   assert.equal(ctx.played.length, 1, 'duplicate fire must not replay');
   recording.update(undefined, true);
   assert.equal(ctx.nodes.find(n => n.buffer)?.stopped, undefined, 'beam ending does not cut off the recording');
   recording.update({ ...charge, shotId: 2 }, true); feed([0.75]);
   recording.update(undefined, true); // charge cancelled
   recording.update({ ...charge, shotId: 2, phase: 'firing' }, true);
   assert.equal(ctx.played.length, 1, 'cancelled audio is discarded');
   recording.update({ ...charge, shotId: 3 }, true); feed(Array(100).fill(0.125));
   recording.update({ ...charge, shotId: 3, phase: 'firing', voiceEffect: false }, true);
   assert.equal(ctx.played[1].getChannelData(0).length, 80, 'recording is capped at charge maximum of 10 seconds');
   recording.update(undefined, false);
   assert.equal(ctx.nodes.filter(n => n.buffer).at(-1).stopped, true, 'meeting/end stops playback');
  } finally { recording.disconnect(); }
 }
 console.log('Recording lifecycle tests passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
