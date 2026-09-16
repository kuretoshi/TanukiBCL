import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';
import { pbkdf2Sync } from 'node:crypto';

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
const { verifyDebugPassword } = await bundle('src/main/debugAuth.ts');
const authSalt = '0123456789abcdef0123456789abcdef';
const authConfig = JSON.stringify({ salt: authSalt, hash: pbkdf2Sync('test-only-password', Buffer.from(authSalt, 'hex'), 100000, 32, 'sha256').toString('hex') });
assert.equal(verifyDebugPassword('test-only-password', authConfig), true);
for (const password of ['', 'incorrect', null, {}, 'x'.repeat(1025)]) assert.equal(verifyDebugPassword(password, authConfig), false);
for (const config of ['', '{}', 'invalid']) assert.equal(verifyDebugPassword('test-only-password', config), false);
console.log('ok developer password: correct password only, invalid and missing configuration rejected');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { AudioController } = await bundle('src/renderer/voice/AudioController.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { normalizeMeetingState } = await bundle('src/common/meetingState.ts');
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
assert.equal(rule(state, lobby, me, { ...other, appearanceName: 'B', sizeScale: 1.5, specialRole: 'JUMBO' }), null);
assert.equal(rule(state, lobby, me, { ...other, appearanceName: 'B', sizeScale: 0.5, specialRole: 'MINI' }), null);
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

const disguised = { ...other, name: 'Original', nameHash: 123, playerConfigId: 456,
  colorId: 2, hatId: 'original-hat', skinId: 'original-skin', visorId: 'original-visor',
  currentOutfit: 3, appearanceName: 'Target', appearanceColorId: 4, appearanceHatId: 'target-hat',
  appearanceSkinId: 'target-skin', appearanceVisorId: 'target-visor', appearanceId: 'target',
  shiftedColor: 4, sizeScale: 1.5, inVent: true, specialRole: 'JUMBO' };
const taskSnapshot = { ...state, players: [me, disguised], mixupSabotaged: true, camouflaged: true };
assert.equal(normalizeMeetingState(taskSnapshot), taskSnapshot);
const meeting = normalizeMeetingState({ ...taskSnapshot, gameState: GameState.DISCUSSION });
const restored = meeting.players[1];
assert.deepEqual([restored.appearanceName, restored.appearanceColorId, restored.appearanceHatId,
  restored.appearanceSkinId, restored.appearanceVisorId, restored.appearanceId],
  ['Original', 2, 'original-hat', 'original-skin', 'original-visor', '2|original-hat|original-skin|original-visor']);
assert.equal(restored.currentOutfit, 0); assert.equal(restored.shiftedColor, -1);
assert.equal(restored.inVent, false); assert.equal(restored.sizeScale, 1);
assert.equal(restored.clientId, disguised.clientId); assert.equal(restored.nameHash, 123); assert.equal(restored.playerConfigId, 456);
assert.equal(meeting.mixupSabotaged, false); assert.equal(meeting.camouflaged, false);
assert.equal(disguised.appearanceName, 'Target');
assert.equal(normalizeMeetingState(taskSnapshot).players[1].appearanceName, 'Target');
assert.equal(rule(meeting, lobby, me, restored), null);
const meetingAudio = spatial({ state: { ...meeting, map: MapType.AIRSHIP, comsSabotaged: true },
  me: { ...me, x: -100, y: -100, inVent: true }, other: { ...restored, x: 100, y: 100 },
  activeLobbySettings: { ...lobby, wallsBlockAudio: true, commsSabotage: true, meetingGhostOnly: true } });
assert.equal(meetingAudio.gain, 1); assert.deepEqual(meetingAudio.panPosition, [0, 0]);
assert.equal(meetingAudio.muffle, false); assert.equal(meetingAudio.reverb, false);
assert.equal(spatial({ state: meeting, other: { ...restored, isDead: true } }).gain, 0);
console.log('ok meeting reset: canonical appearance, stable identity, normal voice and task-state preservation');

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
const { modList } = await bundle('src/common/Mods.ts');
let detectModMethod;
function findModDetector(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(readerSource) === 'getInstalledMods') detectModMethod = node;
  ts.forEachChild(node, findModDetector);
}
findModDetector(readerSource);
let loadedModule;
let loadedModuleName = 'SuperNewRoles.dll';
const detectMod = vm.runInNewContext(ts.transpileModule(`({ ${detectModMethod.getText(readerSource)} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, { modList, path: { basename: value => value.split(/[\\/]/).pop() }, findModule: (name, pid) => {
  assert.ok(['SuperNewRoles.dll', 'Nebula.dll'].includes(name)); assert.equal(pid, 42);
  if (!loadedModule || name !== loadedModuleName) throw new Error('module not found');
  return loadedModule;
} }).getInstalledMods;
const modReader = { pid: 42, readPluginFiles: () => [] };
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'NONE');
loadedModule = { th32ProcessID: 42, szModule: 'SuperNewRoles.dll', modBaseAddr: 100, modBaseSize: 200, szExePath: 'launcher/BepInEx/plugins/SuperNewRoles.dll' };
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'SUPER_NEW_ROLES');
assert.ok(modReader.loadedMods.includes(loadedModule.szExePath));
loadedModuleName = 'Nebula.dll';
loadedModule = { th32ProcessID: 42, szModule: 'Nebula.dll', modBaseAddr: 100, modBaseSize: 200, szExePath: 'game/BepInEx/nebula/Nebula.dll' };
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'NoS');
assert.ok(modReader.loadedMods.includes(loadedModule.szExePath));
loadedModule.th32ProcessID = 99;
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'NONE');
loadedModule.th32ProcessID = 42;
loadedModule.szModule = 'SuperNewRoles.dll';
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'NONE');
loadedModule = undefined;
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'NONE');
assert.equal(modReader.loadedMods.length, 0);
modReader.readPluginFiles = () => ['TheOtherRoles.dll'];
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'THE_OTHER_ROLES');
modReader.readPluginFiles = () => ['SuperNewRoles.dll'];
assert.equal(detectMod.call(modReader, 'game/Among Us.exe').id, 'SUPER_NEW_ROLES');
console.log('ok MOD detection: launcher module, Vanilla, late loading and existing folder fallback');
let checkProcessMethod;
function findProcessChecker(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(readerSource) === 'checkProcessOpen') checkProcessMethod = node;
  ts.forEachChild(node, findProcessChecker);
}
findProcessChecker(readerSource);
let runningProcesses = [{ szExeFile: 'Among Us.exe', th32ProcessID: 42 }];
const checkProcess = vm.runInNewContext(ts.transpileModule(`({ ${checkProcessMethod.getText(readerSource)} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, { modList, getProcesses: () => runningProcesses, targetProcessName: 'Among Us.exe', targetProcessId: 0, targetProcessIndex: 0,
  console: { log() {} }, IpcRendererMessages: { NOTIFY_GAME_OPENED: 'opened' } }).checkProcessOpen;
const switchingReader = { pid: 42, amongUs: {}, loadedMod: modList.find(m => m.id === 'SUPER_NEW_ROLES'), loadedMods: ['old.dll'],
  nextModCheck: 0, gamePath: 'game/Among Us.exe', getInstalledMods: () => modList.find(m => m.id === 'NoS'), sendIPC() {} };
await checkProcess.call(switchingReader);
assert.equal(switchingReader.loadedMod.id, 'NoS');
runningProcesses = [];
await checkProcess.call(switchingReader);
assert.equal(switchingReader.loadedMod.id, 'NONE');
assert.equal(switchingReader.loadedMods.length, 0);
console.log('ok MOD refresh: previous SNR result corrected to Nebula and cleared on game exit');
const reconnectMethods = [];
function findReconnectMethods(node) {
  if (ts.isMethodDeclaration(node) && ['requestReconnect', 'resetAmongUsProcess', 'loop'].includes(node.name.getText(readerSource))) {
    reconnectMethods.push(node.getText(readerSource).replace(/^private /, ''));
  }
  ts.forEachChild(node, findReconnectMethods);
}
findReconnectMethods(readerSource);
const reconnectReader = vm.runInNewContext(ts.transpileModule(`({ ${reconnectMethods.join(',')} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, { IpcRendererMessages: { NOTIFY_GAME_OPENED: 'opened' } });
const reconnectEvents = [];
Object.assign(reconnectReader, { amongUs: {}, colorsInitialized: true, initializedWrite: true, checkProcessDelay: 30,
  sendIPC: (...args) => reconnectEvents.push(args),
  async checkProcessOpen() { reconnectEvents.push(['checked']); },
});
reconnectReader.requestReconnect();
assert.equal(reconnectReader.colorsInitialized, true, 'reset waits until the next read loop');
await reconnectReader.loop();
assert.equal(reconnectReader.amongUs, null);
assert.equal(reconnectReader.colorsInitialized, false);
assert.equal(reconnectReader.initializedWrite, false);
assert.deepEqual(reconnectEvents, [['opened', false], ['checked']]);
await reconnectReader.loop();
assert.equal(reconnectEvents.length, 2, 'reconnect runs only once');
console.log('ok reload: reset cached game state and colors before reconnecting on the next read loop');
let parsePlayerMethod;
function findParser(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(readerSource) === 'parsePlayer') parsePlayerMethod = node;
  ts.forEachChild(node, findParser);
}
findParser(readerSource);
assert.ok(parsePlayerMethod);
const parsePlayer = vm.runInNewContext(ts.transpileModule(`({ ${parsePlayerMethod.getText(readerSource)} })`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, { RainbowColorId: -99 }).parsePlayer;
const originalOutfit = { name: 'Original', color: 2, hat: 'original-hat', skin: 'original-skin', visor: 'original-visor' };
const targetOutfit = { name: 'Target', color: 4, hat: 'target-hat', skin: 'target-skin', visor: 'target-visor' };
for (const entries of [[[3, targetOutfit], [0, originalOutfit]], [[0, originalOutfit], [3, targetOutfit]]]) {
  const fixture = {
    PlayerStruct: { report: () => ({ data: { objectPtr: 10, outfitsPtr: 20, rolePtr: 30, clientId: 2, disconnected: 0, dead: 0, id: 2 } }) },
    offsets: { player: { currentOutfit: 'outfit', remoteX: 'x', remoteY: 'y', roleTeam: 'role', isDummy: 'dummy', inVent: 'vent',
      outfit: { playerName: 'name', colorId: 'color', hatId: 'hat', skinId: 'skin', visorId: 'visor' } } },
    playercolors: Array(18), rainbowColor: 99,
    readString: value => value || '',
    readMemory: (_type, address, offset) => offset === undefined ? address : typeof address === 'object' ? address[offset] : ({ outfit: 3, x: 1, y: 2, role: 1, dummy: false, vent: 0 }[offset]),
    readDictionary: (_ptr, _limit, visit) => entries.forEach(([key, value], index) => visit(key, value, index)),
    readRoleSizeScale: () => { throw new Error('size inference must stay disabled'); }, getSpecialRoleFromSize: () => { throw new Error('special role inference must stay disabled'); }, formatRoleLabel: () => 'IMPOSTOR',
    hashCode: value => value.length,
  };
  const parsed = parsePlayer.call(fixture, 1, Buffer.alloc(0));
  assert.equal(parsed.sizeScale, 1); assert.equal(parsed.specialRole, 'UNKNOWN');
  assert.equal(parsed.name, 'Original'); assert.equal(parsed.colorId, 2); assert.equal(parsed.skinId, 'original-skin');
  assert.equal(parsed.appearanceName, 'Target'); assert.equal(parsed.appearanceSkinId, 'target-skin');
  const reset = normalizeMeetingState({ ...meeting, players: [parsed] }).players[0];
  assert.equal(reset.appearanceName, 'Original'); assert.equal(reset.appearanceSkinId, 'original-skin');
}
console.log('ok outfit parsing: original outfit restored regardless of dictionary order');
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

const { ConnectionQualitySampler, qualityBars } = await bundle('src/renderer/voice/connectionQuality.ts');
const qualitySampler = new ConnectionQualitySampler();
const stats = (received, lost, jitter = 0.01, rtt = 0.08, id = 'audio') => new Map([
  ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
  ['selected', { type: 'candidate-pair', currentRoundTripTime: rtt }],
  ['unused', { type: 'candidate-pair', currentRoundTripTime: 5 }],
  [id, { id, type: 'inbound-rtp', kind: 'audio', packetsReceived: received, packetsLost: lost, jitter }],
]);
assert.deepEqual(qualitySampler.read(stats(100, 10)), { rttMs: 80, jitterMs: 10, lossPercent: null });
assert.equal(qualitySampler.read(stats(198, 12)).lossPercent, 2);
assert.equal(qualitySampler.read(stats(198, 12)).lossPercent, null);
assert.equal(qualitySampler.read(stats(298, 11)).lossPercent, 0);
assert.equal(qualitySampler.read(stats(1, 0)).lossPercent, null);
assert.equal(qualitySampler.read(stats(100, 0, 0.01, 0.08, 'new-stream')).lossPercent, null);
assert.deepEqual(qualitySampler.read(new Map()), { rttMs: null, jitterMs: null, lossPercent: null });
assert.equal(qualityBars(), 0);
assert.equal(qualityBars({ rttMs: null, jitterMs: 0, lossPercent: 0 }), 0);
assert.equal(qualityBars({ rttMs: 80, jitterMs: 10, lossPercent: 0 }), 3);
assert.equal(qualityBars({ rttMs: 150, jitterMs: 10, lossPercent: 0 }), 2);
assert.equal(qualityBars({ rttMs: 80, jitterMs: 30, lossPercent: 0 }), 2);
assert.equal(qualityBars({ rttMs: 80, jitterMs: 10, lossPercent: 5 }), 1);
console.log('ok connection quality: selected route, interval loss, idle/reset streams and quality thresholds');

// Exercise the actual main-process overlay lifecycle without native game hooks.
const mainSource = ts.createSourceFile('index.ts', await readFile('src/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const overlayFunctions = mainSource.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['setOverlayEnabled', 'showOverlayWithRetry', 'hideOverlay'].includes(node.name?.text)).map(node => node.getText(mainSource));
assert.equal(overlayFunctions.length, 3);
const overlayTimers = new Map();
let overlayTimerId = 0, overlayCreated = 0, overlayShown = 0, overlayStopped = 0, failOverlayShow = false;
const overlayGlobal = { overlay: null };
const overlayRuntime = vm.runInNewContext(ts.transpileModule(`
let overlayRequested = false;
let overlayTimer;
let isQuitting = false;
${overlayFunctions.join('\n')}
({ setOverlayEnabled, showOverlayWithRetry, quit: () => { isQuitting = true; } });
`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, {
  global: overlayGlobal, console: { log() {} },
  setTimeout: callback => { const id = ++overlayTimerId; overlayTimers.set(id, callback); return id; },
  clearTimeout: id => overlayTimers.delete(id),
  createOverlay: () => { overlayCreated++; return { isDestroyed: () => false, destroy() { this.destroyed = true; } }; },
  overlayWindow: { show() { if (failOverlayShow) throw new Error('temporary failure'); overlayShown++; }, hide() {}, stop() { overlayStopped++; } },
});
const runOverlayTimer = () => {
  const entry = overlayTimers.entries().next().value;
  assert.ok(entry, 'expected a pending overlay timer');
  overlayTimers.delete(entry[0]); entry[1]();
};
overlayRuntime.setOverlayEnabled(true);
runOverlayTimer();
assert.equal(overlayCreated, 1, 'normal startup enables overlay without command-line flags');
assert.equal(overlayShown, 1);
const firstOverlay = overlayGlobal.overlay;
overlayRuntime.setOverlayEnabled(false);
assert.equal(firstOverlay.destroyed, true);
assert.equal(overlayGlobal.overlay, null);
assert.equal(overlayStopped, 1);
overlayRuntime.setOverlayEnabled(true);
overlayRuntime.setOverlayEnabled(false);
assert.equal(overlayTimers.size, 0, 'disable cancels delayed startup');
overlayRuntime.setOverlayEnabled(true);
failOverlayShow = true;
runOverlayTimer();
assert.equal(overlayTimers.size, 1);
const staleRetry = overlayTimers.values().next().value;
overlayRuntime.setOverlayEnabled(false);
assert.equal(overlayTimers.size, 0, 'disable cancels retries');
staleRetry();
assert.equal(overlayGlobal.overlay, null, 'stale retries cannot reopen disabled overlay');
failOverlayShow = false;
overlayRuntime.setOverlayEnabled(true);
runOverlayTimer();
assert.equal(overlayShown, 2, 'overlay can be enabled again');
overlayRuntime.setOverlayEnabled(false);
overlayRuntime.setOverlayEnabled(true);
failOverlayShow = true;
for (let attempt = 0; attempt < 9; attempt++) runOverlayTimer();
assert.equal(overlayTimers.size, 0);
assert.equal(overlayGlobal.overlay, null, 'exhausted retries release native attachment and window');
overlayRuntime.setOverlayEnabled(true);
overlayRuntime.quit();
runOverlayTimer();
assert.equal(overlayGlobal.overlay, null, 'shutdown cannot reopen overlay');
console.log('ok overlay: normal startup, toggle cancellation, retry cleanup, re-enable and shutdown');
