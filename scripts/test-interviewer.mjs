import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'tanuki-interview-'));
async function load(path, name) {
	const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
	const output = join(directory, name + '.mjs');
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
function context() {
	const nodes = [],
		played = [];
	function node() {
		const n = {
			gain: { value: 0 },
			connections: [],
			connect(target) {
				this.connections.push(target);
			},
			disconnect(target) {
				this.connections = target ? this.connections.filter((node) => node !== target) : [];
				this.disconnected = true;
			},
			start(when, offset) {
				this.offset = offset;
				played.push(this);
			},
			stop() {
				this.stopped = true;
			},
		};
		nodes.push(n);
		return n;
	}
	return {
		nodes,
		played,
		sampleRate: 8,
		currentTime: 0,
		createGain: node,
		createScriptProcessor: node,
		createBufferSource: node,
		createBuffer(channels, count) {
			const data = new Float32Array(count);
			return { getChannelData: () => data };
		},
	};
}
try {
	const { readInterviewState } = await load('src/main/interviewState.ts', 'reader');
	const { createInterviewerRecording } = await load(
		process.env.TANUKI_INTERVIEW_SOURCE ?? 'src/renderer/voice/interviewerRecording.ts',
		'audio'
	);
	const entry = { playerId: 7, started: 10000, seconds: 1, stopped: 0, visible: [1, 2], playStarted: 0 };
	const path = join(directory, 'state.json');
	const envelope = { protocol: 1, pid: 123, unixMs: 10000, players: [entry] };
	await writeFile(path, JSON.stringify(envelope));
	assert.deepEqual(readInterviewState(123, 10000, path), [entry]);
	assert.deepEqual(readInterviewState(124, 10000, path), [], 'other process must not receive recordings');
	assert.deepEqual(readInterviewState(123, 11001, path), [], 'stale role state is rejected');
	for (const invalid of [
		{ ...entry, seconds: 31 },
		{ ...entry, visible: [1, 1] },
		{ ...entry, visible: 'AQI=' },
		{ ...entry, stopped: 9999 },
		{ ...entry, playStarted: 10000 },
		{ ...entry, visible: [256] },
	]) {
		await writeFile(path, JSON.stringify({ ...envelope, players: [invalid] }));
		assert.deepEqual(readInterviewState(123, 10000, path), [], 'invalid visibility, duration or playback rejected');
	}
	const ctx = context(),
		audio = createInterviewerRecording(ctx, ctx.createGain());
	let ownAllowed = true;
	function input(key, id, allowed) {
		const source = ctx.createGain();
		audio.setInput(key, source, id, allowed);
		return {
			get onaudioprocess() {
				return source.connections.find((node) => node.onaudioprocess)?.onaudioprocess ?? null;
			},
		};
	}
	const own = input('own', 1, () => ownAllowed),
		peer = input('peer', 2, () => true),
		hidden = input('hidden', 3, () => true);
	function feed(processor, value) {
		processor.onaudioprocess?.({
			inputBuffer: { getChannelData: () => Float32Array.from([value, value, value, value]) },
		});
	}
	audio.update([entry], true, false, 1, 10000);
	ctx.currentTime = 0.5;
	feed(own, 0.25);
	feed(peer, 0.5);
	feed(hidden, 100);
	audio.update([{ ...entry, visible: [1] }], true, false, 1, 10500);
	ctx.currentTime = 1;
	feed(own, 0.25);
	feed(peer, 100);
	const saved = { ...entry, stopped: 10750, visible: [], playStarted: 11000 };
	audio.update([saved], true, true, 1, 11000);
	assert.deepEqual(
		Array.from(ctx.played[0].buffer.getChannelData(0)),
		[0.75, 0.75, 0.75, 0.75, 0.25, 0.25],
		'own mic is mixed with visible peers; hidden voices excluded; meeting trims at the exact interruption'
	);
	audio.update([saved], true, true, 1, 11001);
	assert.equal(ctx.played.length, 1, 'state heartbeat must not restart playback');
	audio.update([{ ...saved, playStarted: 12000 }], true, true, 1, 12000);
	assert.equal(ctx.played.length, 2, 'a fresh meeting button request replays the recording');
	assert.equal(ctx.played[0].stopped, true, 'replay replaces its previous source');
	audio.update([{ ...saved, playStarted: 12000 }], true, false, 1, 12001);
	assert.equal(ctx.played[1].stopped, true, 'meeting end stops playback');
	const second = { ...entry, started: 20000, visible: [1] };
	ctx.currentTime = 2;
	audio.update([second], true, false, 1, 20000);
	ctx.currentTime = 2.5;
	feed(own, 0.125);
	ownAllowed = false;
	ctx.currentTime = 3;
	feed(own, 100);
	const secondSaved = { ...second, stopped: 21000, visible: [], playStarted: 22000 };
	audio.update([secondSaved], true, true, 1, 22000);
	assert.deepEqual(
		Array.from(ctx.played.at(-1).buffer.getChannelData(0)),
		[0.125, 0.125, 0.125, 0.125, 0, 0, 0, 0],
		'recording again overwrites every previous voice; muted local mic is not captured'
	);
	audio.update([secondSaved], true, true, 0, 22001);
	assert.equal(ctx.played.at(-1).stopped, true, 'mute stops meeting playback');
	const third = { ...entry, started: 30000, visible: [1] };
	ownAllowed = true;
	ctx.currentTime = 4;
	audio.update([third], true, false, 1, 30000);
	ctx.currentTime = 4.5;
	feed(own, 0.375);
	ctx.currentTime = 6;
	feed(own, 100);
	audio.update([{ ...third, stopped: 31000, visible: [], playStarted: 32000 }], true, true, 1, 32000);
	assert.deepEqual(
		Array.from(ctx.played.at(-1).buffer.getChannelData(0)),
		[0.375, 0.375, 0.375, 0.375, 0, 0, 0, 0],
		'audio clock prevents later conversation from entering the recording when game state stalls'
	);
	const beforeLate = ctx.played.length;
	audio.update([{ ...third, stopped: 31000, visible: [], playStarted: 33000 }], true, true, 1, 34001);
	assert.equal(ctx.played.length, beforeLate, 'expired playback is never queued into a later meeting');
	audio.update([], false, false, 1, 35000);
	assert.equal(ctx.played.at(-1).stopped, true, 'game end destroys all recording playback');
	audio.removeInput('peer');
	assert.equal(peer.onaudioprocess, null, 'disconnect releases peer recording node');
	audio.disconnect();
	assert.equal(own.onaudioprocess, null, 'teardown releases local microphone recording node');

	for (const localId of [1, 2]) {
		const c = context(),
			a = createInterviewerRecording(c, c.createGain());
		const source = c.createGain();
		a.setInput('local', source, localId, () => true);
		const localProcessor = {
			get onaudioprocess() {
				return source.connections.find((node) => node.onaudioprocess)?.onaudioprocess ?? null;
			},
		};
		const remoteSource = c.createGain();
		a.setInput('remote', remoteSource, localId === 1 ? 2 : 1, () => true);
		const remoteProcessor = {
			get onaudioprocess() {
				return remoteSource.connections.find((node) => node.onaudioprocess)?.onaudioprocess ?? null;
			},
		};
		a.update([entry], true, false, 1, 10000);
		c.currentTime = 0.5;
		feed(localProcessor, 0.25);
		feed(remoteProcessor, 0.5);
		a.update([saved], true, true, 1, 11000);
		assert.deepEqual(
			Array.from(c.played[0].buffer.getChannelData(0)),
			[0.75, 0.75, 0.75, 0.75, 0, 0],
			'each participant hears a recording containing both their own and the remote voice'
		);
		a.disconnect();
	}
	console.log(
		'PASS interviewer: IPC validation, own/visible voices, dynamic visibility, partial meeting save, overwrite, replay, mute, expiry, cleanup and all-participant playback'
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
