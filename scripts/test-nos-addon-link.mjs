import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const fixture = process.argv[2] ?? process.env.TANUKI_ADDON_FIXTURE;
assert(fixture, 'Pass the built NoS tests/AddonLink/AddonLinkTests.dll path.');
const directory = await mkdtemp(join(tmpdir(), 'tbcl-addon-link-'));
const children = [],
	clients = [];
const oldLocal = process.env.LOCALAPPDATA;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, tick = () => {}) {
	const deadline = Date.now() + 5000;
	while (!test()) {
		assert(Date.now() < deadline, 'Timed out waiting for addon link');
		tick();
		await delay(20);
	}
}
async function load(entry, name) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	const path = join(directory, name + '.mjs');
	await writeFile(path, result.outputFiles[0].contents);
	return import(pathToFileURL(path));
}
async function server() {
	const child = spawn('dotnet', [fixture, '--server'], { stdio: ['pipe', 'pipe', 'inherit'] });
	children.push(child);
	const messages = [];
	createInterface({ input: child.stdout }).on('line', (line) => messages.push(JSON.parse(line)));
	await until(() => messages.length > 0);
	const metadata = messages.shift();
	return { ...metadata, messages, child, state: (channels) => child.stdin.write(JSON.stringify({ channels }) + '\n') };
}
function channels(now = Date.now()) {
	return {
		heroes: [{ playerId: 1, kind: 'super' }],
		portable: [{ playerId: 1, extraRange: 4.5 }],
		megaphones: [{ playerId: 2, energy: 0.5, range: 7, voiceEffect: true, shotId: 3, phase: 'charging' }],
		dying: [{ playerId: 3, started: now - 1000, seconds: 5, range: 3, x: -2, y: 4, loop: true }],
		interviews: [{ playerId: 4, started: now - 1000, seconds: 10, stopped: 0, visible: [1, 4], playStarted: 0 }],
		jamming: [{ playerId: 2, muted: false, lowpass: true, pitch: 1.2 }],
		echoes: [{ playerId: 5, unixMs: now }],
		muted: [6],
		speech: [
			{ playerId: 1, kind: 'hero', request: 7, expires: now + 5000, words: ['変身'] },
			{ playerId: 1, kind: 'ng', request: 8, expires: now + 5000, words: ['タスク'] },
		],
	};
}
try {
	const wire = await load('src/common/AddonLink.ts', 'wire');
	const { NosAddonLink } = await load('src/main/nosAddonLink.ts', 'client');
	const now = Date.now(),
		c = channels(now);
	const base = {
		kind: 'state',
		protocol: 1,
		pid: 42,
		session: 'a'.repeat(32),
		sequence: 1,
		unixMs: now,
		phase: 'tasks',
		localPlayer: 1,
		host: true,
		channels: c,
	};
	const valid = (p) => wire.validAddonProfile(p, 42, base.session, 0, now);
	assert(valid(base));
	assert(!valid({ ...base, pid: 43 }));
	assert(!valid({ ...base, session: 'b'.repeat(32) }));
	assert(!valid({ ...base, unixMs: now - 701 }));
	assert(!valid({ ...base, unixMs: now + 101 }));
	assert(!wire.validAddonProfile(base, 42, base.session, 1, now));
	for (const key of Object.keys(c)) {
		const missing = { ...c };
		delete missing[key];
		assert(!valid({ ...base, channels: missing }), `partial ${key} profile rejected`);
		assert(!valid({ ...base, channels: { ...c, [key]: [...c[key], c[key][0]] } }), `duplicate ${key} rejected`);
	}
	assert(!valid({ ...base, channels: { ...c, speech: [{ playerId: 1, kind: 'hero' }] } }));
	assert(!valid({ ...base, channels: { ...c, dying: [{ ...c.dying[0], x: Infinity }] } }));
	assert.equal(wire.addonLinkPort(0x54420000 | 12345), 12345);
	assert.equal(wire.addonLinkPort(0x54420000), undefined);
	const a = await server(),
		b = await server();
	a.state(c);
	b.state({ ...c, heroes: [{ playerId: 1, kind: 'evil' }] });
	const first = new NosAddonLink(),
		second = new NosAddonLink();
	const tick = () => {
		first.update(a.pid, 'round1', 0x54420000 | a.port, 'tasks', 1);
		second.update(b.pid, 'round1', 0x54420000 | b.port, 'tasks', 1);
	};
	await until(
		() => first.current(a.pid)?.channels.heroes.length && second.current(b.pid)?.channels.heroes.length,
		tick
	);
	assert.equal(first.current(a.pid).channels.heroes[0].kind, 'super');
	assert.equal(second.current(b.pid).channels.heroes[0].kind, 'evil');
	assert.equal(first.current(b.pid), undefined);
	assert(!first.sendCommand(b.pid, 'ready', { players: [1] }));
	assert(first.sendCommand(a.pid, 'sample', { playerId: 1, rms: 0.5, active: true, host: false, version: 'test' }));
	assert(first.sendCommand(a.pid, 'ready', { players: [1] }));
	assert(first.sendCommand(a.pid, 'word', { playerId: 1, request: 7, speechKind: 'hero' }));
	await until(() => a.messages.filter((m) => m.command).length >= 3, tick);
	assert.deepEqual(
		a.messages.filter((m) => m.command).map((m) => m.command.kind),
		['sample', 'ready', 'word']
	);
	assert.equal(b.messages.filter((m) => m.command).length, 0);
	const empty = Object.fromEntries(Object.keys(c).map((key) => [key, []]));
	a.state(empty);
	await until(() => first.current(a.pid)?.channels.heroes.length === 0, tick);
	assert.deepEqual(first.current(a.pid).channels, empty, 'explicit empty state clears every channel');
	a.state({ ...empty, speech: [{ bad: true }] });
	await until(() => first.current(a.pid) === undefined, tick);
	assert(!first.sendCommand(a.pid, 'ready', { players: [1] }), 'invalid state stops commands and acknowledgement');
	first.close();
	a.state(c);
	const folder = join(directory, 'TanukiBCL', 'NoS');
	await mkdir(folder, { recursive: true });
	process.env.LOCALAPPDATA = directory;
	await writeFile(
		join(folder, `addon-link-${a.pid}.json`),
		JSON.stringify({ protocol: 1, pid: a.pid, port: b.port, unixMs: Date.now() })
	);
	await until(() => first.current(a.pid), tick);
	assert.equal(first.endpoint(), a.port, 'memory endpoint takes priority over wrong descriptor');
	first.close();
	await writeFile(
		join(folder, `addon-link-${a.pid}.json`),
		JSON.stringify({ protocol: 1, pid: a.pid, port: a.port, unixMs: Date.now() })
	);
	const oldNosTick = () => first.update(a.pid, 'old-nos', undefined, 'tasks', 1);
	await until(() => first.current(a.pid), oldNosTick);
	assert.equal(first.current(a.pid).session, a.session, 'single descriptor supports old NoS');
	first.close();
	first.update(a.pid, 'wrong-endpoint', 0x54420000 | b.port, 'tasks', 1);
	await delay(200);
	assert.equal(first.current(a.pid), undefined, 'other game handshake cannot attach');
	first.close();
	console.log(
		'PASS complete role profiles, strict validation, two actual addon servers, PID isolation, sample/ready/word replies, empty clears, stale fallback and endpoint discovery'
	);
} finally {
	clients.forEach((c) => c.close());
	children.forEach((c) => {
		c.stdin.end();
		c.kill();
	});
	if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = oldLocal;
	await rm(directory, { recursive: true, force: true });
}
