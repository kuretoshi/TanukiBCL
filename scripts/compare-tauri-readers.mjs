import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const pid = Number(process.argv[2]),
	phase = process.argv[3];
const executable = resolve(
	process.argv[4] || 'dist-tauri/TanukiBCL-Tauri-Beta-3.2.62-tauri-beta.2/TanukiBCL-Tauri-Beta.exe'
);
const expected = { lobby: 0, tasks: 1, discussion: 2, menu: 3 }[phase];
if (!Number.isInteger(pid) || pid <= 0 || expected === undefined)
	throw new Error('Usage: node scripts/compare-tauri-readers.mjs PID lobby|tasks|discussion|menu [exe]');
const directory = join(root, '.tools/memory-comparison', `rust-parity-${phase}`);
const nodeData = join(directory, 'node'),
	rustData = join(directory, 'rust');
await Promise.all([mkdir(nodeData, { recursive: true }), mkdir(rustData, { recursive: true })]);
const resources = join(root, 'out/tauri-backend');
const env = {
	...process.env,
	NODE_OPTIONS: '',
	NODE_PATH: '',
	BETTERCREWLINK_TARGET_PROCESS: 'Among Us.exe',
	BETTERCREWLINK_TARGET_PID: String(pid),
	TANUKI_TAURI_DATA: nodeData,
};
const worker = spawn(join(resources, 'tanuki-node.exe'), [join(resources, 'backend.mjs')], {
	cwd: resources,
	windowsHide: true,
	env,
	stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map(),
	errors = [];
let sequence = 0,
	readyResolve,
	colors;
const ready = new Promise((resolve) => {
	readyResolve = resolve;
});
worker.stderr.on('data', () => {});
const lines = createInterface({ input: worker.stdout });
lines.on('line', (line) => {
	const frame = JSON.parse(line);
	if (frame.type === 'ready') readyResolve();
	if (frame.channel === 'ERROR' && frame.args?.[0]) errors.push(frame.args[0]);
	if (frame.channel === 'NOTIFY_PLAYERCOLORS_CHANGED') colors = frame.args[0];
	if (frame.type !== 'response') return;
	const request = pending.get(frame.id);
	if (!request) return;
	clearTimeout(request.timer);
	pending.delete(frame.id);
	frame.error ? request.reject(new Error(frame.error)) : request.resolve(frame.value);
});
const request = (channel) =>
	new Promise((resolve, reject) => {
		const id = ++sequence,
			timer = setTimeout(() => reject(new Error('IPC timeout: ' + channel)), 20000);
		pending.set(id, { resolve, reject, timer });
		worker.stdin.write(JSON.stringify({ id, target: 'main', channel, mode: 'invoke', args: [] }) + '\n');
	});
function differences(left, right, path = '') {
	if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object')
		return Object.is(left, right) ? [] : [path];
	return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
		differences(left[key], right[key], path + '/' + key)
	);
}
try {
	await Promise.race([
		ready,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error('Node startup timed out')), 15000);
			timer.unref();
		}),
	]);
	await request('START_HOOK');
	let state;
	for (let index = 0; index < 30; index++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		state = await request('GET_INITIAL_STATE');
		if (state?.gameState === expected && colors) break;
	}
	if (state?.gameState !== expected || !colors || errors.length)
		throw new Error('Release reader did not reach the expected phase.');
	const output = join(directory, 'rust.json');
	const child = spawn(
		executable,
		['--rust-reader-probe', String(pid), '--probe-samples', '3', '--probe-output', output],
		{ cwd: root, windowsHide: true, env: { ...env, TANUKI_TAURI_DATA: rustData }, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-2000);
	});
	const timer = setTimeout(() => child.kill(), 60000);
	const [exitCode] = await once(child, 'exit');
	clearTimeout(timer);
	if (exitCode !== 0) throw new Error('Rust reader failed: ' + stderr);
	const rust = JSON.parse(await readFile(output, 'utf8'));
	state = await request('GET_INITIAL_STATE');
	await writeFile(join(directory, 'node.json'), JSON.stringify({ state, colors }, null, 2) + '\n');
	const actual = rust.states.at(-1);
	for (const snapshot of [state, actual]) {
		snapshot.players.sort((a, b) => a.id - b.id);
		delete snapshot.debug;
	}
	const fields = differences(state, actual);
	const colorDifferences = differences(colors, rust.colors, '/colors');
	const images = [];
	for (const name of ['player', 'ghost'])
		for (let color = 0; color < colors.length; color++) {
			const path = `static/generated/${name}/${color}.png`;
			const [left, right] = await Promise.all([readFile(join(nodeData, path)), readFile(join(rustData, path))]);
			const a = PNG.sync.read(left),
				b = PNG.sync.read(right);
			images.push({
				image: `${name}/${color}`,
				equal: a.width === b.width && a.height === b.height && a.data.equals(b.data),
			});
		}
	const result = {
		phase,
		gamePid: pid,
		gameState: actual.gameState,
		playerCount: actual.players.length,
		checkedPlayerFields: Object.keys(actual.players[0] || {}).length,
		nodeStartedByRust: rust.nodeStarted,
		stateDifferences: fields,
		colorDifferences,
		comparedImages: images.length,
		imageDifferences: images.filter((i) => !i.equal).map((i) => i.image),
		passed: fields.length === 0 && colorDifferences.length === 0 && images.every((i) => i.equal),
	};
	await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
	console.log(JSON.stringify(result));
	if (!result.passed) process.exitCode = 1;
} finally {
	const exited = once(worker, 'exit');
	worker.stdin.end();
	const timer = setTimeout(() => worker.kill(), 4000);
	await exited;
	clearTimeout(timer);
	lines.close();
}
