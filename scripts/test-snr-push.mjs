import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const directory = resolve('.cache/snr-push-tests');
await mkdir(directory, { recursive: true });
async function bundle(file) {
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	const output = resolve(directory, file.split('/').at(-1).replace('.ts', '.mjs'));
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { MapType, CameraLocation } = await bundle('src/common/AmongusMap.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const state = {
	mod: 'SUPER_NEW_ROLES',
	gameState: GameState.TASKS,
	map: MapType.SKELD,
	currentCamera: CameraLocation.NONE,
	closedDoors: [],
};
const me = { id: 1, clientId: 101, x: 0, y: 0, isDead: false };
const other = { id: 3, clientId: 103, x: 1, y: 0, isDead: true, snrPushedFalling: true, snrPushOrigin: { x: 1, y: 0 } };
const run = (speaker = other, game = state, listener = me, lobby = {}) =>
	calculateVoiceAudio({
		state: game,
		me: listener,
		other: speaker,
		settings: { enableSpatialAudio: true, ghostVolumeAsImpostor: 20 },
		activeLobbySettings: { ...defaultLobbySettings, haunting: false, ...lobby },
		maxDistance: 5,
		impostorRadioClientId: -1,
	});
assert.equal(run().gain, 1, 'nearby living crew hears a falling victim');
assert.equal(run().reverb, true);
assert.equal(run({ ...other, snrPushedFalling: false }).gain, 0, 'fall completion immediately restores ghost gating');
assert.equal(run({ ...other, snrPushedFalling: undefined }).gain, 0, 'missing samples grant no voice');
assert.equal(run({ ...other, x: 100, snrPushOrigin: { x: 100, y: 0 } }).gain, 0, 'no map-wide fall voice');
assert.deepEqual(run({ ...other, x: 100 }).panPosition, [1, 0], 'ghost movement cannot move the fall voice');
for (const mod of ['NONE', 'NoS', 'TOH4E']) assert.equal(run(other, { ...state, mod }).gain, 0);
for (const gameState of [GameState.DISCUSSION, GameState.MENU, GameState.UNKNOWN])
	assert.equal(run(other, { ...state, gameState }).gain, 0);
assert.equal(run({ ...other, disconnected: true }).gain, 0);
assert.equal(run({ ...other, isDummy: true }).gain, 0);
assert.equal(run(other, state, me, { deadOnly: true }).gain, 0);
assert.equal(run(other, state, me, { meetingGhostOnly: true }).gain, 0);
assert.equal(run(other, { ...state, comsSabotaged: true }, me, { commsSabotage: true }).gain, 0);
assert.equal(
	run({ ...other, snrPushedFalling: false }, state, { ...me, isImpostor: true }, { haunting: true }).gain,
	0.2,
	'existing haunting after the fall stays intact'
);
assert.equal(
	run({ ...other, snrPushedFalling: false }, state, { ...me, isDead: true }).gain,
	1,
	'ghost-to-ghost voice stays intact'
);
assert.equal(
	run({ ...other, snrPushedFalling: false }, state, { ...me, isDead: true, snrPushedFalling: true }).gain,
	0,
	'falling local player does not hear ghosts early'
);
console.log('PASS SNR fall voice: lifetime, reverb, distance, fixed origin, death permissions and other MODs');

const trackerBundle = await build({
	entryPoints: ['src/main/snrPushTracker.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	plugins: [
		{
			name: 'tracker-fixtures',
			setup(builder) {
				builder.onResolve({ filter: /^(electron|node:child_process|node:fs)$/ }, (args) => ({
					path: args.path,
					namespace: 'fixture',
				}));
				builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
					contents:
						args.path === 'electron'
							? 'export const app = { getAppPath: () => "C:/test/app.asar" };'
							: args.path === 'node:fs'
								? 'export const existsSync = () => true;'
								: `import { EventEmitter } from 'node:events';
				export function spawn(executable, args) {
					const child = new EventEmitter(); child.stdout = new EventEmitter();
					child.stdout.setEncoding = () => {}; child.kill = () => { child.killed = true; };
					child.executable = executable; child.args = args;
					globalThis.snrTestWorkers.push(child); return child;
				}`,
				}));
			},
		},
	],
});
const trackerPath = resolve(directory, 'tracker.mjs');
await writeFile(trackerPath, trackerBundle.outputFiles[0].contents);
const { SnrPushTracker } = await import(pathToFileURL(trackerPath));
globalThis.snrTestWorkers = [];
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
try {
	const tracker = new SnrPushTracker();
	tracker.update(123, true);
	const first = globalThis.snrTestWorkers[0];
	assert.match(first.executable, /x64/);
	const send = (child, data) =>
		child.stdout.emit(
			'data',
			JSON.stringify({ pid: 123, available: true, capturedAt: now, playerIds: [3], ...data }) + '\n'
		);
	send(first, {});
	assert.deepEqual(tracker.update(123, true), [3]);
	now += 501;
	assert.deepEqual(tracker.update(123, true), [], 'stalled worker cannot retain fall permission');
	send(first, { pid: 456 });
	assert.deepEqual(tracker.update(123, true), []);
	send(first, { playerIds: [-1, 256] });
	assert.deepEqual(tracker.update(123, true), []);
	send(first, { available: false });
	assert.deepEqual(tracker.update(123, true), []);
	send(first, {});
	tracker.update(456);
	assert.equal(first.killed, true, 'PID switch stops the old reader');
	send(first, {});
	assert.deepEqual(tracker.update(456), [], 'old reader cannot affect a new process');
	tracker.reset();
	assert.equal(globalThis.snrTestWorkers[1].killed, true);
} finally {
	Date.now = realNow;
	delete globalThis.snrTestWorkers;
}
console.log('PASS fall tracker: x64 selection, expiration, malformed samples, PID switch and process cleanup');

