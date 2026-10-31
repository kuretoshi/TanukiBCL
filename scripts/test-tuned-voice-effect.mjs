import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import console from 'node:console';
import { setImmediate } from 'node:timers/promises';

const directory = resolve('.cache/tuned-voice-effect');
await mkdir(directory, { recursive: true });
const bundle = await build({
	stdin: {
		contents:
			"export * from './src/renderer/voice/tunedVoiceEffect'; export * from './src/renderer/voice/bibiriEcho'; export * from './src/renderer/settings/voiceEffectPreview';",
		resolveDir: resolve('.'),
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	define: { 'import.meta.env.DEV': 'false' },
});
const output = resolve(directory, 'production.mjs');
await writeFile(output, bundle.outputFiles[0].contents);
const {
	createTunedVoiceEffect,
	createTunedPlayback,
	createVoiceEffectPreview,
	createBibiriEcho,
	updateBibiriEcho,
	stopBibiriEcho,
	disconnectBibiriEcho,
} = await import(pathToFileURL(output));

const neutral = { pitch: 0, reverb: 0, echo: 0 };
class Node {
	constructor(context, kind) {
		this.context = context;
		this.kind = kind;
		this.connections = new Set();
		context.nodes.push(this);
		for (const key of ['gain', 'frequency', 'Q', 'delayTime', 'threshold', 'knee', 'ratio', 'attack', 'release'])
			this[key] = {
				value: key === 'gain' ? 1 : 0,
				calls: [],
				cancelScheduledValues() {},
				setValueAtTime(value, time) {
					this.value = value;
					this.calls.push([value, time]);
				},
				exponentialRampToValueAtTime(value, time) {
					this.calls.push([value, time]);
				},
				linearRampToValueAtTime(value, time) {
					this.calls.push([value, time]);
				},
				setTargetAtTime(value, time, constant) {
					this.value = value;
					this.calls.push([value, time, constant]);
				},
			};
	}
	connect(target) {
		this.connections.add(target);
		return target;
	}
	disconnect() {
		this.connections.clear();
	}
	set buffer(value) {
		this.impulse = value;
		this.bufferAssignments = (this.bufferAssignments ?? 0) + 1;
	}
	get buffer() {
		return this.impulse;
	}
}
globalThis.AudioWorkletNode = class extends Node {
	constructor(context) {
		super(context, 'worklet');
		this.parameters = new Map(['pitch', 'formant', 'squash'].map((key) => [key, { value: 0 }]));
		this.port = {
			postMessage(message) {
				this.message = message;
			},
			close() {
				this.closed = true;
			},
		};
	}
};
function context() {
	const value = {
		sampleRate: 48000,
		currentTime: 10,
		nodes: [],
		moduleLoads: 0,
		audioWorklet: {
			addModule: async () => {
				value.moduleLoads++;
				await value.moduleGate;
			},
		},
		decodeAudioData: async () => ({ impulse: true }),
	};
	for (const [method, kind] of [
		['createGain', 'gain'],
		['createDelay', 'delay'],
		['createConvolver', 'convolver'],
		['createBiquadFilter', 'filter'],
		['createWaveShaper', 'shaper'],
		['createDynamicsCompressor', 'compressor'],
	])
		value[method] = () => new Node(value, kind);
	return value;
}
const allocated = (context, kind) => context.nodes.filter((node) => node.kind === kind);
const connected = (node, targets) => {
	assert.equal(node.connections.size, targets.length);
	for (const target of targets) assert.ok(node.connections.has(target), 'expected audio connection');
};

const c = context(),
	effect = createTunedVoiceEffect(c);
effect.update(neutral);
assert.equal(c.nodes.length, 2, 'neutral processing creates no pitch, distortion, delay, or convolver');
connected(effect.input, [effect.output]);
effect.update({ pitch: -100, reverb: 0, echo: 50 });
const pitch = effect.pitch,
	echo = effect.echo;
assert.equal(pitch.node.parameters.get('pitch').value, 0.5);
assert.equal(pitch.node.parameters.get('formant').value, 1);
assert.equal(echo.delay.delayTime.value, 0.18);
assert.equal(echo.feedback.gain.value, 0.22);
assert.equal(echo.wet.gain.value, 0.06);
connected(effect.input, [pitch.input]);
connected(pitch.output, [echo.input]);
connected(echo.output, [effect.output]);
effect.update({ pitch: 100, reverb: 100, echo: 100 }, 40);
assert.equal(effect.pitch, pitch, 'profile changes reuse one pitch worklet');
assert.equal(effect.echo, echo, 'combined profiles reuse one echo loop');
assert.equal(pitch.node.parameters.get('pitch').value, 2);
assert.ok(Math.abs(effect.berserker.processed.gain.value - 0.78 * 0.4) < 1e-9);
assert.equal(allocated(c, 'convolver').length, 0, 'Berserker grit has no private reverb');
assert.equal(allocated(c, 'delay').length, 1, 'Berserker grit has no private second echo');
const echoAutomation = echo.wet.gain.calls.length;
effect.update({ pitch: 100, reverb: 100, echo: 100 }, 40);
assert.equal(echo.wet.gain.calls.length, echoAutomation, 'unchanged snapshots must not restart gain smoothing');
assert.deepEqual(echo.wet.gain.calls.at(-1), [0.12, c.currentTime, 0.01], 'changed amounts use a short gain ramp');
effect.update(neutral);
assert.equal(pitch.node.port.closed, true);
assert.equal(echo.delay.connections.size, 0);
assert.equal(effect.pitch, undefined);
assert.equal(effect.berserker, undefined);
assert.equal(effect.echo, undefined);
connected(effect.input, [effect.output]);

const playbackContext = context(),
	playback = createTunedPlayback(playbackContext);
playback.update({ ...neutral, reverb: 100 }, null);
assert.equal(allocated(playbackContext, 'convolver').length, 0, 'missing IR leaves the direct speech path');
connected(playback.processing.output, [playback.output]);
const impulse = { impulse: 'loaded' };
playback.update({ ...neutral, reverb: 100 }, impulse);
const convolver = allocated(playbackContext, 'convolver')[0];
for (let i = 0; i < 100; i++) playback.update({ ...neutral, reverb: 50 }, impulse);
assert.equal(convolver.bufferAssignments, 1, 'unchanged snapshots must not reset the convolver');
assert.equal(allocated(playbackContext, 'convolver').length, 1);
const mixDry = [...playback.processing.output.connections].find((node) => node !== convolver);
assert.equal(mixDry.gain.value, 0.5);
playback.update(neutral, impulse);
assert.equal(convolver.connections.size, 0);
connected(playback.processing.output, [playback.output]);
playback.update({ ...neutral, reverb: 100 }, impulse);
assert.equal(
	allocated(playbackContext, 'convolver').length,
	2,
	're-enable starts a fresh impulse, without an old tail'
);
playback.disconnect();
assert.ok(playbackContext.nodes.every((node) => node.connections.size === 0));

const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(0) });
	const bibiriContext = context();
	const bibiriPreview = await createVoiceEffectPreview(bibiriContext, 'nosBibiri', { ...neutral, echo: 25 });
	const bibiriWet = allocated(bibiriContext, 'gain').find((node) => node.gain.value === 0.65 * 0.25);
	const bibiriFeedback = allocated(bibiriContext, 'gain').find((node) => node.gain.value === 0.56 * 0.25);
	assert.equal(allocated(bibiriContext, 'delay')[0].delayTime.value, 0.3);
	bibiriPreview.update({ ...neutral, echo: 75 });
	assert.deepEqual(bibiriWet.gain.calls.at(-1), [(0.65 * 75) / 100, bibiriContext.currentTime, 0.01]);
	assert.deepEqual(bibiriFeedback.gain.calls.at(-1), [(0.56 * 75) / 100, bibiriContext.currentTime, 0.01]);
	const bibiriAutomation = bibiriWet.gain.calls.length;
	bibiriPreview.update({ ...neutral, echo: 75 });
	assert.equal(bibiriWet.gain.calls.length, bibiriAutomation, 'Bibiri preview has one stable wet target');
	bibiriPreview.dispose();
	const previewContext = context();
	let ready;
	previewContext.moduleGate = new Promise((resolve) => {
		ready = resolve;
	});
	const preview = await createVoiceEffectPreview(previewContext, 'disguise', neutral);
	assert.equal(previewContext.moduleLoads, 0, 'pitch0 does not prepare a worklet');
	preview.update({ ...neutral, echo: 25 });
	assert.equal(previewContext.moduleLoads, 0, 'echo alone does not prepare a worklet');
	preview.update({ ...neutral, pitch: 50 });
	preview.update({ ...neutral, pitch: -50 });
	assert.equal(previewContext.moduleLoads, 1);
	ready();
	await setImmediate();
	assert.equal(
		allocated(previewContext, 'worklet')[0].parameters.get('pitch').value,
		2 ** -0.5,
		'lazy preparation applies the latest tuning'
	);
	preview.dispose();
	assert.ok(previewContext.nodes.every((node) => node.connections.size === 0));
	const stoppedContext = context();
	let stopReady;
	stoppedContext.moduleGate = new Promise((resolve) => {
		stopReady = resolve;
	});
	const stopped = await createVoiceEffectPreview(stoppedContext, 'disguise', neutral);
	stopped.update({ ...neutral, pitch: 100 });
	stopped.dispose();
	stopReady();
	await setImmediate();
	assert.equal(
		allocated(stoppedContext, 'worklet').length,
		0,
		'disposed preview cannot be resurrected by worklet preparation'
	);
	globalThis.fetch = async () => {
		throw Error('fixture missing IR');
	};
	const unavailableContext = context();
	const unavailable = await createVoiceEffectPreview(unavailableContext, 'nosRainbowStar', { ...neutral, reverb: 100 });
	assert.equal(allocated(unavailableContext, 'convolver').length, 0);
	unavailable.dispose();
} finally {
	globalThis.fetch = originalFetch;
}

