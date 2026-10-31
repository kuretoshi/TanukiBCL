import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import console from 'node:console';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { setTimeout, clearTimeout } from 'node:timers';

const directory = resolve(process.env.TANUKI_DSP_CACHE ?? '.cache/source-filter-continuity');
await mkdir(directory, { recursive: true });
const sourcePath = 'src/renderer/voice/sourceFilterProcessor.ts';
const source = await readFile(sourcePath, 'utf8');
const sourceHash = (source) => createHash('sha256').update(source).digest('hex');

async function load(source, rate) {
	const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022' });
	let Processor;
	const scope = {
		sampleRate: rate,
		AudioWorkletProcessor: class {
			port = {};
		},
		registerProcessor: (_, value) => {
			Processor = value;
		},
	};
	// Keep native V8 Math/typed-array intrinsics: a vm proxy realm distorts DSP timings.
	new Function('module', 'globalThis', `${code}\nmodule.exports.registerSourceFilterProcessor();`)(
		{ exports: {} },
		scope
	);
	return { Processor };
}

function voiced(rate, seconds = 2) {
	const data = new Float32Array(rate * seconds),
		harmonics = [];
	for (let f = 120; f < Math.min(6000, rate / 2); f += 120)
		harmonics.push([f, 0.03 + Math.exp(-(((f - 700) / 200) ** 2)) + 0.8 * Math.exp(-(((f - 1800) / 300) ** 2))]);
	let peak = 0;
	for (let i = 0; i < data.length; i++) {
		let value = 0;
		for (const [f, amplitude] of harmonics) value += amplitude * Math.sin((2 * Math.PI * f * i) / rate);
		data[i] = value;
		peak = Math.max(peak, Math.abs(value));
	}
	for (let i = 0; i < data.length; i++) data[i] *= 0.25 / peak;
	return data;
}

function render(Processor, input, parameters, change) {
	const processor = new Processor(),
		output = new Float32Array(input.length);
	const block = new Float32Array(128),
		result = new Float32Array(128);
	const values = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, new Float32Array([value])]));
	for (let i = 0; i < input.length; i += 128) {
		block.fill(0);
		block.set(input.subarray(i, i + 128));
		if (change) change(i, values);
		assert.equal(processor.process([[block]], [[result]], values), true);
		output.set(result.subarray(0, Math.min(128, input.length - i)), i);
	}
	return { output, processor };
}

function metrics(output, rate) {
	let power = 0,
		peak = 0,
		maxStep = 0;
	const energies = [];
	for (let i = rate / 2; i < output.length; i++) {
		const value = output[i];
		assert.ok(Number.isFinite(value));
		power += value * value;
		peak = Math.max(peak, Math.abs(value));
		maxStep = Math.max(maxStep, Math.abs(value - output[i - 1]));
	}
	for (let start = rate; start + 2048 < output.length; start += 2048) {
		let energy = 0;
		for (let i = start; i < start + 2048; i++) energy += output[i] ** 2;
		energies.push(Math.sqrt(energy / 2048));
	}
	return {
		rms: Math.sqrt(power / (output.length - rate / 2)),
		peak,
		maxStep,
		minWindowRms: Math.min(...energies),
		maxWindowRms: Math.max(...energies),
	};
}

function benchmark(Processor, input, peers, rate) {
	const processors = Array.from({ length: peers }, () => new Processor());
	const values = {
		pitch: new Float32Array([2 ** -0.5]),
		formant: new Float32Array([1]),
		squash: new Float32Array([0]),
	};
	const block = new Float32Array(128),
		result = new Float32Array(128),
		durations = [];
	for (let i = 0; i + 128 < input.length; i += 128) {
		block.set(input.subarray(i, i + 128));
		const start = performance.now();
		for (const processor of processors) processor.process([[block]], [[result]], values);
		if (i > rate / 2) durations.push(performance.now() - start);
	}
	durations.sort((a, b) => a - b);
	return {
		peers,
		quantumMs: 128000 / rate,
		meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
		p95Ms: durations[Math.floor(durations.length * 0.95)],
		p99Ms: durations[Math.floor(durations.length * 0.99)],
		maxMs: durations.at(-1),
	};
}