for (const args of [
	['publish', 'tools/SnrRoleReader/SnrRoleReader.csproj', '-c', 'Release', '-o', 'out/debug-reader'],
	['publish', 'scripts/fixtures/snr-reader/Host/Host.csproj', '-c', 'Release', '-o', '.cache/snr-reader-test'],
	['build', 'scripts/fixtures/snr-reader/Plugin/Plugin.csproj', '-c', 'Release', '-o', '.cache/snr-reader-test'],
])
	execFileSync('dotnet', args, { windowsHide: true, stdio: 'pipe' });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = spawn(resolve('.cache/snr-reader-test/Among Us.exe'), ['live', resolve(directory, 'ready')], {
	env,
	windowsHide: true,
});
const fixtureLines = createInterface({ input: fixture.stdout });
const output = [];
fixtureLines.on('line', (line) => output.push(line));
let watcher;
let watcherLines;
try {
	await waitFor(() => output.includes('ready'));
	watcher = spawn(
		resolve('out/debug-reader/SnrRoleReader.exe'),
		[String(fixture.pid), '--push-watch', String(process.pid)],
		{ env, windowsHide: true }
	);
	watcherLines = createInterface({ input: watcher.stdout });
	const samples = [];
	watcherLines.on('line', (line) => {
		try {
			samples.push(JSON.parse(line));
		} catch {}
	});
	await waitFor(() => samples.some((s) => s.available && s.playerIds.length === 0));
	const change = async (command) => {
		fixture.stdin.write(command + '\n');
		await waitFor(() => output.includes(command));
		const index = samples.length;
		return index;
	};
	let index = await change('push');
	await waitFor(() => samples.slice(index).some((s) => s.available && s.playerIds.includes(3)));
	index = await change('gc');
	await waitFor(() => samples.slice(index).some((s) => s.available && s.playerIds.includes(3)));
	index = await change('push-end');
	await waitFor(() => samples.slice(index).some((s) => s.available && s.playerIds.length === 0));
	index = await change('clear');
	await waitFor(() => samples.slice(index).some((s) => s.available && s.playerIds.length === 0));
	console.log(
		'PASS live CLR handles: inactive module ignored, fall start, compacting GC, cleared Player and cleared array'
	);
} finally {
	watcher?.kill();
	fixture.kill();
	watcherLines?.close();
	fixtureLines.close();
}
async function waitFor(predicate) {
	const deadline = Date.now() + 15000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for live push sample');
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
