// Golden comparison against the actual v3.2.62 AudioWorklet implementation.
// All samples are generated test signals; no microphone or received audio.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const exe = resolve(process.argv[2] ?? join(root, 'src-tauri/target/debug/tanuki-bcl-tauri.exe'));
const directory = join(root, '.tools/native-voice-effects', `run-${Date.now()}`);
await mkdir(directory, { recursive: true });
const source = join(root, 'src/renderer/voice/sourceFilterProcessor.ts');
const compiled = await build({
	entryPoints: [source],
	bundle: true,
	write: false,
	format: 'iife',
	globalName: 'dsp',
	platform: 'browser',
});
let Implementation;
const context = vm.createContext({
	sampleRate: 48000,
	AudioWorkletProcessor: class {
		port = {};
	},
	registerProcessor: (name, cls) => {
		assert.equal(name, 'nos-source-filter');
		Implementation = cls;
	},
});
vm.runInContext(
	Buffer.from(compiled.outputFiles[0].contents).toString() + ';dsp.registerSourceFilterProcessor();',
	context
);
let seed = 0x83ac59;
const samples = Array.from({ length: 24576 }, (_, n) => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	const sample = Math.fround(
		0.03 *
			(Math.sin((2 * Math.PI * 180 * n) / 48000) +
				0.4 * Math.sin((2 * Math.PI * 360 * n) / 48000) +
				0.2 * Math.sin((2 * Math.PI * 540 * n) / 48000)) +
			(seed / 2 ** 32 - 0.5) * 0.001
	);
	return [sample, Math.fround(sample * 0.7)];
});
const parameters = [
	{ pitch: 0.5, formant: 1, squash: 0 },
	{ pitch: 1.5, formant: 1, squash: 0 },
	{ pitch: 1, formant: 1.2, squash: 0.2 },
	{ pitch: 0.8, formant: 0.8, squash: 0.5 },
].map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.fround(v)])));
const input = parameters.map((pitch) => ({ effects: { pitch }, samples }));
const inputPath = join(directory, 'input.json'),
	outputPath = join(directory, 'output.json');
await writeFile(inputPath, JSON.stringify(input));
execFileSync(exe, ['--voice-effect-probe', '--voice-test-config', inputPath, '--voice-test-output', outputPath], {
	windowsHide: true,
	timeout: 60000,
});
const results = JSON.parse(await readFile(outputPath, 'utf8'));
const reports = [];
for (const [index, parametersForCase] of parameters.entries()) {
	const processor = new Implementation();
	const parametersForWorklet = Object.fromEntries(
		Object.entries(parametersForCase).map(([k, v]) => [k, new Float32Array([v])])
	);
	const expected = [];
	for (let offset = 0; offset < samples.length; offset += 128) {
		const mono = Float32Array.from(samples.slice(offset, offset + 128), ([l, r]) => Math.fround((l + r) * 0.5));
		const wet = new Float32Array(128);
		processor.process([[mono]], [[wet]], parametersForWorklet);
		for (let n = 0; n < 128; n++) {
			const blend = Math.max(0, Math.min(1, (offset + n - 2048) / 480));
			expected.push(samples[offset + n].map((dry) => Math.fround(dry * (1 - blend) + wet[n] * blend)));
		}
	}
	assert.equal(results[index].length, expected.length);
	let maxError = 0,
		squaredError = 0,
		energy = 0;
	for (let n = 0; n < expected.length; n++)
		for (let ch = 0; ch < 2; ch++) {
			const actual = results[index][n][ch],
				want = expected[n][ch];
			assert.ok(Number.isFinite(actual));
			const error = Math.abs(actual - want);
			maxError = Math.max(maxError, error);
			squaredError += error ** 2;
			energy += want ** 2;
		}
	const relativeRmsError = Math.sqrt(squaredError / Math.max(1e-12, energy));
	assert.ok(
		maxError < 0.0001 && relativeRmsError < 0.01,
		JSON.stringify({ parametersForCase, maxError, relativeRmsError })
	);
	reports.push({ parameters: parametersForCase, samples: expected.length, maxError, relativeRmsError, passed: true });
}
const report = {
	passed: true,
	source: 'v3.2.62 sourceFilterProcessor.ts',
	sourceSha256: createHash('sha256')
		.update(await readFile(source))
		.digest('hex'),
	executableSha256: createHash('sha256')
		.update(await readFile(exe))
		.digest('hex'),
	audioSource: 'Generated test signal only',
	cases: reports,
};
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, directory, cases: reports }));
