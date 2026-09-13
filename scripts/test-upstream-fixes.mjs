import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';

globalThis.window = { electron: { ipcRenderer: { on() {}, off() {}, send() {} }, shell: {}, platform: 'win32' } };
const cache = resolve('.tools/test-cache');
await mkdir(cache, { recursive: true });
let moduleIndex = 0;
async function bundle(entry, plugins = []) {
  const output = await build({ entryPoints: [entry], bundle: true, packages: 'external', write: false, platform: 'node', format: 'esm',
    define: { 'import.meta.env.DEV': 'false' }, plugins });
  const file = join(cache, `${moduleIndex++}.mjs`);
  await writeFile(file, output.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}
const { selectVoiceEffect } = await bundle('src/renderer/voice/voiceEffectRules.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { AudioController } = await bundle('src/renderer/voice/AudioController.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { MapType, CameraLocation } = await bundle('src/common/AmongusMap.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const lobby = { ...defaultLobbySettings };
const settings = { voiceEffectStrength: 70, enableSpatialAudio: true, ghostVolumeAsImpostor: 40 };
const me = { id: 1, clientId: 1, name: 'A', appearanceName: 'A', x: 0, y: 0, isLocal: true };
const other = { id: 2, clientId: 2, name: 'B', appearanceName: 'A', x: 1, y: 0, sizeScale: 1, specialRole: 'UNKNOWN' };
const state = { gameState: GameState.TASKS, map: MapType.SKELD, players: [me, other], currentCamera: CameraLocation.NONE, closedDoors: [] };
const rule = (s = state, l = lobby, a = me, b = other, radio = -1) => selectVoiceEffect(s, settings, l, a, b, radio);
assert.equal(rule().strength, 70);
assert.equal(rule({ ...state, gameState: GameState.DISCUSSION }), null);
assert.equal(rule(state, { ...lobby, voiceEffectEnabled: false }), null);
for (const key of ['isDead', 'disconnected', 'bugged', 'isDummy']) assert.equal(rule(state, lobby, me, { ...other, [key]: true }), null);
assert.equal(rule(state, lobby, { ...me, isDead: true }), null);
assert.equal(rule(state, { ...lobby, impostorRadioEnabled: true }, { ...me, isImpostor: true }, { ...other, isImpostor: true }, 2), null);
assert.equal(rule(state, lobby, me, { ...other, appearanceName: 'B', sizeScale: 1.5, specialRole: 'GIANT' }).direction, 'down');
assert.equal(rule(state, lobby, me, { ...other, appearanceName: 'B', sizeScale: 0.5, specialRole: 'MINI' }).direction, 'up');
console.log('ok voice effects: disguise, size, meeting, death, radio and host toggle');

const spatial = (changes = {}) => calculateVoiceAudio({ state, settings, activeLobbySettings: lobby, me, other, maxDistance: 5.32, impostorRadioClientId: -1, ...changes });
assert.equal(spatial().gain, 1);
assert.equal(spatial({ other: { ...other, x: 50 } }).gain, 0);
assert.equal(spatial({ state: { ...state, map: MapType.AIRSHIP, airshipMeetingByOutfit: true }, other: { ...other, x: 50 } }).gain, 1);
assert.equal(spatial({ state: { ...state, map: MapType.AIRSHIP }, airshipSpawnFallback: true, other: { ...other, x: 50 } }).gain, 1);
assert.equal(spatial({ other: { ...other, isDead: true } }).gain, 0);
const ghost = spatial({ me: { ...me, isThirdParty: true }, other: { ...other, isDead: true }, activeLobbySettings: { ...lobby, thirdPartyHaunting: true } });
assert.equal(ghost.gain, 0.4); assert.equal(ghost.reverb, true);
const radio = spatial({ me: { ...me, isImpostor: true }, other: { ...other, isImpostor: true }, activeLobbySettings: { ...lobby, impostorRadioEnabled: true }, impostorRadioClientId: 2 });
assert.equal(radio.muffle.type, 'highpass');
assert.equal(spatial({ me: { ...me, inVent: true } }).muffle.type, 'lowpass');
assert.equal(spatial().muffle, false);
console.log('ok spatial audio: distance, Airship, third-party haunting, radio/vent filter restoration');

class Node {
  connections = new Set(); gain = { value: 1 }; frequency = { value: 0 }; Q = { value: 0 }; delayTime = { value: 0 };
  positionX = { setValueAtTime() {} }; positionY = { setValueAtTime() {} }; positionZ = { setValueAtTime() {} };
  connect(target) { this.connections.add(target); return target; }
  disconnect() { this.connections.clear(); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
const context = { currentTime: 0, sampleRate: 8000, closed: false,
  createGain: () => new Node(), createBiquadFilter: () => new Node(), createDelay: () => new Node(), createBufferSource: () => new Node(),
  createBuffer: (_, length) => ({ getChannelData: () => new Float32Array(length) }) };
const audio = new AudioController(); audio.context = context; audio.masterGain = new Node();
function peer() { const pan = new Node(); pan.context = context; return { gain: new Node(), pan, muffle: new Node(), reverb: new Node(), source: new Node(),
  reverbConnected: false, muffleConnected: false, voiceEffectConnected: false,
  dummyAudioElement: { pause() {}, removeAttribute() {}, load() {}, remove() {} } }; }
const first = peer(), second = peer(); audio.peers.set('first', first); audio.peers.set('second', second);
audio.applyVoiceAudio('first', state, settings, lobby, me, other, -1);
assert.ok(first.voiceEffectConnected); assert.ok(first.gain.connections.has(first.voiceEffect.input));
const effect = first.voiceEffect;
audio.applyVoiceAudio('first', { ...state, gameState: GameState.DISCUSSION }, settings, lobby, me, other, -1);
assert.equal(first.voiceEffect, undefined); assert.equal(first.voiceEffectConnected, false); assert.ok(effect.delayModA.stopped); assert.ok(first.gain.connections.has(audio.masterGain));
audio.applyVoiceAudio('first', state, settings, lobby, me, other, -1);
audio.silenceAllPeers(); assert.equal(first.voiceEffect, undefined); assert.equal(first.gain.gain.value, 0);
audio.removePeer('first'); assert.ok(audio.peers.has('second')); assert.equal(context.closed, false);
console.log('ok audio graph: effects release, route restoration and independent peer cleanup');

const readerSource = ts.createSourceFile('GameReader.ts', await readFile('src/main/GameReader.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let notificationBlock;
function findColorLoader(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(readerSource) === 'loadColors') {
    notificationBlock = node.body.statements.find(statement => ts.isTryStatement(statement));
  }
  ts.forEachChild(node, findColorLoader);
}
findColorLoader(readerSource);
assert.ok(notificationBlock);
const notifications = [], colors = [];
const reader = { playercolors: colors, colorsInitialized: true, sendIPC: (...args) => notifications.push(args) };
let resolveGeneration, rejectGeneration;
const notify = vm.runInNewContext(`(function () { ${notificationBlock.getText(readerSource)} })`, {
  playercolors: colors, console: { log() {}, error() {} },
  IpcOverlayMessages: { NOTIFY_PLAYERCOLORS_CHANGED: 'colors' },
  GenerateAvatars: () => new Promise((resolve, reject) => { resolveGeneration = resolve; rejectGeneration = reject; }),
});
const settle = () => new Promise(resolve => setImmediate(resolve));
notify.call(reader); assert.equal(notifications.length, 0);
resolveGeneration(); await settle(); assert.equal(notifications.length, 1);
notify.call(reader); rejectGeneration(new Error('generation failed')); await settle();
assert.equal(notifications.length, 1); assert.equal(reader.colorsInitialized, false);
notify.call(reader); reader.playercolors = []; resolveGeneration(); await settle();
assert.equal(notifications.length, 1);
console.log('ok color notifications: wait for success, retry failures and ignore superseded results');

const temp = await mkdtemp(join(tmpdir(), 'tanukibcl-avatar-'));
try {
  const avatar = await bundle('src/main/avatarGenerator.ts', [{ name: 'test-assets', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(temp)} };` }));
    b.onResolve({ filter: /\.png\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?inline', '')), namespace: 'png' }));
    b.onLoad({ filter: /.*/, namespace: 'png' }, async args => ({ contents: `export default ${JSON.stringify('data:image/png;base64,' + (await readFile(args.path)).toString('base64'))}` }));
  }}]);
  await avatar.GenerateAvatars([['#ff0000', '#880000']]);
  for (const type of ['ghost', 'player']) {
    const png = await readFile(join(temp, 'static/generated', type, '0.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  }
  await assert.rejects(avatar.GenerateAvatars([['not-a-color', '#000000']]));
  console.log('ok avatar PNG generation and failure propagation');
} finally {
  assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'tanukibcl-avatar-')));
  await rm(temp, { recursive: true, force: true });
}