const deathContext = context(),
	source = deathContext.createGain(),
	destination = deathContext.createGain();
const death = createBibiriEcho(deathContext, source, destination);
const tunedDeath = { pitch: 100, reverb: 60, echo: 0 };
const timestamp = 100000;
updateBibiriEcho(death, true, false, undefined, timestamp, tunedDeath, impulse);
assert.equal(death.input.gain.value, 1);
assert.equal(allocated(deathContext, 'worklet').length, 0, 'Bibiri does not run pitch processing while alive');
assert.equal(allocated(deathContext, 'convolver').length, 0, 'Bibiri does not run convolution while alive');
updateBibiriEcho(death, true, true, undefined, timestamp + 100, tunedDeath, impulse);
assert.equal(
	death.feedback.gain.value,
	0.56,
	'retain the fragment while waiting for a delayed death RPC, even at echo0'
);
assert.equal(allocated(deathContext, 'worklet').length, 0);
updateBibiriEcho(death, true, true, timestamp, timestamp + 200, tunedDeath, impulse);
assert.equal(death.until, 12.4);
assert.equal(death.input.gain.value, 0);
assert.equal(death.feedback.gain.value, 0, 'echo0 releases the retained fragment once, without repeats');
assert.equal(death.playback.processing.pitch.node.parameters.get('pitch').value, 2);
assert.equal(allocated(deathContext, 'convolver').length, 1);
connected(death.delay, [death.feedback, death.playback.input]);
connected(death.playback.output, [death.output]);
connected(death.output, [death.peakGuard.input]);
connected(death.peakGuard.output, [destination]);
assert.deepEqual(
	death.output.gain.calls.slice(-3),
	[
		[0.65, 10],
		[0.001, 12.4],
		[0, 12.4],
	],
	'final gate applies the unchanged 2.4s event window after pitch/reverb'
);
const deathPitch = death.playback.processing.pitch;
deathContext.currentTime = 12.4;
updateBibiriEcho(death, true, true, timestamp, timestamp + 2400, tunedDeath, impulse);
assert.equal(death.until, 0);
assert.equal(death.output.gain.value, 0);
assert.equal(deathPitch.node.port.closed, true);
assert.equal(allocated(deathContext, 'convolver')[0].connections.size, 0);
const allocations = deathContext.nodes.length;
updateBibiriEcho(death, true, false, undefined, timestamp + 2500, neutral, impulse);
assert.equal(death.input.gain.value, 0, 'all-zero Bibiri does not retain new speech');
assert.equal(deathContext.nodes.length, allocations, 'all-zero Bibiri does not allocate DSP');
stopBibiriEcho(death);
disconnectBibiriEcho(death);
assert.equal(death.output.connections.size, 0);
console.log(
	'PASS production tuning graph: independent axes, one IR/echo, convolver reuse/reset, lazy worklet races, dry fallback, and Bibiri event-only tuning/one-shot/final mute gate'
);
