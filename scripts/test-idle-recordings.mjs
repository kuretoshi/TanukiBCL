import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

async function load(file) {
	const root = process.env.TANUKI_RECORDING_ROOT ?? 'src/renderer/voice';
	const result = await build({
		entryPoints: [resolve(root, file)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	});
	return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const { createMegaphoneRecording } = await load('megaphoneRecording.ts');
const { createDyingVoiceRecording } = await load('dyingVoiceRecording.ts');
const { createInterviewerRecording } = await load('interviewerRecording.ts');
const nodes = [];
function node(kind) {
	const value = {
		kind,
		connections: new Set(),
		gain: { value: 0 },
		connect(target) {
			this.connections.add(target);
		},
		disconnect(target) {
			if (target) this.connections.delete(target);
			else this.connections.clear();
		},
	};
	nodes.push(value);
	return value;
}
const context = {
	sampleRate: 48000,
	currentTime: 0,
	createGain: () => node('gain'),
	createScriptProcessor: () => node('processor'),
};
const destination = node('destination');
const interview = createInterviewerRecording(context, destination);
const sources = [],
	megaphones = [],
	dying = [];
for (let id = 0; id < 15; id++) {
	const source = node('source');
	source.connect(destination); // Ordinary voice must survive capture teardown.
	sources.push(source);
	megaphones.push(createMegaphoneRecording(context, source, destination));
	dying.push(createDyingVoiceRecording(context, source, destination));
	interview.setInput(String(id), source, id, () => true);
}
const created = () => nodes.filter((n) => n.kind === 'processor').length;
const active = () => nodes.filter((n) => n.kind === 'processor' && n.onaudioprocess && n.connections.size).length;
console.log(`15 idle inputs: ${created()} processors created, ${active()} connected callbacks`);
assert.equal(created(), 0, 'unused role recordings must not allocate PCM processors');
assert.equal(active(), 0, 'idle recordings must not schedule PCM callbacks');
const charge = { playerId: 0, shotId: 1, phase: 'charging' };
const message = { playerId: 1, started: 10000, seconds: 1, range: 2.5, x: 0, y: 0 };
const entry = { playerId: 7, started: 10000, seconds: 1, stopped: 0, visible: [2], playStarted: 0 };
megaphones[0].update(charge, true);
dying[1].update(message, true, false, 10000);
interview.update([entry], true, false, 1, 10000);
assert.equal(active(), 3, 'only the three authorized recordings run');
const counts = created();
for (let i = 0; i < 100; i++) {
	megaphones[0].update(charge, true);
	dying[1].update(message, true, false, 10000);
	interview.update([entry], true, false, 1, 10000);
}
assert.equal(created(), counts, 'state heartbeats reuse processors and do not reconnect graphs');
const oldCallbacks = nodes.filter((n) => n.onaudioprocess).map((n) => n.onaudioprocess);
megaphones[0].cancel();
dying[1].cancel();
interview.clear();
assert.equal(active(), 0, 'cancel disconnects every capture');
for (const callback of oldCallbacks)
	callback({
		get inputBuffer() {
			throw new Error('late PCM callback');
		},
	});
assert.ok(
	sources.every((source) => source.connections.has(destination)),
	'normal voice remains connected'
);
megaphones[0].update({ ...charge, shotId: 2 }, true);
dying[1].update({ ...message, started: 20000 }, true, false, 20000);
interview.update([{ ...entry, started: 20000 }], true, false, 1, 20000);
assert.equal(active(), 3, 'a subsequent recording resumes all capture types');
assert.equal(created(), counts + 3, 'later recordings use fresh PCM buffers');
for (const callback of oldCallbacks)
	callback({
		get inputBuffer() {
			throw new Error('previous recording callback');
		},
	});
for (const recorder of [...megaphones, ...dying]) recorder.disconnect();
interview.disconnect();
assert.equal(active(), 0, 'teardown leaves no active capture');
console.log('PASS idle PCM capture: allocation, visibility, reuse, cancellation, late callbacks and normal voice');
