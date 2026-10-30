import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { transform } from 'esbuild';

const productionPath = 'src/renderer/lib/vad.ts';
const source = await readFile(process.env.TANUKI_VAD_BASELINE ?? productionPath, 'utf8');
const gitPath = resolve('.git');
const gitDirectory = (await stat(gitPath)).isDirectory()
	? gitPath
	: resolve((await readFile(gitPath, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
const baselineRevision = '31dac1caafc27d0aeba374520f6c476211845e9a'; // v3.2.56, before buffer reuse.
let referenceSource;
try {
	referenceSource = execFileSync(
		'git',
		[`--git-dir=${gitDirectory}`, `--work-tree=${process.cwd()}`, 'show', `${baselineRevision}:${productionPath}`],
		{ encoding: 'utf8', maxBuffer: 1024 * 1024 }
	);
} catch (cause) {
	throw new Error(
		`VAD regression baseline v3.2.56 (${baselineRevision}) is required. Fetch full Git history for a shallow clone.`,
		{
			cause,
		}
	);
}

async function runtime(text) {
	const { code } = await transform(text, { loader: 'ts', format: 'cjs', target: 'es2022' });
	const counters = { allocations: 0, timers: new Map(), clearedTimers: [], nextTimer: 0 };
	class CountedUint8Array extends Uint8Array {
		constructor(length) {
			super(length);
			counters.allocations++;
		}
	}
	const module = { exports: {} };
	vm.runInNewContext(
		code,
		{
			module,
			exports: module.exports,
			Uint8Array: CountedUint8Array,
			setTimeout(callback, delay) {
				const id = ++counters.nextTimer;
				counters.timers.set(id, { callback, delay });
				return id;
			},
			clearTimeout(id) {
				counters.clearedTimers.push(id);
				counters.timers.delete(id);
			},
		},
		{ filename: productionPath }
	);
	return { create: module.exports.default, counters };
}

function instance(subject, options = {}, passthrough = false) {
	const node = () => ({
		connections: [],
		disconnects: 0,
		connect(other) {
			this.connections.push(other);
		},
		disconnect() {
			this.disconnects++;
			this.connections.length = 0;
		},
	});
	const source = node();
	const target = passthrough ? node() : undefined;
	const events = [];
	const updates = [];
	const buffers = [];
	let frame = 0;
	let frequency = 0;
	const context = {
		sampleRate: 48000,
		destination: node(),
		createAnalyser() {
			return {
				...node(),
				context,
				fftSize: 2048,
				get frequencyBinCount() {
					return this.fftSize / 2;
				},
				getByteFrequencyData(buffer) {
					assert.equal(buffer.length, this.frequencyBinCount, 'Frequency buffer must match the current FFT');
					buffers.push(buffer);
					buffer.fill(frequency);
				},
			};
		},
		createScriptProcessor(bufferLen, inputChannels, outputChannels) {
			return { ...node(), bufferLen, inputChannels, outputChannels, onaudioprocess: null };
		},
	};
	let analyser;
	let processor;
	const createAnalyser = context.createAnalyser;
	const createProcessor = context.createScriptProcessor;
	context.createAnalyser = () => (analyser = createAnalyser());
	context.createScriptProcessor = (...args) => (processor = createProcessor(...args));
	const vad = subject.create(context, source, target, {
		onVoiceStart: () => events.push(['start', frame]),
		onVoiceStop: () => events.push(['stop', frame]),
		onUpdate: (value) => updates.push([frame, value]),
		...options,
	});
	const timerId = subject.counters.nextTimer;
	const input = [new Float32Array([0.5, -0.1, 1, 0]), new Float32Array([-1, 0.2, 0, 0.9])];
	const output = input.map((channel) => new Float32Array(channel.length));
	const audioEvent = {
		inputBuffer: { length: input[0].length, getChannelData: (channel) => input[channel] },
		outputBuffer: { numberOfChannels: output.length, getChannelData: (channel) => output[channel] },
	};
	return {
		vad,
		analyser,
		processor,
		source,
		target,
		events,
		updates,
		buffers,
		input,
		output,
		timerId,
		process(value) {
			frequency = value;
			frame++;
			processor.onaudioprocess?.(audioEvent);
		},
		finishCalibration() {
			const timer = subject.counters.timers.get(timerId);
			assert.ok(timer, 'Calibration timer must remain scheduled');
			subject.counters.timers.delete(timerId);
			timer.callback();
		},
	};
}

const actual = await runtime(source);
const reference = await runtime(referenceSource);
const observed = instance(actual, { noiseCaptureDuration: 0, stereo: false });
const previous = instance(reference, { noiseCaptureDuration: 0, stereo: false });
observed.vad.init();
previous.vad.init();
for (let frame = 0; frame < 1000; frame++) {
	const level = Math.floor(frame / 100) % 2 ? 0 : 220;
	observed.process(level);
	previous.process(level);
}
assert.equal(actual.counters.allocations, 1, '1000 callbacks must allocate only one frequency buffer');
assert.equal(new Set(observed.buffers).size, 1, 'All callbacks must use the same array');
assert.deepEqual(observed.events, previous.events, 'Speech transition timing must match the pre-change VAD');
assert.deepEqual(observed.updates, previous.updates, 'Every analysis result must match the pre-change VAD');
const referenceAllocations = reference.counters.allocations;

const firstBuffer = observed.buffers[0];
observed.analyser.fftSize = 2048;
for (let frame = 0; frame < 100; frame++) observed.process(128);
assert.equal(actual.counters.allocations, 2, 'An FFT size change must allocate exactly once');
const largerBuffer = observed.buffers[1000];
assert.notEqual(largerBuffer, firstBuffer);
assert.equal(largerBuffer.length, 1024);
assert.ok(observed.buffers.slice(1000).every((buffer) => buffer === largerBuffer));
observed.analyser.fftSize = 1024;
observed.process(128);
assert.equal(actual.counters.allocations, 3);
assert.equal(observed.buffers.at(-1).length, 512);
observed.vad.destroy();

const isolated = await runtime(source);
const left = instance(isolated, { noiseCaptureDuration: 0 });
const right = instance(isolated, { noiseCaptureDuration: 0 });
left.vad.init();
right.vad.init();
for (let frame = 0; frame < 20; frame++) {
	left.process(255);
	right.process(0);
}
assert.equal(isolated.counters.allocations, 2, 'Separate VAD instances must each own one array');
assert.notEqual(left.buffers[0], right.buffers[0]);
assert.ok(
	left.buffers[0].every((value) => value === 255),
	'A second VAD must not overwrite the first buffer'
);
assert.ok(right.buffers[0].every((value) => value === 0));
assert.ok(left.events.some(([event]) => event === 'start'));
assert.ok(!right.events.some(([event]) => event === 'start'));
left.vad.destroy();
right.vad.destroy();

async function calibratedRun(text) {
	const subject = await runtime(text);
	const running = instance(subject, { noiseCaptureDuration: 123, minNoiseLevel: 0.1 }, true);
	assert.equal(subject.counters.timers.get(running.timerId).delay, 123, 'Calibration delay must remain unchanged');
	for (const level of [0, 10, 20, 30, 15, 5, 0, 10]) running.process(level);
	assert.deepEqual(running.updates, [], 'Calibration must not publish speech levels');
	running.finishCalibration();
	for (const [level, count] of [
		[0, 10],
		[255, 40],
		[0, 40],
		[128, 25],
		[0, 40],
	]) {
		for (let frame = 0; frame < count; frame++) running.process(level);
	}
	assert.deepEqual(running.output, running.input, 'Audio passthrough samples must remain exact');
	assert.deepEqual(
		running.events.map(([event]) => event),
		['stop', 'start', 'stop', 'start', 'stop']
	);
	assert.equal(running.updates.length, 155);
	const output = { events: running.events, updates: running.updates };
	const beforeDestroy = [running.events.length, running.updates.length, running.buffers.length];
	running.vad.destroy();
	assert.equal(running.processor.onaudioprocess, null, 'Destroy must remove the audio callback');
	assert.equal(running.processor.disconnects, 1);
	assert.equal(running.analyser.disconnects, 1);
	assert.equal(running.source.disconnects, 1);
	assert.ok(subject.counters.clearedTimers.includes(running.timerId));
	assert.equal(subject.counters.timers.size, 0);
	running.process(255);
	assert.deepEqual(
		[running.events.length, running.updates.length, running.buffers.length],
		beforeDestroy,
		'Destroyed VAD must not emit or analyse more callbacks'
	);
	return output;
}
assert.deepEqual(
	await calibratedRun(source),
	await calibratedRun(referenceSource),
	'Calibration, analysis and speech timing must match the pre-change source'
);
console.log(
	`PASS production VAD buffer reuse: 1000 callbacks, ${referenceAllocations} reference allocations -> 1; FFT resizing, isolated instances, exact analysis/calibration/speech timing, passthrough and destroy cleanup`
);