async function inspect(source) {
	const rate = 48000,
		fixture = voiced(rate),
		{ Processor } = await load(source, rate);
	const rows = [];
	for (const pitch of [0.5, 2 ** -0.5, 1, 2 ** 0.5, 2]) {
		const { output } = render(Processor, fixture, { pitch, formant: 1, squash: 0 });
		rows.push({ pitch, ...metrics(output, rate) });
		assert.ok(rows.at(-1).rms > 0.001 && rows.at(-1).peak < 1);
		assert.ok(
			rows.at(-1).minWindowRms > rows.at(-1).maxWindowRms * 0.6,
			'a sustained vowel has no periodic near-silent dropouts'
		);
		if (pitch === 1) {
			let error = 0;
			for (let i = rate; i < output.length; i++) error = Math.max(error, Math.abs(output[i] - fixture[i - 2048]));
			assert.ok(error < 1e-6, 'unity retains the fixed 2048-sample latency and source waveform');
		}
	}
	const transitions = render(Processor, fixture, { pitch: 1, formant: 1, squash: 0 }, (i, values) => {
		values.pitch[0] = i < rate / 2 ? 1 : i < rate ? 0.5 : i < rate * 1.5 ? 2 : 1;
	});
	const stopped = new Processor();
	stopped.port.onmessage({ data: 'stop' });
	assert.equal(stopped.process([], [[new Float32Array(128)]], {}), false);
	const silence = render(Processor, new Float32Array(rate), { pitch: 0.5, formant: 1.7, squash: 1 });
	assert.ok(silence.output.every((value) => value === 0));
	const bench = [1, 4, 8].map((peers) => benchmark(Processor, fixture, peers, rate));
	return { sourceSha256: sourceHash(source), rows, transitions: metrics(transitions.output, rate), bench };
}

