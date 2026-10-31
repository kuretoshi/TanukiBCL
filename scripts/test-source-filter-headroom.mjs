import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const directory = resolve(process.env.TANUKI_DSP_CACHE ?? '.cache/source-filter-headroom');
await mkdir(directory, { recursive: true });
const source = await readFile(
	process.env.TANUKI_SOURCE_FILTER_TEST_SOURCE ?? 'src/renderer/voice/sourceFilterProcessor.ts',
	'utf8'
);
const before = process.env.TANUKI_SOURCE_FILTER_BEFORE
	? await readFile(process.env.TANUKI_SOURCE_FILTER_BEFORE, 'utf8')
	: undefined;
const hash = (text) => createHash('sha256').update(text).digest('hex');

async function load(text, sampleRate) {
	let Processor;
	const { code } = await transform(text, { loader: 'ts', format: 'cjs', target: 'es2022' });
	const scope = {
		sampleRate,
		AudioWorkletProcessor: class {
			port = {};
		},
		registerProcessor: (_, value) => {
			Processor = value;
		},
	};
	new Function('module', 'globalThis', `${code}\nmodule.exports.registerSourceFilterProcessor();`)(
		{ exports: {} },
		scope
	);
	return Processor;
}

function voiced(rate, peak) {
	const input = new Float32Array(Math.floor(rate * 1.2)),
		harmonics = [];
	for (let f = 120; f < Math.min(6000, rate / 2); f += 120)
		harmonics.push([f, 0.03 + Math.exp(-(((f - 700) / 200) ** 2)) + 0.8 * Math.exp(-(((f - 1800) / 300) ** 2))]);
	let maximum = 0;
	for (let i = 0; i < input.length; i++) {
		let sample = 0;
		for (const [frequency, amplitude] of harmonics)
			sample += amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
		input[i] = sample;
		maximum = Math.max(maximum, Math.abs(sample));
	}
	for (let i = 0; i < input.length; i++) input[i] *= peak / maximum;
	return input;
}

function render(Processor, input, pitch) {
	const processor = new Processor(),
		output = new Float32Array(input.length),
		block = new Float32Array(128),
		target = new Float32Array(128);
	const parameters = {
		pitch: new Float32Array([pitch]),
		formant: new Float32Array([1]),
		squash: new Float32Array([0]),
	};
	for (let i = 0; i < input.length; i += 128) {
		block.fill(0);
		block.set(input.subarray(i, i + 128));
		assert.equal(processor.process([[block]], [[target]], parameters), true);
		output.set(target.subarray(0, Math.min(128, output.length - i)), i);
	}
	return { output, processor };
}

function measure({ output, processor }, rate) {
	let power = 0,
		peak = 0,
		atRail = 0;
	for (let i = rate / 2; i < output.length; i++) {
		const sample = output[i];
		assert.ok(Number.isFinite(sample));
		power += sample * sample;
		peak = Math.max(peak, Math.abs(sample));
		if (Math.abs(sample) >= 0.99999) atRail++;
	}
	const n = 16384,
		re = new Float64Array(n),
		im = new Float64Array(n);
	for (let i = 0; i < n; i++) re[i] = output[Math.floor(rate / 2) + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
	processor.fft(re, im);
	let high = 0,
		total = 0;
	for (let k = 0; k < n / 2; k++) {
		const energy = re[k] ** 2 + im[k] ** 2;
		total += energy;
		if ((k * rate) / n >= 12000) high += energy;
	}
	return {
		peak,
		atRail,
		rms: Math.sqrt(power / (output.length - rate / 2)),
		above12kPowerRatio: total ? high / total : 0,
	};
}

function checkCase(Processor, Before, input, rate, inputPeak, pitch) {
	const rendered = render(Processor, input, pitch),
		current = measure(rendered, rate);
	const previous = Before ? render(Before, input, pitch) : undefined;
	const baseline = previous ? measure(previous, rate) : undefined;
	const row = { rate, inputPeak, pitch, ...current, baseline };
	assert.ok(current.peak < 0.98, `processed voice keeps headroom at ${rate}Hz, peak${inputPeak}, pitch${pitch}`);
	assert.equal(current.atRail, 0, 'strong transposed speech does not flatten at the full-scale rails');
	if (inputPeak === 0)
		assert.ok(
			rendered.output.every((sample) => sample === 0),
			'silence remains silent'
		);
	if (previous && inputPeak <= 0.25) {
		assert.deepEqual(rendered.output, previous.output, 'ordinary speech preserves every published DSP sample');
		row.maxError = 0;
	}
	if (baseline && inputPeak === 0.95) {
		assert.ok(current.rms >= baseline.rms * 0.95, 'safety does not lower the whole voice by a fixed gain');
		if (rate === 48000 && pitch < 1)
			assert.ok(
				current.above12kPowerRatio < baseline.above12kPowerRatio * 0.5,
				'soft peaks reduce hard-clipping high-frequency components'
			);
	}
	return row;
}
const rows = [];
for (const rate of [44100, 48000]) {
	const Processor = await load(source, rate),
		Before = before ? await load(before, rate) : undefined;
	for (const inputPeak of [0, 0.25, 0.95]) {
		const input = voiced(rate, inputPeak);
		for (const pitch of [0.5, 2 ** -0.5, 1, 2 ** 0.5, 2])
			rows.push(checkCase(Processor, Before, input, rate, inputPeak, pitch));
	}
}

// Exercise the actual process output stage around the knee, including invalid/extreme values.
const Processor = await load(source, 48000),
	processor = new Processor(),
	samples = [-1000, -1.2, -0.801, -0.8, -0.1, 0, 0.1, 0.8, 0.801, 1.2, 1000, NaN, Infinity];
processor.output.set(samples);
const output = new Float32Array(samples.length);
processor.process([], [[output]], {});
for (let i = 0; i < 11; i++) {
	assert.ok(Math.abs(output[i]) < 1);
	if (i) assert.ok(output[i] >= output[i - 1], 'safety remains monotonic through its knee');
}
assert.equal(output[11], 0);
assert.equal(output[12], 0);
for (const i of [3, 4, 5, 6, 7]) assert.equal(output[i], Math.fround(samples[i]), 'the linear region has unity gain');
assert.ok(Math.abs((output[8] - output[7]) / 0.001 - 1) < 0.002, 'knee starts with a continuous slope');
processor.port.onmessage({ data: 'stop' });
assert.equal(processor.process([], [[output]], {}), false);
const evidence = resolve(directory, 'headroom.json');
await writeFile(
	evidence,
	JSON.stringify({ sourceSha256: hash(source), beforeSha256: before ? hash(before) : undefined, rows }, null, 2)
);
console.log(
	`PASS DSP headroom: ${rows.length} voiced/silence cases, low-level sample identity, continuous knee, no flat rails, high-frequency comparison and stop; ${evidence}`
);
