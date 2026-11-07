import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import vm from 'node:vm';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { compileClientPeerValidator, clientPeerSchema } from './tauri-validator.mjs';
import { verifyTauriBase } from './verify-tauri-base.mjs';

const root = resolve(import.meta.dirname, '..');
const workerRoot = join(root, 'out/tauri-backend');
const data = await mkdtemp(join(tmpdir(), 'tanuki-tauri-test-'));
const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const base = await verifyTauriBase(root);

const generatedValidator = await build({
	stdin: { contents: compileClientPeerValidator(), resolveDir: root },
	bundle: true,
	write: false,
	format: 'iife',
	globalName: 'validator',
	platform: 'browser',
});
const validatorContext = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(Buffer.from(generatedValidator.outputFiles[0].contents).toString(), validatorContext);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const originalValidator = ajv.compile(clientPeerSchema);
for (const candidate of [
	{ forceRelayOnly: false, iceServers: [] },
	{
		forceRelayOnly: true,
		iceServers: [
			{ urls: ['stun:stun.l.google.com:19302', 'turn:example.com:3478'], username: 'test', credential: 'test' },
		],
	},
	{},
	null,
	{ forceRelayOnly: 'yes', iceServers: [] },
	{ forceRelayOnly: false, iceServers: [{ urls: 'not a URI' }] },
	{ forceRelayOnly: false, iceServers: [{ urls: ['stun:example.com', 5] }] },
]) {
	assert.equal(validatorContext.validator.validateClientPeerConfig(candidate), originalValidator(candidate));
}
console.log('ok peer validator matches existing behavior with eval disabled');

// A late asynchronous snapshot must not overwrite a newer pushed game state.
const callbacks = new Map();
let resolveInitial;
globalThis.__tauriTestBridge = {
	on: (channel, listener) => callbacks.set(channel, listener),
	off: (channel) => callbacks.delete(channel),
	invoke: (channel) =>
		channel === 'START_HOOK'
			? Promise.resolve()
			: new Promise((resolve) => {
					resolveInitial = resolve;
				}),
};
const bundledStore = await build({
	entryPoints: [join(root, 'src/renderer/state/gameStore.ts')],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [
		{
			name: 'mock-ipc',
			setup(plugin) {
				plugin.onResolve({ filter: /electron-bridge$/ }, () => ({ path: 'mock-ipc', namespace: 'mock' }));
				plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
					contents: 'export const ipcRenderer = globalThis.__tauriTestBridge;',
				}));
			},
		},
	],
});
const game = await import(
	'data:text/javascript;base64,' + Buffer.from(bundledStore.outputFiles[0].contents).toString('base64')
);
game.startGameStore();
await new Promise(setImmediate);
callbacks.get('NOTIFY_GAME_STATE_CHANGED')(undefined, { lobbyCode: 'LATEST' });
resolveInitial({ lobbyCode: 'STALE' });
await new Promise(setImmediate);
assert.equal(game.gameStore.getSnapshot().gameState.lobbyCode, 'LATEST');
game.stopGameStore();
game.startGameStore();
await new Promise(setImmediate);
game.stopGameStore();
resolveInitial({ lobbyCode: 'STOPPED' });
await new Promise(setImmediate);
assert.equal(game.gameStore.getSnapshot().gameState.lobbyCode, 'LATEST');
delete globalThis.__tauriTestBridge;
console.log('ok asynchronous game snapshots preserve newer events and ignore stopped subscriptions');

