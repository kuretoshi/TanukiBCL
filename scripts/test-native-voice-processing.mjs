// Local device + DSP integration and memory comparison. Main client uses the
// physical default devices (silent output); only game state and remote tone
// are synthetic. No public server or audio recording is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { startFixture, gameState } from './native-voice/fixture-server.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const executable = resolve(
	option('--exe', join(root, `dist-tauri/TanukiBCL-Tauri-Beta-${version}/TanukiBCL-Tauri-Beta.exe`))
);
const pilot = args.includes('--pilot');
const keepUi = args.includes('--keep-ui');
const routing = args.includes('--routing');
const lobbySettings = routing ? { maxDistance: 5.32, wallsBlockAudio: true, visionHearing: true } : undefined;
function inputGame(client) {
	const game = gameState(client);
	if (routing) {
		game.map = 1;
		game.lightRadius = 2;
		game.closedDoors = [];
		game.players.forEach((p, i) => {
			p.x = 6.106;
			p.y = i === 0 ? 2.7 : 3.1;
		});
	}
	return game;
}
assert.ok(!keepUi || pilot, '--keep-ui only applies to a pilot');
const duration = pilot ? 35 : 70;
const stableStart = pilot ? 20 : 35;
const stableEnd = pilot ? 30 : 60;
const modes = pilot ? [true] : [false, true, true, false];
const directory = join(root, '.tools/native-voice-processing', `run-${Date.now()}`);
await mkdir(directory, { recursive: true });
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'TANUKI_RUST_TRACE']) delete env[key];
const owned = new Set();
function launch(file, params, name) {
	const child = spawn(file, params, {
		cwd: dirname(executable),
		env,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	owned.add(child);
	let output = '';
	child.stdout.on('data', (data) => {
		output = (output + data).slice(-20000);
	});
	child.stderr.on('data', (data) => {
		output = (output + data).slice(-20000);
	});
	child.finished = new Promise((done, fail) => {
		child.once('error', fail);
		child.once('exit', async (code) => {
			owned.delete(child);
			await writeFile(join(directory, `${name}.log`), output);
			code === 0 ? done() : fail(new Error(`${name} exited ${code}: ${output.slice(-1500)}`));
		});
	});
	child.finished.catch(() => {});
	return child;
}
const json = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const median = (values) => {
	const s = values.toSorted((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const results = [];
try {
	const diagnosticsPath = join(directory, 'signal-validation.json');
	await launch(executable, ['--voice-processing-probe', '--voice-test-output', diagnosticsPath], 'signal-validation')
		.finished;
	const signals = await json(diagnosticsPath);
	assert.equal(signals.passed, true);
	console.log(
		JSON.stringify({
			event: 'signals-passed',
			noiseReductionDb: signals.noiseReductionDb,
			echoReductionDb: signals.echoReductionDb,
			gainDb: signals.gainDb,
		})
	);
	for (const [index, enabled] of modes.entries()) {
		const label = `voice-processing-${Date.now()}-${enabled ? 'on' : 'off'}-${index + 1}`;
		const server = await startFixture();
		try {
			const config = join(directory, `${label}-main.json`);
			const peerConfig = join(directory, `${label}-peer.json`);
			const output = join(directory, `${label}-result-private.json`);
			const peerOutput = join(directory, `${label}-peer-result-private.json`);
			await writeFile(
				config,
				JSON.stringify({
					serverUrl: server.url,
					game: inputGame(1),
					frequency: 440,
					hardwareAudio: true,
					audioProcessing: enabled,
					lobbySettings,
				})
			);
			await writeFile(
				peerConfig,
				JSON.stringify({ serverUrl: server.url, game: inputGame(2), frequency: 660, lobbySettings })
			);
			const peer = launch(
				executable,
				[
					'--native-voice-probe',
					'--voice-test-config',
					peerConfig,
					'--voice-test-output',
					peerOutput,
					'--voice-test-seconds',
					String(duration + 10),
				],
				`${label}-peer`
			);
			const measure = launch(
				'powershell.exe',
				[
					'-NoProfile',
					'-ExecutionPolicy',
					'Bypass',
					'-File',
					join(root, 'scripts/measure-tauri-memory.ps1'),
					'-Label',
					label,
					'-Executable',
					executable,
					'-DurationSeconds',
					String(duration + 8),
					'-Backend',
					'rust',
					'--native-voice',
					'--voice-test-config',
					config,
					'--voice-test-output',
					output,
					'--voice-test-seconds',
					String(duration),
					...(!keepUi ? ['--voice-test-close-after', '15'] : []),
				],
				`${label}-measure`
			);
			console.log(JSON.stringify({ event: 'started', enabled, label, seconds: duration, directory }));
			await measure.finished;
			await peer.finished;
			const r = await json(output);
			assert.equal(r.preferences.echoCancellation, enabled);
			assert.equal(r.preferences.noiseSuppression, enabled);
			assert.equal(r.preferences.autoGainControl, enabled);
			assert.equal(r.status.error, '');
			assert.equal(r.status.audioReady, true);
			assert.equal(r.status.connected, true);
			assert.equal(r.status.peers, 1);
			assert.ok(!r.status.microphoneName.includes('Synthetic'));
			assert.equal(r.openWebviews, keepUi ? 1 : 0);
			const progress = r.progress.filter((p) => p.second >= stableStart && p.second <= stableEnd);
			assert.ok(progress.length >= stableEnd - stableStart);
			const first = progress[0].metrics;
			const last = progress.at(-1).metrics;
			for (const key of [
				'capturedFrames',
				'processedFrames',
				'renderReferenceFrames',
				'renderedFrames',
				'decodedFrames',
			])
				assert.ok(last[key] > first[key] + 48000, `${key} stopped`);
			for (const key of ['sentPackets', 'receivedPackets']) assert.ok(last[key] > first[key] + 100, `${key} stopped`);
			for (const key of [
				'captureOverruns',
				'referenceOverruns',
				'playbackUnderruns',
				'droppedFrames',
				'concealedPackets',
			])
				assert.equal(last[key], first[key], `${key} grew in steady state`);
			const samples = (await readFile(join(root, '.tools/memory-comparison', `${label}.samples.jsonl`), 'utf8'))
				.replace(/^\uFEFF/, '')
				.trim()
				.split(/\r?\n/)
				.map(JSON.parse)
				.filter((s) => s.elapsedSeconds >= stableStart && s.elapsedSeconds <= stableEnd);
			assert.ok(samples.length >= 4);
			assert.ok(samples.every((s) => s.failedCount === 0 && s.processes.length > 0));
			if (!keepUi) assert.ok(samples.every((s) => s.processes.length === 1 && s.processes[0].kind === 'host'));
			const meanBlockUs =
				(last.processingNanos - first.processingNanos) / (last.processingBlocks - first.processingBlocks) / 1000;
			assert.ok(meanBlockUs < 10000, 'DSP exceeded a 10 ms audio block budget');
			const result = {
				enabled,
				label,
				privateWorkingSetMiB: median(samples.map((s) => s.privateWorkingSetBytes / 1048576)),
				privateCommitMiB: median(samples.map((s) => s.privateBytes / 1048576)),
				processCount: median(samples.map((s) => s.processes.length)),
				sampleCount: samples.length,
				meanProcessingBlockUs: meanBlockUs,
				first,
				last,
				final: r.metrics,
				signaling: server.counters,
				progress: r.progress,
				memorySamples: samples.map(({ elapsedSeconds, privateWorkingSetBytes, privateBytes, workingSetBytes }) => ({
					elapsedSeconds,
					privateWorkingSetBytes,
					privateBytes,
					workingSetBytes,
				})),
			};
			results.push(result);
			await writeFile(join(directory, 'partial-result.json'), JSON.stringify(results, null, 2));
			console.log(
				JSON.stringify({
					event: 'passed',
					enabled,
					privateWorkingSetMiB: result.privateWorkingSetMiB,
					meanProcessingBlockUs: meanBlockUs,
					startupDroppedFrames: r.progress[0].metrics.droppedFrames,
				})
			);
		} finally {
			await server.close();
		}
	}
	const means = Object.fromEntries(
		[false, true].map((enabled) => {
			const r = results.filter((r) => r.enabled === enabled);
			return [enabled ? 'on' : 'off', r.length ? r.reduce((a, b) => a + b.privateWorkingSetMiB, 0) / r.length : null];
		})
	);
	const report = {
		passed: true,
		version,
		pilot,
		keepUi,
		created: new Date().toISOString(),
		executableSha256: createHash('sha256')
			.update(await readFile(executable))
			.digest('hex'),
		method: {
			durationSeconds: duration,
			stableStart,
			stableEnd,
			metric: 'Sum of private working sets of the measured app and descendants, MiB',
			physicalDefaultAudioDevices: true,
			speakerVolume: 0,
			gameStateInjected: true,
			realGame: false,
			remotePeer: 'Local generated tone outside measured process tree',
			publicServerUsed: false,
			audioSaved: false,
			nativeWebviewDestroyedAfterSeconds: keepUi ? null : 15,
			featureOrder: modes,
			nativeRouting: routing ? { wallsBlockAudio: true, visionHearing: true, map: 1, closedDoorCount: 0 } : null,
		},
		signals,
		meanOfRunMediansMiB: means,
		extraMiB: means.on !== null && means.off !== null ? means.on - means.off : null,
		limitations: [
			'Synthetic signals and local transport; human speech quality and room/device echo cancellation need listening tests.',
			'Uses a fixed injected Vanilla game state; not a fresh live-game benchmark or Electron/.NET comparison.',
		],
		runs: results,
	};
	const path = join(directory, 'result.json');
	await writeFile(path, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ event: 'complete', output: path, means, extraMiB: report.extraMiB }));
} finally {
	for (const child of owned) if (child.exitCode === null) child.kill();
}
