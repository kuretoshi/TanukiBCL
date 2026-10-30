import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const directory = resolve('.cache/settings-window-presence-test');
await mkdir(directory, { recursive: true });
let moduleId = 0;
async function load(entry, mocks = {}) {
	const bundle = await build({
		entryPoints: [entry],
		bundle: true,
		packages: 'external',
		platform: 'node',
		format: 'esm',
		write: false,
		plugins: [
			{
				name: 'settings-bridge-dependencies',
				setup(b) {
					b.onResolve({ filter: /.*/ }, (args) =>
						mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined
					);
					b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path] }));
					if (process.env.TANUKI_SETTINGS_BRIDGE_BASELINE)
						b.onLoad({ filter: /[\\/]settingsWindowBridge\.ts$/ }, async (args) => ({
							contents: await readFile(process.env.TANUKI_SETTINGS_BRIDGE_BASELINE, 'utf8'),
							loader: 'ts',
							resolveDir: resolve(args.path, '..'),
						}));
				},
			},
		],
	});
	const file = resolve(directory, `${process.pid}-${moduleId++}.mjs`);
	await writeFile(file, bundle.outputFiles[0].contents);
	return import(pathToFileURL(file));
}

const { IpcMessages, IpcSettingsMessages } = await load('src/common/ipc-messages.ts');
assert.ok(IpcMessages.REQUEST_SETTINGS_WINDOW_PRESENCE, 'The presence query channel must exist');
assert.ok(IpcSettingsMessages.NOTIFY_WINDOW_PRESENCE, 'The presence notification channel must exist');
const probe = {
	game: { gameState: { lobbyCode: 'FIRST', players: [], revision: 0 }, playerColors: [['red', 'dark-red']] },
	voice: {
		connected: true,
		error: '',
		muted: false,
		deafened: false,
		talking: false,
		otherTalking: {},
		playerSocketIds: {},
		audioConnected: {},
		impostorRadioClientId: null,
		impostorRadioClientIds: [],
		nosRadiosByPlayer: {},
		toh4eLobby: false,
		tohRole: null,
		tohGameStartNames: {},
		tohRoleCatalog: [],
		activeLobbySettings: { maxDistance: 5 },
		hostId: 7,
	},
	gameListeners: new Set(),
	voiceListeners: new Set(),
	ipcListeners: new Map(),
	requests: [],
	publications: [],
	gameSubscriptions: 0,
	voiceSubscriptions: 0,
	effectiveCalls: 0,
};
globalThis.__settingsWindowPresenceTest = probe;
const bridge = await load('src/renderer/state/settingsWindowBridge.ts', {
	'./gameStore': `
    const p = globalThis.__settingsWindowPresenceTest;
    export const gameStore = {
      getSnapshot: () => p.game,
      subscribe(listener) { p.gameSubscriptions++; p.gameListeners.add(listener); return () => p.gameListeners.delete(listener); },
    };`,
	'../voice/useVoiceController': `
    const p = globalThis.__settingsWindowPresenceTest;
    export const voiceController = {
      getSnapshot: () => p.voice,
      getEffectiveGameState(state) { p.effectiveCalls++; return { ...state, effective: true }; },
      subscribe(listener) { p.voiceSubscriptions++; p.voiceListeners.add(listener); return () => p.voiceListeners.delete(listener); },
    };`,
	'../lib/electron-bridge': `
    const p = globalThis.__settingsWindowPresenceTest;
    export const ipcRenderer = {
      on(channel, listener) {
        if (!p.ipcListeners.has(channel)) p.ipcListeners.set(channel, new Set());
        p.ipcListeners.get(channel).add(listener);
      },
      off(channel, listener) { p.ipcListeners.get(channel)?.delete(listener); },
      send(channel, ...args) {
        if (channel === ${JSON.stringify(IpcMessages.SEND_TO_SETTINGS)}) p.publications.push(args);
        else p.requests.push({ channel, args });
      },
      invoke() { throw new Error('Presence must use the ordered send/reply channel'); },
    };`,
});