async function start() {
	const child = spawn(join(workerRoot, 'tanuki-node.exe'), [join(workerRoot, 'backend.mjs')], {
		cwd: data,
		windowsHide: true,
		env: {
			...process.env,
			NODE_OPTIONS: '',
			NODE_PATH: '',
			TANUKI_TAURI_DATA: data,
			TANUKI_TAURI_VERSION: config.version,
			BETTERCREWLINK_LITE: '0',
			BETTERCREWLINK_TARGET_PROCESS: '__tauri_test_no_game__.exe',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-5000);
	});
	const requests = new Map();
	const frames = [];
	let id = 0;
	let ready;
	const started = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Worker startup timed out: ${stderr}`)), 10000);
		ready = () => {
			clearTimeout(timer);
			resolve();
		};
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`Worker exited ${code}: ${stderr}`));
		});
	});
	const lines = createInterface({ input: child.stdout });
	lines.on('line', (line) => {
		const frame = JSON.parse(line); // stdout must contain protocol frames only
		frames.push(frame);
		if (frame.type === 'ready') ready();
		if (frame.type === 'response') {
			const pending = requests.get(frame.id);
			if (!pending) return;
			requests.delete(frame.id);
			clearTimeout(pending.timer);
			if (frame.error) pending.reject(new Error(frame.error));
			else pending.resolve(frame.value);
		}
	});
	await started;
	return {
		frames,
		request(channel, args = [], mode = 'invoke', target = 'main') {
			return new Promise((resolve, reject) => {
				const requestId = ++id;
				const timer = setTimeout(() => {
					requests.delete(requestId);
					reject(new Error(`${channel} timed out: ${stderr}`));
				}, 10000);
				requests.set(requestId, { resolve, reject, timer });
				child.stdin.write(JSON.stringify({ id: requestId, target, channel, args, mode }) + '\n');
			});
		},
		async close() {
			const exited = once(child, 'exit');
			child.stdin.end();
			const timer = setTimeout(() => child.kill(), 3000);
			await exited;
			clearTimeout(timer);
			lines.close();
		},
	};
}

let worker;
try {
	worker = await start();
	assert.deepEqual(
		{ ...(await worker.request('tauri:ping')), pid: 0 },
		{
			runtime: 'node',
			electron: false,
			version: config.version,
			pid: 0,
			baseVersion: base.baseVersion,
			baseTag: base.tag,
			baseCommit: base.commit,
		}
	);
	await worker.request('REQUEST_SETTINGS_WINDOW_PRESENCE', [], 'send');
	assert.ok(
		worker.frames.some((frame) => frame.channel === 'SETTINGS_NOTIFY_WINDOW_PRESENCE' && frame.args[0] === false)
	);
	await worker.request('OPEN_SETTINGS', [], 'send');
	assert.ok(
		worker.frames.some((frame) => frame.channel === 'SETTINGS_NOTIFY_WINDOW_PRESENCE' && frame.args[0] === true)
	);
	const initial = await worker.request('settings:get');
	assert.equal(initial.language, 'ja');
	assert.equal(initial.myLobbySettings.maxDistance, 5.32);
	await worker.request('settings:set', ['masterVolume', 67], 'send');
	assert.equal((await worker.request('settings:get')).masterVolume, 67);
	await worker.request('settings:set', ['myLobbySettings.maxDistance', 9, false], 'send');
	assert.equal((await worker.request('settings:get')).myLobbySettings.maxDistance, 9);
	assert.ok(
		worker.frames.some(
			(frame) => frame.type === 'event' && frame.channel === 'settings:changed' && frame.target === 'settings'
		)
	);
	const stored = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
	assert.equal(stored.masterVolume, 67);
	assert.equal(stored.myLobbySettings.maxDistance, 5.32);
	console.log('ok isolated settings, persistence, transient settings, cross-window events');

	assert.equal(await worker.request('GET_INITIAL_STATE'), null);
	await worker.request('START_HOOK'); // exercises the real N-API reader and keyboard watcher
	assert.ok(await worker.request('GET_INITIAL_STATE'));
	assert.equal(await worker.request('REQUEST_MOD'), 'NONE');
	assert.equal(await worker.request('NOS_HERO_SPEECH_STATE'), null);
	assert.equal(await worker.request('tauri:snr-worker-probe'), null);
	assert.equal(await worker.request('player-bans:check', [null, null, null, []]), 'unavailable');
	await worker.request('OPEN_SETTINGS', [], 'send');
	assert.ok(
		worker.frames.some((frame) => frame.type === 'control' && frame.action === 'open' && frame.target === 'settings')
	);
	await worker.request('SEND_TO_MAINWINDOW', ['SETTINGS_REQUEST_INITVALUES'], 'send', 'settings');
	assert.ok(
		worker.frames.some(
			(frame) => frame.type === 'event' && frame.target === 'main' && frame.channel === 'SETTINGS_REQUEST_INITVALUES'
		)
	);
	const platforms = await worker.request('REQUEST_PLATFORMS_AVAILABLE', [{}]);
	assert.equal(typeof platforms, 'object');
	console.log('ok native reader startup, asynchronous initial state, window routing, registry discovery');
	await worker.request('enableOverlay', [true], 'send');
	await worker.request('SEND_TO_OVERLAY', ['NOTIFY_GAME_STATE_CHANGED', { lobbyCode: 'OVERLAY' }], 'send');
	assert.ok(worker.frames.some((frame) => frame.target === 'overlay' && frame.channel === 'NOTIFY_GAME_STATE_CHANGED'));

	const image = await readFile(join(root, 'static/images/generate/player.png'));
	await mkdir(join(data, 'static/generated/player'), { recursive: true });
	await writeFile(join(data, 'static/generated/player/0.png'), image);
	assert.deepEqual(
		Buffer.from(await worker.request('__asset', ['static', '//generated/player/0.png', '']), 'base64'),
		image
	);
	await assert.rejects(worker.request('__asset', ['static', '/%2e%2e/config.json', '']), /Invalid asset/);
	await assert.rejects(
		worker.request('__asset', ['generate', '/hat', 'url=file:///C:/Windows/win.ini']),
		/Invalid hat collection/
	);
	await assert.rejects(worker.request('not-a-channel'), /Unsupported request/);
	assert.equal(await worker.request('OPEN_DEBUG', ['wrong'], 'invoke', 'main'), 'denied');
	assert.equal(await worker.request('debug:get-logs', [], 'invoke', 'main'), '');
	assert.ok((await worker.request('debug:player-bans', [{}], 'invoke', 'settings')).error);
	const updater = await worker.request('updater:get-state');
	assert.match(updater.error, /手動更新/);
	console.log('ok generated avatars, path restrictions, debug access, separate update behavior');
	await worker.request('__window_state', [false], 'invoke', 'settings');
	assert.ok(
		worker.frames.filter((frame) => frame.channel === 'SETTINGS_NOTIFY_WINDOW_PRESENCE').at(-1).args[0] === false
	);
	console.log('ok current release speech IPC, SNR bundle worker, and actual window lifecycle');
	await worker.close();
	worker = undefined;
	worker = await start();
	assert.equal((await worker.request('settings:get')).masterVolume, 67);
	assert.equal((await worker.request('settings:get')).myLobbySettings.maxDistance, 5.32);
	console.log('ok restart restores persisted settings only; worker exits when parent pipe closes');
} finally {
	if (worker) await worker.close();
	assert.ok(resolve(data).startsWith(join(resolve(tmpdir()), 'tanuki-tauri-test-')));
	await rm(data, { recursive: true, force: true });
}
