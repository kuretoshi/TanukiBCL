import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { startFixture, gameState } from './native-voice/fixture-server.mjs';

const root = resolve(import.meta.dirname, '..');
const executable = resolve(
	process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(root, 'src-tauri/target/debug/tanuki-bcl-tauri.exe')
);
const duration = Number(process.env.VOICE_TEST_SECONDS ?? 25);
const nativePeer = process.argv.includes('--native-peer');
const uiSmoke = process.argv.includes('--ui-smoke');
const directory = join(root, '.tools/native-voice-test', `interop-${Date.now()}`);
await mkdir(directory, { recursive: true });
const server = await startFixture({ directory });
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'TANUKI_RUST_TRACE']) delete env[key];
const children = [];
function launch(executable, args) {
	const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child);
	let stderr = '';
	child.stdout.on('data', (data) => (stderr = (stderr + data).slice(-10000)));
	child.stderr.on('data', (data) => (stderr = (stderr + data).slice(-10000)));
	child.finished = new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}: ${stderr}`))));
	});
	return child;
}
try {
	await writeFile(
		join(directory, 'native-peer.json'),
		JSON.stringify({ serverUrl: server.url, game: gameState(2), frequency: 660 })
	);
	await writeFile(
		join(directory, 'native.json'),
		JSON.stringify({ serverUrl: server.url, game: gameState(1), frequency: 440 })
	);
	await build({
		absWorkingDir: root,
		entryPoints: ['scripts/native-voice/browser-peer.ts'],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		outfile: join(directory, 'browser.js'),
	});
	await writeFile(
		join(directory, 'browser.html'),
		'<!doctype html><meta charset="utf-8"><title>Native voice integration fixture</title><script type="module" src="./browser.js"></script>'
	);
	const browser = nativePeer
		? launch(executable, [
				'--native-voice-probe',
				'--voice-test-config',
				join(directory, 'native-peer.json'),
				'--voice-test-output',
				join(directory, 'browser-result.json'),
				'--voice-test-seconds',
				String(duration),
			])
		: undefined;
	const native = launch(executable, [
		...(uiSmoke
			? ['--native-voice']
			: nativePeer
				? ['--native-voice-probe']
				: ['--native-voice', '--headless', '--voice-browser-fixture', `${server.url}/browser.html`]),
		'--voice-test-config',
		join(directory, 'native.json'),
		'--voice-test-output',
		join(directory, 'native-result.json'),
		'--voice-test-seconds',
		String(duration),
	]);
	const deadline = new Promise((_, reject) => {
		const timer = setTimeout(() => reject(new Error('Voice integration timed out')), (duration + 20) * 1000);
		timer.unref();
	});
	await Promise.race([Promise.all([native.finished, browser?.finished]), deadline]);
	const nativeResult = JSON.parse(await readFile(join(directory, 'native-result.json'), 'utf8'));
	const browserResult = JSON.parse(await readFile(join(directory, 'browser-result.json'), 'utf8'));
	assert.equal(nativeResult.status.error, '', JSON.stringify(nativeResult));
	assert.ok(nativeResult.metrics.sentPackets > 100, JSON.stringify(nativeResult));
	assert.ok(nativeResult.metrics.receivedPackets > 100, JSON.stringify(nativeResult));
	assert.ok(nativeResult.metrics.decodedFrames > 48000, JSON.stringify(nativeResult));
	assert.ok(nativeResult.metrics.outputEnergy > 10000, JSON.stringify(nativeResult));
	if (nativePeer) {
		assert.ok(
			browserResult.metrics.sentPackets > 100 && browserResult.metrics.receivedPackets > 100,
			JSON.stringify(browserResult)
		);
		assert.ok(browserResult.metrics.outputEnergy > 10000, JSON.stringify(browserResult));
	} else {
		assert.ok(browserResult.packetsReceived > 100 && browserResult.packetsSent > 100, JSON.stringify(browserResult));
		assert.ok(browserResult.pcmEnergy > 1, JSON.stringify(browserResult));
		assert.ok(browserResult.dataMessages > 0, 'Data channel version/settings were not received');
	}
	const result = {
		passed: true,
		peerKind: nativePeer ? 'rust' : 'webview2',
		executable,
		native: nativeResult,
		chromium: browserResult,
		signaling: server.counters,
		limitations: ['Local synthetic tones only; no physical microphone, speaker, game or public server is involved.'],
	};
	await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
	console.log(
		JSON.stringify({
			passed: true,
			sentPackets: nativeResult.metrics.sentPackets,
			receivedPackets: nativeResult.metrics.receivedPackets,
			decodedFrames: nativeResult.metrics.decodedFrames,
			chromiumPcmEnergy: browserResult.pcmEnergy,
			report: join(directory, 'result.json'),
		})
	);
} finally {
	for (const child of children) if (child.exitCode === null) child.kill();
	await server.close();
}
