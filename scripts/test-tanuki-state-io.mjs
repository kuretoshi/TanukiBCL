import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const io = { files: new Map(), opens: [], sync: 0, active: 0, maxActive: 0, reads: 0 };
globalThis.roleStateIo = io;
const output = await build({
	stdin: {
		contents:
			"export {readTanukiAddonState} from './src/main/tanukiAddonState'; export {GameState} from './src/common/AmongUsState';",
		resolveDir: process.cwd(),
	},
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
	plugins: [
		{
			name: 'role-state-io',
			setup(b) {
				b.onResolve({ filter: /^node:fs(\/promises)?$/ }, ({ path }) => ({ path, namespace: 'mock' }));
				b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
					contents:
						path === 'node:fs'
							? `
			export function existsSync(){globalThis.roleStateIo.sync++;throw new Error('synchronous I/O');}
			export function statSync(){globalThis.roleStateIo.sync++;throw new Error('synchronous I/O');}
			export function readFileSync(){globalThis.roleStateIo.sync++;throw new Error('synchronous I/O');}
		`
							: `export async function open(path){
			const io=globalThis.roleStateIo,name=path.split(/[\\\\/]/).at(-1),file=io.files.get(name);io.opens.push(name);
			if(!file)throw Object.assign(new Error('missing'),{code:'ENOENT'});
			const data=Buffer.from(file.text);io.active++;io.maxActive=Math.max(io.maxActive,io.active);
			return {
				async stat(){return {size:file.size??data.length};},
				async read(buffer,offset,length,position){
					io.reads++;if(file.gate)await file.gate;
					if(file.fail)throw new Error('read failed');
					const count=Math.max(0,Math.min(length,data.length-position,file.chunk??Infinity));
					data.copy(buffer,offset,position,position+count);return {bytesRead:count};
				},
				async close(){io.active--;}
			};
		}`,
				}));
				if (process.env.TANUKI_STATE_IO_BASELINE)
					b.onLoad({ filter: /tanukiAddonState\.ts$/ }, async ({ path }) => ({
						contents: await readFile(process.env.TANUKI_STATE_IO_BASELINE, 'utf8'),
						loader: 'ts',
						resolveDir: dirname(path),
					}));
			},
		},
	],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(
	createRequire(import.meta.url),
	mod,
	mod.exports
);
const { readTanukiAddonState, GameState } = mod.exports;
const realNow = Date.now,
	oldAppData = process.env.LOCALAPPDATA;
