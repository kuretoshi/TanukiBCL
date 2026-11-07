// Requires an already-started, private Vanilla match. The measured client reads
// the real game and opens the default Windows audio devices. Only its remote
// peer is synthetic; signaling and audio stay on this PC, and PCM is not saved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { startFixture } from './native-voice/fixture-server.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const executable = resolve(
	option('--exe', join(root, `dist-tauri/TanukiBCL-Tauri-Beta-${version}/TanukiBCL-Tauri-Beta.exe`))
);
const gamePid = Number(option('--game-pid', '0'));
assert.ok(Number.isSafeInteger(gamePid) && gamePid > 0, 'Supply --game-pid for your private Vanilla match');
const pilot = args.includes('--pilot');
const selection = option('--mode', 'both');
assert.ok(['both', 'native', 'web'].includes(selection));
const modes = selection === 'both' ? (pilot ? ['native', 'web'] : ['web', 'native', 'native', 'web']) : [selection];
const duration = pilot ? 35 : 100;
const stableStart = pilot ? 20 : 60;
const stableEnd = pilot ? 30 : 90;
const directory = join(root, '.tools/native-voice-live-game', `live-${Date.now()}`);
await mkdir(directory, { recursive: true });
const env = { ...process.env, TANUKI_TAURI_DATA: join(directory, 'reader-cache') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'TANUKI_RUST_TRACE']) delete env[key];
const owned = new Set();
function launch(file, parameters, log) {
	const child = spawn(file, parameters, {
		cwd: dirname(executable),
		env,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	owned.add(child);
	let output = '';
	child.stdout.on('data', (data) => {
		output = (output + data).slice(-40000);
	});
	child.stderr.on('data', (data) => {
		output = (output + data).slice(-40000);
	});
	child.finished = new Promise((done, fail) => {
		child.once('error', fail);
		child.once('exit', async (code) => {
			owned.delete(child);
			await writeFile(join(directory, `${log}.log`), output);
			code === 0 ? done() : fail(new Error(`${log} exited ${code}: ${output.slice(-2000)}`));
		});
	});
	// Avoid an unhandled rejection if another child fails before it is awaited.
	child.finished.catch(() => {});
	return child;
}
const json = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const median = (values) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted.length % 2
		? sorted[(sorted.length - 1) / 2]
		: (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const mib = (n) => n / 1048576;
const results = [];
try {
	const statePath = join(directory, 'private-game-input.json');
	await launch(
		executable,
		['--rust-reader-probe', String(gamePid), '--probe-samples', '1', '--probe-output', statePath],
		'reader'
	).finished;
	const game = (await json(statePath)).states[0];
	assert.equal(game.mod, 'NONE');
	assert.equal(game.gameState, 1, 'Start the real match and finish spawn selection first');
	assert.equal(game.isHost, true, 'Measure the local host so both clients use identical lobby rules');
	const local = game.players.find((p) => p.isLocal);
	const remote = game.players
		.filter((p) => !p.isLocal && !p.isDead && !p.disconnected)
		.toSorted((a, b) => Math.hypot(a.x - local.x, a.y - local.y) - Math.hypot(b.x - local.x, b.y - local.y))[0];
	assert.ok(remote && Math.hypot(remote.x - local.x, remote.y - local.y) < 5.32, 'Keep a second player near the host');
	for (const [index, mode] of modes.entries()) {
		const label = `live-voice-${Date.now()}-${mode}-${index + 1}`;
		const server = await startFixture({ room: game.lobbyCode, hostClientId: game.hostId });
		try {
			const remoteGame = structuredClone(game);
			remoteGame.clientId = remote.clientId;
			remoteGame.isHost = false;
			for (const player of remoteGame.players) player.isLocal = player.clientId === remote.clientId;
			const peerConfig = join(directory, `${label}-private-peer.json`);
			const peerOutput = join(directory, `${label}-peer-result.json`);
			const labConfig = join(directory, `${label}-lab.json`);
			const labOutput = join(directory, `${label}-result.json`);
			await writeFile(peerConfig, JSON.stringify({ serverUrl: server.url, game: remoteGame, frequency: 660 }));
			await writeFile(
				labConfig,
				JSON.stringify({
					serverUrl: server.url,
					output: labOutput,
					durationSeconds: duration,
					closeAfterSeconds: mode === 'native' ? 15 : null,
				})
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
			const measurement = launch(
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
					'-GameProcessId',
					String(gamePid),
					'-Backend',
					'rust',
					...(mode === 'native' ? ['--native-voice'] : ['--web-voice']),
					'--voice-lab-config',
					labConfig,
				],
				`${label}-measure`
			);
			console.log(
				JSON.stringify({ event: 'started', mode, label, measurementPid: measurement.pid, seconds: duration, directory })
			);
			await measurement.finished;
			await peer.finished;
			const lab = await json(labOutput);
			const stableVoice = lab.progress.filter((p) => p.second >= stableStart && p.second <= stableEnd);
			assert.ok(stableVoice.length >= stableEnd - stableStart, 'Missing steady-state voice observations');
			for (const p of stableVoice) {
				assert.equal(p.game?.gameState, 1, `Game left TASKS at ${p.second}`);
				assert.equal(p.game.players, game.players.length);
				assert.equal(p.game.localPlayer, true);
				assert.equal(p.voice?.engine, mode === 'native' ? 'native' : 'web');
				assert.equal(p.voice.connected, true, `Disconnected at ${p.second}`);
				assert.equal(p.voice.audioReady, true, `Audio not ready at ${p.second}`);
				assert.equal(p.voice.hasError, false, `Audio error at ${p.second}`);
				assert.equal(p.voice.peers, 1, `Missing peer at ${p.second}`);
				assert.equal(p.voice.muted, false);
				assert.equal(p.voice.deafened, false);
				assert.equal(p.openWebviews, mode === 'native' ? 0 : 1);
			}
			const first = stableVoice[0].voice.metrics;
			const last = stableVoice.at(-1).voice.metrics;
			assert.ok(last.sentPackets > first.sentPackets + 100, 'Sending stopped');
			assert.ok(last.receivedPackets > first.receivedPackets + 100, 'Receiving stopped');
			if (mode === 'native') {
				assert.ok(last.capturedFrames > first.capturedFrames + 48000, 'Microphone capture stopped');
				assert.ok(last.renderedFrames > first.renderedFrames + 48000, 'Hardware rendering stopped');
				assert.ok(last.decodedFrames > first.decodedFrames + 48000, 'Decoder stopped');
				assert.equal(last.droppedFrames, first.droppedFrames, 'Audio frames were dropped during the stable interval');
				assert.equal(
					last.concealedPackets,
					first.concealedPackets,
					'RTP loss was concealed during the stable interval'
				);
			}
			const samples = (await readFile(join(root, '.tools/memory-comparison', `${label}.samples.jsonl`), 'utf8'))
				.replace(/^\uFEFF/, '')
				.trim()
				.split(/\r?\n/)
				.map(JSON.parse)
				.filter((s) => s.elapsedSeconds >= stableStart && s.elapsedSeconds <= stableEnd);
			assert.ok(samples.length >= (pilot ? 3 : 10));
			assert.ok(samples.every((s) => s.failedCount === 0 && s.processes.length > 0));
			if (mode === 'native')
				assert.ok(
					samples.every((s) => s.processes.length === 1 && s.processes[0].kind === 'host'),
					'WebView survived background transition'
				);
			const result = {
				mode,
				label,
				stableStart,
				stableEnd,
				sampleCount: samples.length,
				privateWorkingSetMiB: median(samples.map((s) => mib(s.privateWorkingSetBytes))),
				privateCommitMiB: median(samples.map((s) => mib(s.privateBytes))),
				workingSetMiB: median(samples.map((s) => mib(s.workingSetBytes))),
				processCount: median(samples.map((s) => s.processes.length)),
				voiceFirst: first,
				voiceLast: last,
				signaling: server.counters,
				peerMetrics: (await json(peerOutput)).metrics,
				game: stableVoice.at(-1).game,
				progress: lab.progress,
				memorySamples: samples.map(
					({ elapsedSeconds, privateWorkingSetBytes, privateBytes, workingSetBytes, processes }) => ({
						elapsedSeconds,
						privateWorkingSetBytes,
						privateBytes,
						workingSetBytes,
						processes: processes.map(({ kind, privateWorkingSetBytes, privateBytes, workingSetBytes }) => ({
							kind,
							privateWorkingSetBytes,
							privateBytes,
							workingSetBytes,
						})),
					})
				),
			};
			results.push(result);
			await writeFile(join(directory, 'partial-result.json'), JSON.stringify(results, null, 2));
			console.log(
				JSON.stringify({
					event: 'passed',
					mode,
					privateWorkingSetMiB: result.privateWorkingSetMiB,
					privateCommitMiB: result.privateCommitMiB,
					processCount: result.processCount,
				})
			);
		} finally {
			await server.close();
		}
	}
	const means = Object.fromEntries(
		['web', 'native'].map((mode) => {
			const runs = results.filter((r) => r.mode === mode);
			return [mode, runs.length ? runs.reduce((sum, r) => sum + r.privateWorkingSetMiB, 0) / runs.length : null];
		})
	);
	const report = {
		passed: true,
		version,
		created: new Date().toISOString(),
		pilot,
		executableSha256: createHash('sha256')
			.update(await readFile(executable))
			.digest('hex'),
		method: {
			metric: 'Sum of private working sets in the measured application process tree, MiB',
			durationSeconds: duration,
			stableStart,
			stableEnd,
			order: modes,
			realGame: true,
			injectedGameInMeasuredClient: false,
			gamePlayers: game.players.length,
			voicePeers: 1,
			hardwareAudio: true,
			signaling: 'loopback Socket.IO',
			remotePeer: 'Synthetic Rust peer with a generated tone, outside the measured process tree',
			audioSaved: false,
			speakerVolume: 0,
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
			gameAndServerAndPeerExcluded: true,
		},
		meanOfRunMediansMiB: means,
		reductionPercent: means.web && means.native ? (1 - means.native / means.web) * 100 : null,
		limitations: [
			'A stationary four-player Vanilla Airship match with one voice peer; not a human multi-user call.',
			'Speaker output was muted; actual audible quality was not assessed.',
			'No public signaling server, Internet TURN connection, Mod or long-duration stability test.',
		],
		runs: results,
	};
	const output = join(directory, 'result.json');
	await writeFile(output, JSON.stringify(report, null, 2));
	console.log(JSON.stringify({ event: 'complete', output, means, reductionPercent: report.reductionPercent }));
} finally {
	for (const child of owned) if (child.exitCode === null) child.kill();
}
