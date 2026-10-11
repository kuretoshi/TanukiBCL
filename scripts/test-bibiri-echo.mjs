import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-bibiri-echo-'));
try {
	async function bundle(entry) {
		const result = await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', write: false });
		const path = join(directory, entry.split('/').at(-1).replace('.ts', '.mjs'));
		await writeFile(path, result.outputFiles[0].contents);
		return import(pathToFileURL(path));
	}
	const { readBibiriEchoState } = await bundle('src/main/bibiriEchoState.ts');
	const { createBibiriEcho, updateBibiriEcho, stopBibiriEcho } = await bundle('src/renderer/voice/bibiriEcho.ts');
	const file = join(directory, 'state.json');
	const now = Date.now();
	const snapshot = { protocol: 1, pid: 123, players: [{ playerId: 2, unixMs: now }] };
	await writeFile(file, JSON.stringify(snapshot));
	assert.deepEqual(readBibiriEchoState(123, now, file), snapshot.players);
	assert.deepEqual(readBibiriEchoState(456, now, file), []);
	assert.deepEqual(readBibiriEchoState(123, now + 3001, file), []);
	await writeFile(file, JSON.stringify({ ...snapshot, players: [...snapshot.players, ...snapshot.players] }));
	assert.deepEqual(readBibiriEchoState(123, now, file), []);
	await writeFile(file, '{');
	assert.deepEqual(readBibiriEchoState(123, now, file), []);
	const context = { currentTime: 10, createGain: node, createDelay: node };
	function node() {
		const param = () => ({ value: 0, calls: [], cancelScheduledValues() {},
			setValueAtTime(value, time) { this.calls.push([value, time]); },
			exponentialRampToValueAtTime(value, time) { this.calls.push([value, time]); } });
		return { context, gain: param(), delayTime: param(), connect() {}, disconnect() {} };
	}
	const echo = createBibiriEcho(context, node(), node());
	updateBibiriEcho(echo, true, true, now, now); // Joining after the death must not play.
	assert.equal(echo.until, 0);
	updateBibiriEcho(echo, true, false, undefined, now);
	assert.equal(echo.input.gain.value, 1);
	updateBibiriEcho(echo, true, true, undefined, now); // Ordinary deaths have no echo event.
	assert.equal(echo.until, 0);
	updateBibiriEcho(echo, true, true, now, now); // RPC can arrive after the dead state.
	assert.equal(echo.until, 12.4);
	assert.equal(echo.input.gain.value, 0); // No new ghost speech enters the tail.
	assert.deepEqual(echo.output.gain.calls.slice(-3), [[0.65, 10], [0.001, 12.4], [0, 12.4]]);
	context.currentTime = 10.1;
	updateBibiriEcho(echo, true, true, now, now + 100);
	assert.equal(echo.until, 12.4); // Repeated snapshots cannot restart it.
	stopBibiriEcho(echo);
	assert.equal(echo.until, 0);
	updateBibiriEcho(echo, false, true, now, now);
	assert.equal(echo.wasAlive, false);
	console.log('Bibiri echo: validated events, delayed RPC, one-shot fading, ghost-input cutoff and mute/reset checks passed.');
} finally { await rm(directory, { recursive: true, force: true }); }