let now = 10000;
Date.now = () => now;
process.env.LOCALAPPDATA = 'C:\\tanuki-state-test';
const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: GameState.TASKS };
const entries = {
	'bibiri-echo.json': [{ playerId: 1, unixMs: 10000 }],
	'megaphone-state-123.json': [{ playerId: 1, energy: 0.5, range: 10 }],
	'interviews-123.json': [{ playerId: 1, started: 9900, seconds: 3, stopped: 0, visible: [1], playStarted: 0 }],
	'voice-jamming-123.json': [{ playerId: 1, muted: true, lowpass: false, pitch: 1.1 }],
	'hero-transforms-123.json': [{ playerId: 1, kind: 'super' }],
	'dying-voice-123.json': [{ playerId: 1, started: 9900, seconds: 3, range: 2, x: 0, y: 0 }],
	'portable-megaphone.json': [{ playerId: 1, extraRange: 5 }],
};
function reset(pid = 123) {
	io.files.clear();
	io.opens.length = 0;
	io.maxActive = 0;
	now = 10000;
	for (const [file, players] of Object.entries(entries))
		io.files.set(file, { text: JSON.stringify({ protocol: 1, pid, unixMs: 10000, players }) });
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function verifyRealFiles() {
	const folder = await mkdtemp(join(tmpdir(), 'tanuki-async-state-'));
	const result = await build({
		entryPoints: ['src/main/tanukiAddonState.ts'],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		write: false,
	});
	const live = { exports: {} };
	new Function('require', 'module', 'exports', result.outputFiles[0].text)(
		createRequire(import.meta.url),
		live,
		live.exports
	);
	try {
		process.env.LOCALAPPDATA = folder;
		const root = join(folder, 'TanukiBCL', 'NoS');
		await mkdir(root, { recursive: true });
		await Promise.all(
			Object.entries(entries).map(([file, players]) =>
				writeFile(join(root, file), JSON.stringify({ protocol: 1, pid: 123, unixMs: 10000, players }))
			)
		);
		const actual = await live.exports.readTanukiAddonState(123, state);
		assert.deepEqual(actual.nosHeroTransforms, entries['hero-transforms-123.json']);
		assert.deepEqual(actual.nosMegaphones, entries['megaphone-state-123.json']);
		assert.deepEqual(actual.nosInterviews, entries['interviews-123.json']);
		await writeFile(join(root, 'hero-transforms-123.json'), ' '.repeat(8193));
		assert.deepEqual((await live.exports.readTanukiAddonState(123, state)).nosHeroTransforms, []);
	} finally {
		assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep + 'tanuki-async-state-'));
		await rm(folder, { recursive: true, force: true });
	}
}
try {
	reset();
	assert.deepEqual(await readTanukiAddonState(123, { ...state, nosAddonIds: [] }), {});
	assert.ok(
		Object.values(await readTanukiAddonState(123, { ...state, gameState: GameState.LOBBY })).every(
			(v) => v === undefined
		)
	);
	assert.equal(io.opens.length, 0);
	assert.equal(io.sync, 0);
	const first = await readTanukiAddonState(123, state);
	assert.equal(io.sync, 0, 'active state reads must never use synchronous fs APIs');
	assert.equal(io.opens.length, 6);
	assert.equal(io.maxActive, 6, 'read independent role files concurrently');
	assert.deepEqual(first.nosHeroTransforms, entries['hero-transforms-123.json']);
	assert.deepEqual(first.nosMegaphones, entries['megaphone-state-123.json']);
	assert.deepEqual(first.nosInterviews, entries['interviews-123.json']);
	assert.equal(first.nosVoiceJamming, undefined);
	reset();
	const meeting = await readTanukiAddonState(123, { ...state, gameState: GameState.DISCUSSION });
	assert.equal(io.opens.length, 4);
	assert.deepEqual(meeting.nosVoiceJamming, entries['voice-jamming-123.json']);
	assert.equal(meeting.nosMegaphones, undefined);
	assert.equal(meeting.nosHeroTransforms, undefined);
	reset();
	let finish;
	io.files.get('hero-transforms-123.json').gate = new Promise((resolve) => {
		finish = resolve;
	});
	const delayed = readTanukiAddonState(123, state);
	await tick();
	now = 10600;
	finish();
	const afterDelay = await delayed;
	assert.deepEqual(afterDelay.nosMegaphones, [], '500ms heartbeat expires while another read is pending');
	assert.deepEqual(afterDelay.nosPortableMegaphones, []);
	assert.equal(afterDelay.nosHeroTransforms.length, 1, '1000ms heartbeat remains valid');
	reset();
	now = 11001;
	const expired = await readTanukiAddonState(123, state);
	assert.deepEqual(expired.nosHeroTransforms, []);
	assert.deepEqual(expired.nosInterviews, []);
	assert.deepEqual(expired.nosDyingVoices, []);
	assert.equal(expired.nosBibiriEchoes.length, 1);
	reset(456);
	const wrongPid = await readTanukiAddonState(123, state);
	assert.ok(Object.values(wrongPid).every((value) => value === undefined || value.length === 0));
	reset();
	io.files.get('hero-transforms-123.json').size = 8193;
	io.files.get('interviews-123.json').text = '{';
	io.files.get('dying-voice-123.json').fail = true;
	io.files.get('portable-megaphone.json').chunk = 7;
	const bad = await readTanukiAddonState(123, state);
	assert.deepEqual(bad.nosHeroTransforms, []);
	assert.deepEqual(bad.nosInterviews, []);
	assert.deepEqual(bad.nosDyingVoices, []);
	assert.equal(bad.nosPortableMegaphones.length, 1);
	assert.equal(io.active, 0, 'close every file, including size and I/O failures');
	reset();
	const grown = io.files.get('hero-transforms-123.json');
	grown.size = Buffer.byteLength(grown.text) - 1;
	assert.deepEqual((await readTanukiAddonState(123, state)).nosHeroTransforms, [], 'reject files growing during read');
	reset();
	io.files.set('megaphone-state.json', io.files.get('megaphone-state-123.json'));
	io.files.delete('megaphone-state-123.json');
	assert.equal((await readTanukiAddonState(123, state)).nosMegaphones.length, 1, 'legacy filename fallback');
	io.files.set('megaphone-state-123.json', { text: '{' });
	assert.deepEqual(
		(await readTanukiAddonState(123, state)).nosMegaphones,
		[],
		'invalid per-PID data must not fall back'
	);
	reset();
	const slow = io.files.get('interviews-123.json');
	slow.gate = new Promise((resolve) => {
		finish = resolve;
	});
	const timedOut = await readTanukiAddonState(123, state);
	assert.deepEqual(timedOut.nosInterviews, []);
	assert.equal(timedOut.nosHeroTransforms.length, 1);
	await readTanukiAddonState(123, state);
	assert.equal(io.opens.filter((file) => file === 'interviews-123.json').length, 1, 'deduplicate pending slow I/O');
	now = 11400;
	finish();
	await tick();
	assert.deepEqual(timedOut.nosInterviews, [], 'late reads cannot mutate a published frame');
	assert.deepEqual(
		(await readTanukiAddonState(123, state)).nosInterviews,
		[],
		'late stale data cannot reactivate effects'
	);
	reset();
	io.files.get('hero-transforms-123.json').gate = new Promise((resolve) => {
		finish = resolve;
	});
	const disappearing = { ...state };
	const pending = readTanukiAddonState(123, disappearing);
	await tick();
	disappearing.nosAddonIds = [];
	finish();
	assert.deepEqual(await pending, {}, 'discard a read after addon detection is lost');
	delete process.env.LOCALAPPDATA;
	io.opens.length = 0;
	assert.deepEqual(await readTanukiAddonState(123, state), {});
	assert.equal(io.opens.length, 0);
	now = 10000;
	await verifyRealFiles();
	console.log(
		'PASS role-state async I/O: zero sync probes, parallel reads, freshness at completion, phase/PID/limits, legacy fallback, bounded waits and late-read isolation'
	);
} finally {
	Date.now = realNow;
	if (oldAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = oldAppData;
	delete globalThis.roleStateIo;
}