const current = await inspect(source);
let baseline;
async function compareSource(original) {
	const comparisons = [];
	for (const rate of [16000, 44100, 48000]) {
		const input = voiced(rate, 1),
			before = await load(original, rate),
			after = await load(source, rate);
		for (const pitch of [0.5, 2 ** -0.5, 1, 2 ** 0.5, 2]) {
			const parameters = { pitch, formant: 1, squash: 0 };
			const a = render(before.Processor, input, parameters).output,
				b = render(after.Processor, input, parameters).output;
			let maxError = 0;
			for (let i = 0; i < a.length; i++) maxError = Math.max(maxError, Math.abs(a[i] - b[i]));
			assert.ok(maxError < 1e-6, `DSP retains the published waveform at ${rate}Hz, pitch${pitch}`);
			comparisons.push({ rate, pitch, maxError });
		}
	}
	return comparisons;
}
if (process.env.TANUKI_SOURCE_FILTER_BASELINE) {
	const original = await readFile(process.env.TANUKI_SOURCE_FILTER_BASELINE, 'utf8');
	baseline = await inspect(original);
	current.comparisons = await compareSource(original);
}
async function inspectBridge() {
	const bundled = await build({
		entryPoints: ['src/renderer/voice/sourceFilterEffect.ts'],
		bundle: true,
		format: 'iife',
		globalName: 'effects',
		write: false,
		plugins: process.env.TANUKI_SOURCE_FILTER_EFFECT_BASELINE
			? [
					{
						name: 'before-bridge',
						setup(build) {
							build.onLoad({ filter: /sourceFilterEffect\.ts$/ }, async () => ({
								contents: await readFile(process.env.TANUKI_SOURCE_FILTER_EFFECT_BASELINE, 'utf8'),
								loader: 'ts',
							}));
						},
					},
				]
			: [],
	});
	const test = `${bundled.outputFiles[0].text}\n${voiced.toString()}\n(async()=>{
 const rows=[];
 for(const rate of [44100,48000])for(const mode of ['lower','higher','reopen','dispose-dry','dispose-fade']){
  const context=new OfflineAudioContext(1,rate,rate);await effects.prepareSourceFilter(context);
  const source=context.createBufferSource(),buffer=context.createBuffer(1,rate,rate),input=voiced(rate,1);
  buffer.getChannelData(0).set(input);source.buffer=buffer;source.connect(context.destination);source.start();
  let first=null;
  if(mode==='reopen'){
   first=effects.createSourceFilterEffect(context);effects.updateSourceFilterEffect(first,{pitch:2**.5,formant:1,squash:0});
   source.disconnect();source.connect(first.input);first.output.connect(context.destination);
  }
  const reset=first?context.suspend(.2):null,paused=context.suspend(.4),rendering=context.startRendering();
  if(reset){await reset;effects.disconnectProcessingEffect(first);source.disconnect();source.connect(context.destination);await context.resume();}
  await paused;
  const change=context.currentTime,fx=effects.createSourceFilterEffect(context),ready=2048/rate;
  effects.updateSourceFilterEffect(fx,{pitch:mode==='lower'?2**-.5:2**.5,formant:1,squash:0});
  source.disconnect();source.connect(fx.input);fx.output.connect(context.destination);
  let disposedAt=null;
  if(mode.startsWith('dispose')){
   const stopped=context.suspend(change+(mode==='dispose-dry'?ready/2:ready+.005));await context.resume();await stopped;
   disposedAt=context.currentTime;effects.disconnectProcessingEffect(fx);
  }
  await context.resume();const data=(await rendering).getChannelData(0);
  const rms=(samples,from,to)=>{const first=Math.round(from*rate),last=Math.round(to*rate);let sum=0;for(let i=first;i<last;i++)sum+=samples[i]**2;return Math.sqrt(sum/(last-first));};
  let error=0;for(let i=Math.round(change*rate);i<Math.round((change+.02)*rate);i++)error=Math.max(error,Math.abs(data[i]-input[i]));
  let fadeMin=Infinity;for(let t=change+ready;t<change+ready+.01;t+=.005)fadeMin=Math.min(fadeMin,rms(data,t,t+.005));
  const row={rate,mode,change,ready,rawRms:rms(input,change,change+.02),warmupRms:rms(data,change,change+.02),warmupError:error,fadeMin,steadyRms:rms(data,.7,.8),disposedAt};
  if(disposedAt!==null)row.disposedRms=rms(data,disposedAt+128/rate,.9);
  rows.push(row);if(disposedAt===null)effects.disconnectProcessingEffect(fx);
 }
 return rows;
})()`;
	const server = createServer((_, response) => response.end('<!doctype html>'));
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const origin = `http://127.0.0.1:${server.address().port}`,
		runner = resolve(directory, 'bridge-runner.cjs'),
		result = resolve(directory, 'bridge-result.json');
	await writeFile(
		runner,
		`const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setName('Tanuki-DSP-bridge-fixture');app.setPath('userData',${JSON.stringify(resolve(directory, 'browser-profile'))});app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false});await win.loadURL(${JSON.stringify(origin)});const rows=await win.webContents.executeJavaScript(${JSON.stringify(test)});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(rows,null,2));app.quit();}catch(error){console.error(error);app.exit(1);}});`
	);
	const child = spawn(electron, [runner], {
		windowsHide: true,
		env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const timeout = setTimeout(() => child.kill(), 30000);
	const status = await new Promise((done) => child.on('exit', done));
	clearTimeout(timeout);
	server.close();
	assert.equal(status, 0, stderr);
	const rows = JSON.parse(await readFile(result, 'utf8'));
	for (const row of rows) {
		if (row.disposedAt !== null)
			assert.equal(row.disposedRms, 0, `${row.mode} at ${row.rate}Hz cannot leave scheduled audio after dispose`);
		else {
			assert.ok(row.warmupError < 1e-6, `${row.rate}Hz/${row.mode}: raw speech bridges the cold STFT window`);
			assert.ok(
				row.fadeMin > row.steadyRms * 0.1,
				`${row.rate}Hz/${row.mode}: ready-to-wet crossfade contains no silent gap`
			);
			assert.ok(row.steadyRms > 0.001, `${row.rate}Hz/${row.mode}: wet speech remains audible`);
		}
	}
	return rows;
}
if (!process.argv.includes('--report-only')) current.bridge = await inspectBridge();
current.sources = {};
for (const path of ['src/renderer/voice/sourceFilterEffect.ts', 'src/renderer/voice/effectGain.ts'])
	current.sources[path] = sourceHash(await readFile(path, 'utf8'));
await writeFile(
	resolve(directory, process.env.TANUKI_DSP_REPORT_NAME ?? 'continuity.json'),
	JSON.stringify({ current, baseline }, null, 2)
);
console.log(
	JSON.stringify(
		{
			sustainedProfiles: current.rows.length,
			bridgeCases: current.bridge?.length ?? 0,
			maxWarmupError: Math.max(
				0,
				...(current.bridge ?? []).filter((row) => row.disposedAt === null).map((row) => row.warmupError)
			),
			publicWaveformComparisons: current.comparisons?.length ?? 0,
			evidence: resolve(directory, process.env.TANUKI_DSP_REPORT_NAME ?? 'continuity.json'),
		},
		null,
		2
	)
);
console.log(
	'PASS DSP continuity: voiced fixture, unity latency, sustained output, transitions, silence, stop; 44.1/48kHz cold-window bridge, crossfade and disposal'
);
