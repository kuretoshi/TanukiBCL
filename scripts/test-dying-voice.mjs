import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'tanuki-dying-voice-'));
async function load(path, name) {
 const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
 const file = join(dir, `${name}.mjs`); await writeFile(file, result.outputFiles[0].contents);
 return import(pathToFileURL(file));
}
function context() {
 const nodes = [], played = [];
 function node() {
  const param = () => ({ value: 0 });
  const n = { gain: param(), frequency: param(), connect() {}, disconnect() {}, start() { played.push(this); }, stop() { this.stopped = true; } };
  nodes.push(n); return n;
 }
 return { nodes, played, sampleRate: 8, currentTime: 0, createScriptProcessor: node, createGain: node, createBiquadFilter: node, createBufferSource: node,
  createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; } };
}
try {
 const { readDyingVoiceState } = await load('src/main/dyingVoiceState.ts', 'reader');
 const p = join(dir, 'state.json');
 const entry = { playerId: 1, started: 10000, seconds: 1, range: 2.5, x: 1, y: 2 };
 const document = { protocol: 1, pid: 123, unixMs: 10000, players: [entry] };
 async function save(value) { await writeFile(p, JSON.stringify(value)); }
 await save(document); assert.deepEqual(readDyingVoiceState(123, 10000, p), [entry]);
 assert.deepEqual(readDyingVoiceState(124, 10000, p), [], 'wrong process rejected');
 assert.deepEqual(readDyingVoiceState(123, 11001, p), [], 'stale state rejected');
 for (const invalid of [{ ...entry, seconds: 31 }, { ...entry, range: -1 }, { ...entry, started: 20000 }, { ...entry, x: null }, { ...entry, loop: "true" }]) {
  await save({ ...document, players: [invalid] }); assert.deepEqual(readDyingVoiceState(123, 10000, p), []);
 }
 await save({ ...document, players: [entry, entry] }); assert.deepEqual(readDyingVoiceState(123, 10000, p), [], 'duplicate players rejected');
 await save({ ...document, players: [entry, { ...entry, playerId: 2 }] });
 assert.equal(readDyingVoiceState(123, 10000, p).length, 2, 'separate messages at the same coordinates do not overwrite each other');
 const { createDyingVoiceRecording, inDyingVoiceRange } = await load(process.env.TANUKI_DYING_VOICE_SOURCE ?? 'src/renderer/voice/dyingVoiceRecording.ts', 'audio');
 const listener = { isDead: false, disconnected: false, x: 1, y: 2 };
 assert.equal(inDyingVoiceRange(entry, listener, true), true);
 assert.equal(inDyingVoiceRange(entry, { ...listener, isDead: true }, true), false, 'ghosts cannot trigger playback');
 assert.equal(inDyingVoiceRange(entry, listener, false), false, 'meetings cannot trigger playback');
 assert.equal(inDyingVoiceRange(entry, { ...listener, disconnected: true }, true), false);
 assert.equal(inDyingVoiceRange(entry, { ...listener, x: 10 }, true), false, 'out of range cannot trigger playback');
 const ctx = context(); const audio = createDyingVoiceRecording(ctx, ctx.createGain(), ctx.createGain());
 const processor = ctx.nodes.find(n => n.onaudioprocess);
 const feed = values => processor.onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from(values) } });
 try {
  feed([9]); audio.setVolume(1);
  audio.update(entry, true, false, 10000); feed([.25, .5]);
  assert.equal(ctx.played.length, 0, 'recording is inaudible');
  audio.update(entry, true, false, 11000); feed([9]);
  audio.update(entry, true, true, 11001);
  assert.deepEqual(Array.from(ctx.played[0].buffer.getChannelData(0)), [.25, .5], 'only death window captured');
  assert.equal(ctx.nodes.some(n => n.type === 'highpass'), true, 'radio highpass applied');
  assert.equal(ctx.nodes.some(n => n.type === 'lowpass'), true, 'radio lowpass applied');
  audio.update(entry, true, true, 11002); assert.equal(ctx.played.length, 1, 'no replay while standing inside');
  audio.update(entry, true, false, 11003); assert.equal(ctx.played[0].stopped, true, 'leaving stops playback');
  audio.update(entry, true, true, 11004); assert.equal(ctx.played.length, 2, 're-entry replays');
  audio.setVolume(0); assert.equal(ctx.played[1].stopped, true, 'mute stops playback');
  audio.update(undefined, false, false, 11005); audio.update(entry, true, true, 12000); feed([9]);
  assert.equal(ctx.played.length, 2, 'late listeners do not record later ghost conversation');
  const second = { ...entry, started: 20000 };
  audio.update(second, true, false, 20000); feed(Array(30).fill(.1));
  audio.update(second, true, true, 21000);
  assert.equal(ctx.played.at(-1).buffer.getChannelData(0).length, 8, 'duration bounds memory');
  audio.update(undefined, false, false, 21001); assert.equal(ctx.played.at(-1).stopped, true, 'game end clears playback');
  const third = { ...entry, started: 30000 };
  audio.update(third, true, false, 30000); feed([.5]);
  ctx.currentTime = 2; feed([9]); // State callbacks paused, but the audio clock advanced.
  audio.update(third, true, true, 31001);
  assert.deepEqual(Array.from(ctx.played.at(-1).buffer.getChannelData(0)), [.5], 'audio clock prevents recording later ghost speech even if state stalls');
  audio.cancel(); ctx.currentTime = 0;
  const looping = { ...entry, started: 40000, loop: true };
  audio.update(looping, true, false, 40000); feed([.25, .5]);
  audio.update(looping, true, true, 41000);
  assert.equal(ctx.played.at(-1).loop, true, 'loop setting reaches native audio source');
  audio.update(looping, true, false, 41001);
  assert.equal(ctx.played.at(-1).stopped, true, 'leaving stops loop');
  audio.update(looping, true, true, 41002);
  audio.setVolume(0); assert.equal(ctx.played.at(-1).stopped, true, 'mute stops loop');
  audio.cancel();
 } finally { audio.disconnect(); }
 console.log('Dying voice state, recording window, radio, proximity re-entry, mute and cleanup tests passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