// Execute the production helper and its registration without starting Electron or app services.
const mainSource = await readFile('src/main/ipc-handlers.ts', 'utf8');
const mainAst = ts.createSourceFile('ipc-handlers.ts', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const presenceState = mainAst.statements.find(
	(node) => ts.isFunctionDeclaration(node) && node.name?.text === 'settingsWindowsOpen'
);
assert.ok(presenceState, 'Production presence state function must be present');
const helper = mainAst.statements.find(
	(node) => ts.isFunctionDeclaration(node) && node.name?.text === 'notifySettingsWindowPresence'
);
assert.ok(helper, 'Production main helper must be present');
let registration;
function findQuery(node) {
	if (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText(mainAst) === 'ipcMain' &&
		node.expression.name.text === 'on' &&
		node.arguments[0]?.getText(mainAst) === 'IpcMessages.REQUEST_SETTINGS_WINDOW_PRESENCE'
	)
		registration = node;
	ts.forEachChild(node, findQuery);
}
findQuery(mainAst);
assert.ok(registration, 'Production query listener must be registered');
const pendingMessages = [];
const queryListeners = new Map();
function windowStub(name, destroyed = false) {
	return {
		name,
		isDestroyed: () => destroyed,
		webContents: {
			isDestroyed: () => destroyed,
			send: (channel, ...args) => pendingMessages.push({ channel, args }),
		},
	};
}
const mainGlobals = { mainWindow: windowStub('main'), settingsWindow: null, debugWindow: null };
const main = vm.createContext({
	exports: {},
	global: mainGlobals,
	IpcMessages,
	IpcSettingsMessages,
	console,
	ipcMain: { on: (channel, listener) => queryListeners.set(channel, listener) },
});
const extracted = ts.transpileModule(
	`${presenceState.getText(mainAst)}\n${helper.getText(mainAst)}\n${registration.getText(mainAst)};`,
	{
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}
).outputText;
vm.runInContext(extracted, main, { filename: 'production-settings-presence.cjs' });
const notifyPresence = main.exports.notifySettingsWindowPresence;
assert.equal(typeof notifyPresence, 'function');
function emit(channel, ...args) {
	for (const listener of [...(probe.ipcListeners.get(channel) ?? [])]) listener(undefined, ...args);
}
function flushMessages() {
	for (const message of pendingMessages.splice(0)) emit(message.channel, ...message.args);
}
function answerQuery() {
	const request = probe.requests.shift();
	assert.equal(request?.channel, IpcMessages.REQUEST_SETTINGS_WINDOW_PRESENCE);
	queryListeners.get(request.channel)(
		{
			sender: mainGlobals.mainWindow.webContents,
			reply: (channel, ...args) => pendingMessages.push({ channel, args }),
		},
		...request.args
	);
}
function presence() {
	notifyPresence();
	flushMessages();
}
function expectSubscriptions(count) {
	assert.equal(probe.gameListeners.size, count, 'Game subscription count');
	assert.equal(probe.voiceListeners.size, count, 'Voice subscription count');
}
const fullSyncEvents = [
	IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED,
	IpcSettingsMessages.NOTIFY_GAME_STATE_CHANGED,
	IpcSettingsMessages.NOTIFY_PLAYER_COLORS_CHANGED,
	IpcSettingsMessages.NOTIFY_ACTIVE_LOBBY_SETTINGS_CHANGED,
	IpcSettingsMessages.NOTIFY_HOST_ID_CHANGED,
];
function expectFullSync(start) {
	const sent = probe.publications.slice(start);
	assert.deepEqual(sent.map(([event]) => event).sort(), [...fullSyncEvents].sort());
	const state = sent.find(([event]) => event === IpcSettingsMessages.NOTIFY_GAME_STATE_CHANGED)[1];
	assert.equal(state.revision, probe.game.gameState.revision, 'Full sync must use the latest game state');
	assert.equal(state.effective, true, 'Full sync must preserve effective role state');
	const debug = sent.find(([event]) => event === IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED)[1];
	assert.equal(debug.talking, probe.voice.talking, 'Full sync must use the latest voice state');
}
function updateSources(iterations) {
	for (let index = 0; index < iterations; index++) {
		probe.game = { ...probe.game, gameState: { ...probe.game.gameState, revision: probe.game.gameState.revision + 1 } };
		for (const listener of [...probe.gameListeners]) listener();
		probe.voice = { ...probe.voice, talking: !probe.voice.talking };
		for (const listener of [...probe.voiceListeners]) listener();
	}
}
function expectDormant() {
	expectSubscriptions(0);
	const sent = probe.publications.length;
	const conversions = probe.effectiveCalls;
	updateSources(100);
	assert.equal(probe.publications.length, sent, 'No consumers: 100 game + 100 voice changes must publish nothing');
	assert.equal(probe.effectiveCalls, conversions, 'No consumers: effective state must not be derived for the bridge');
}

try {
	bridge.startSettingsWindowBridge();
	bridge.startSettingsWindowBridge();
	assert.equal(probe.requests.length, 1, 'Repeated start must send only one presence query');
	assert.equal(probe.publications.length, 0, 'Startup must wait for receiver presence');
	assert.equal(probe.ipcListeners.get(IpcSettingsMessages.NOTIFY_WINDOW_PRESENCE)?.size, 1);
	assert.equal(probe.ipcListeners.get(IpcSettingsMessages.REQUEST_INITVALUES)?.size, 1);
	answerQuery();
	flushMessages();
	expectDormant();

	mainGlobals.settingsWindow = windowStub('settings');
	let before = probe.publications.length;
	presence();
	expectSubscriptions(1);
	expectFullSync(before);
	const subscriptions = [probe.gameSubscriptions, probe.voiceSubscriptions];
	presence();
	assert.deepEqual(
		[probe.gameSubscriptions, probe.voiceSubscriptions],
		subscriptions,
		'Repeated true must not recreate subscriptions'
	);
	expectSubscriptions(1);
	before = probe.publications.length;
	updateSources(100);
	assert.equal(probe.publications.length - before, 200, 'Active receiver must retain every game/voice update');
	before = probe.publications.length;
	for (let index = 0; index < 100; index++) {
		probe.voice = { ...probe.voice, connectionQuality: { peer: index }, serverQuality: { pingMs: index } };
		for (const listener of [...probe.voiceListeners]) listener();
	}
	assert.equal(probe.publications.length, before, '100 quality-only changes must not resend identical debug data');
	for (const [key, value] of Object.entries({
		connected: false,
		error: 'connection failed',
		muted: true,
		deafened: true,
		talking: !probe.voice.talking,
		otherTalking: { 7: true },
		playerSocketIds: { 7: 'peer' },
		audioConnected: { peer: true },
		impostorRadioClientId: 7,
		impostorRadioClientIds: [7],
		nosRadiosByPlayer: { 1: { clientId: 7, radios: [] } },
		toh4eLobby: true,
		tohRole: { roleName: 'Crewmate' },
	})) {
		const start = probe.publications.length;
		probe.voice = { ...probe.voice, [key]: value };
		for (const listener of [...probe.voiceListeners]) listener();
		const updates = probe.publications
			.slice(start)
			.filter(([event]) => event === IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED);
		assert.equal(updates.length, 1, `${key} must still reach debug consumers immediately`);
		assert.deepEqual(updates[0][1][key], value);
	}

	// A second receiver relies on its normal init request even while presence remains true.
	mainGlobals.debugWindow = windowStub('debug');
	presence();
	before = probe.publications.length;
	emit(IpcSettingsMessages.REQUEST_INITVALUES);
	expectFullSync(before);
	mainGlobals.settingsWindow = null;
	presence();
	expectSubscriptions(1);
	before = probe.publications.length;
	updateSources(1);
	assert.equal(probe.publications.length - before, 2, 'Closing one of two receivers must keep the bridge active');
	mainGlobals.debugWindow = null;
	presence();
	expectDormant();

	mainGlobals.settingsWindow = windowStub('reopened settings');
	before = probe.publications.length;
	presence();
	expectFullSync(before);
	before = probe.publications.length;
	emit(IpcSettingsMessages.REQUEST_INITVALUES);
	expectFullSync(before);
	mainGlobals.settingsWindow = windowStub('destroyed settings', true);
	presence();
	expectDormant();
	mainGlobals.debugWindow = windowStub('debug survives destroyed settings');
	presence();
	expectSubscriptions(1);
	mainGlobals.debugWindow = windowStub('destroyed debug', true);
	presence();
	expectDormant();

	// Main's send reply and broadcasts use one ordered channel, with no late Promise response.
	bridge.stopSettingsWindowBridge();
	bridge.stopSettingsWindowBridge();
	expectSubscriptions(0);
	assert.equal(probe.ipcListeners.get(IpcSettingsMessages.NOTIFY_WINDOW_PRESENCE)?.size, 0);
	assert.equal(probe.ipcListeners.get(IpcSettingsMessages.REQUEST_INITVALUES)?.size, 0);
	before = probe.publications.length;
	emit(IpcSettingsMessages.REQUEST_INITVALUES);
	emit(IpcSettingsMessages.NOTIFY_WINDOW_PRESENCE, true);
	assert.equal(probe.publications.length, before, 'Stopped bridge must not respond to IPC');

	mainGlobals.settingsWindow = windowStub('query sees open');
	mainGlobals.debugWindow = null;
	bridge.startSettingsWindowBridge();
	assert.equal(probe.requests.length, 1, 'Restart must query current presence again');
	answerQuery();
	mainGlobals.settingsWindow = null;
	notifyPresence();
	assert.deepEqual(
		pendingMessages.map(({ args }) => args[0]),
		[true, false]
	);
	flushMessages();
	expectDormant();
	bridge.stopSettingsWindowBridge();
	bridge.startSettingsWindowBridge();
	answerQuery();
	mainGlobals.debugWindow = windowStub('opened after query');
	notifyPresence();
	assert.deepEqual(
		pendingMessages.map(({ args }) => args[0]),
		[false, true]
	);
	flushMessages();
	expectSubscriptions(1);
	before = probe.publications.length;
	emit(IpcSettingsMessages.REQUEST_INITVALUES);
	expectFullSync(before);

	bridge.stopSettingsWindowBridge();
	mainGlobals.mainWindow = windowStub('destroyed main', true);
	const queued = pendingMessages.length;
	assert.doesNotThrow(notifyPresence);
	assert.equal(pendingMessages.length, queued, 'Destroyed main window must not receive messages');
	mainGlobals.mainWindow = null;
	assert.doesNotThrow(notifyPresence);
	console.log(
		'PASS settings/debug window presence: inactive and 100 quality-only changes send nothing; displayed field changes, forced full init, ordered query, open/close/reopen, two receivers, destroyed windows and restart'
	);
} finally {
	bridge.stopSettingsWindowBridge();
	delete globalThis.__settingsWindowPresenceTest;
}
