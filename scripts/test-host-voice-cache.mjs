import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const io = { reads: 0, stats: 0, sockets: [], revision: 1, fail: false, invalid: false, mutate: false };
globalThis.hostCacheIo = io;
const output = await build({
	entryPoints: ['src/main/nosHostVoiceRelay.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
	plugins: [
		{
			name: 'host-cache-io',
			setup(b) {
				b.onResolve({ filter: /^node:(fs|dgram)$/ }, ({ path }) => ({ path, namespace: 'mock' }));
				b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
					contents:
						path === 'node:fs'
							? `
			export function statSync() {
				const io=globalThis.hostCacheIo; io.stats++; if(io.fail) throw new Error('unavailable');
				return {size:100,mtimeNs:io.revision,ctimeNs:io.revision,dev:1,ino:1};
			}
			export function readFileSync() {
				const io=globalThis.hostCacheIo; io.reads++; if(io.fail) throw new Error('unavailable');
				if(io.invalid) return '{';
				const descriptor={protocol:1,pid:io.pid??123,port:io.port??23456,token:io.token??'a'.repeat(32),reportVersion:io.reportVersion};
				if(io.mutate) io.revision++;
				return JSON.stringify(descriptor);
			}`
							: `export function createSocket(){
				const socket={packets:[],closed:false,on(){return this;},unref(){},close(){this.closed=true;},send(...args){this.packets.push(args);}};
				globalThis.hostCacheIo.sockets.push(socket);return socket;
			}`,
				}));
				if (process.env.TANUKI_HOST_RELAY_BASELINE)
					b.onLoad({ filter: /nosHostVoiceRelay\.ts$/ }, async ({ path }) => ({
						contents: await readFile(process.env.TANUKI_HOST_RELAY_BASELINE, 'utf8'),
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
const { sendHostVoice, closeHostVoice } = mod.exports;
const realNow = Date.now;
let now = 10000;
Date.now = () => now;
const state = {
	mod: 'NoS',
	nosAddonIds: ['tanuki.bcl.roles'],
	isHost: true,
	clientId: 99,
	hostId: 99,
	lobbyCode: 'ABCDEF',
	players: Array.from({ length: 14 }, (_, id) => ({ id: id + 1, isDead: false, disconnected: false })),
};
const send = (s = state, pid = 123, id = 1, active = true) => sendHostVoice(id, 0.5, active, pid, s);
try {
	for (let tick = 0; tick < 10; tick++) {
		now = 10000 + tick * 100;
		for (const player of state.players) assert.equal(send(state, 123, player.id), true);
	}
	assert.equal(io.reads, 1, '140 samples share one unchanged descriptor read');
	assert.ok(io.stats <= 12, 'descriptor metadata checks are shared and rate limited');
	assert.equal(io.sockets[0].packets.length, 140, 'caching must not reduce sample delivery');
	console.log(`140 samples: ${io.reads} JSON read, ${io.stats} metadata checks, 140 UDP sends`);
	io.revision++;
	io.token = 'b'.repeat(32);
	io.port = 24567;
	io.reportVersion = true;
	now += 100;
	assert.equal(send(), true);
	const packet = io.sockets.at(-1).packets.at(-1);
	assert.ok(packet[0].startsWith('TBCLH1|' + io.token + '|'));
	assert.equal(packet[1], 24567);
	assert.equal(packet[0].split('|').length, 8);
	assert.equal(io.reads, 2, 'port/token/version changes reload the descriptor');
	assert.equal(send(state, 123, 1, false), true);
	assert.equal(io.sockets.at(-1).packets.at(-1)[0].split('|')[6], '0', 'inactive samples remain immediate');
	io.fail = true;
	now += 100;
	assert.equal(send(), false, 'unavailable metadata releases the cached descriptor');
	const readsAfterFailure = io.reads;
	for (let i = 0; i < 14; i++) assert.equal(send(), false);
	assert.equal(io.reads, readsAfterFailure, 'failure retries are bounded');
	io.fail = false;
	now += 100;
	assert.equal(send(), true, 'descriptor recovers without app restart');
	io.invalid = true;
	io.revision++;
	now += 100;
	assert.equal(send(), false, 'malformed JSON cannot retain the previous token');
	io.invalid = false;
	now += 100;
	assert.equal(send(), true);
	io.revision++;
	io.mutate = true;
	now += 100;
	assert.equal(send(), false, 'a descriptor changed during read is rejected');
	io.mutate = false;
	now += 100;
	assert.equal(send(), true);
	const before = io.reads;
	assert.equal(send({ ...state, lobbyCode: 'OTHER' }), true);
	assert.equal(io.reads, before + 1, 'new lobby starts with a fresh descriptor');
	assert.equal(send({ ...state, isHost: false }), false);
	assert.ok(io.sockets.at(-1).closed, 'loss of host closes the socket');
	assert.equal(send(), true);
	assert.equal(send({ ...state, nosAddonIds: [] }), false);
	assert.ok(io.sockets.at(-1).closed, 'detection loss closes the socket and clears cached tokens');
	const absentReads = io.reads;
	assert.equal(send({ ...state, nosAddonIds: [] }), false);
	assert.equal(io.reads, absentReads);
	io.pid = 456;
	assert.equal(send(state, 456), true, 'PID switch re-reads the descriptor');
	assert.equal(send(state, 123), false, 'wrong-process descriptor rejected');
	io.pid = 123;
	closeHostVoice();
	assert.equal(send({ ...state, players: undefined }), false);
	assert.equal(send(state, 123, 250), false);
	assert.equal(send({ ...state, players: [{ id: 1, isDead: true }] }), false);
	assert.equal(io.reads, absentReads + 2, 'invalid players must not read the descriptor');
	console.log(
		'PASS host descriptor cache: sharing, bounded refresh, replacements, failure, race, mute, PID/lobby/host/addon lifecycle'
	);
} finally {
	closeHostVoice();
	Date.now = realNow;
	delete globalThis.hostCacheIo;
}
