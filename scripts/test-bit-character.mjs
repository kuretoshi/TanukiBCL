import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const mobile = resolve(process.env.BCL_MOBILE_REPO ?? '../mobile');
const dir = await mkdtemp(join(tmpdir(), 'tanuki-bit-'));
let id = 0;
async function load(file) {
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	const path = join(dir, `${id++}.mjs`);
	await writeFile(path, result.outputFiles[0].contents);
	return import(pathToFileURL(path));
}
try {
	const { BitVoiceKernel, createBitVoiceEffect } = await load('src/renderer/voice/bitVoiceEffect.ts');
	const web = await load(join(mobile, 'src/app/voice/bitVoiceEffect.ts'));
	const { bitCharacterStage, validBitCharacter } = await load('src/common/BitCharacterState.ts');
	const { validAddonChannels } = await load('src/common/AddonLink.ts');
	const player = { id: 1, isDead: false, disconnected: false };
	const state = { mod: 'NoS', nosAddonIds: ['tanuki.bcl.roles'], gameState: 1, nosBitCharacters: [{ playerId: 1, stage: 0 }] };
	assert.equal(bitCharacterStage(state, player), 0);
	for (const phase of [0, 2, 3, 4])
		assert.equal(bitCharacterStage({ ...state, gameState: phase }, player), -1, 'meeting/menu/lobby bypass');
	assert.equal(
		bitCharacterStage({ ...state, nosBitCharacters: [{ playerId: 1, stage: 6 }] }, player),
		-1,
		'final stage restores'
	);
	assert.equal(
		bitCharacterStage({ ...state, nosBitCharacters: [{ playerId: 1, stage: 5 }] }, player),
		5,
		'64bit remains active'
	);
	assert.equal(bitCharacterStage(state, { ...player, isDead: true }), -1);
	assert.equal(bitCharacterStage(state, { ...player, disconnected: true }), -1);
	assert.equal(
		bitCharacterStage({ ...state, nosBitCharacters: [state.nosBitCharacters[0], state.nosBitCharacters[0]] }, player),
		-1
	);
	for (const stage of [-1, 7, NaN, 1.5, '2', null]) assert(!validBitCharacter({ playerId: 1, stage }));
	const channels = Object.fromEntries(
		['heroes', 'portable', 'megaphones', 'dying', 'interviews', 'jamming', 'echoes', 'muted', 'speech'].map((k) => [
			k,
			[],
		])
	);
	assert(validAddonChannels(channels, Date.now()), 'older addon profiles accepted');
	assert(validAddonChannels({ ...channels, bits: state.nosBitCharacters }, Date.now()));
	assert(!validAddonChannels({ ...channels, bits: [{ playerId: 1, stage: 9 }] }, Date.now()));
	const input = Float32Array.from({ length: 48000 }, (_, i) => 0.18 * Math.sin((i * 2 * Math.PI * 220) / 48000));
	let previousError = Infinity;
	for (let stage = 0; stage < 6; stage++) {
		const output = new Float32Array(input.length),
			other = new Float32Array(input.length);
		new BitVoiceKernel().process(input, output, 48000, stage);
		new web.BitVoiceKernel().process(input, other, 48000, stage);
		assert.deepEqual(output, other, 'PC and mobile DSP identical');
		assert(output.every(Number.isFinite));
		assert(Math.max(...output) > 0.03, 'quiet speech remains audible');
		const error = output.reduce((s, v, i) => s + (v - input[i]) ** 2, 0) / output.length;
		assert(error < previousError, `quality improves at stage${stage}: ${error} >= ${previousError}`);
		previousError = error;
		const chunked = new Float32Array(input.length),
			kernel = new BitVoiceKernel();
		for (let i = 0; i < input.length; i += 127)
			kernel.process(input.subarray(i, i + 127), chunked.subarray(i, i + 127), 48000, stage);
		assert.deepEqual(chunked, output, 'sample-hold state survives worklet blocks');
	}
	const dry = new Float32Array(input.length);
	new BitVoiceKernel().process(input, dry, 48000, -1);
	assert.deepEqual(dry, input);
	const silent = new Float32Array(1000);
	new BitVoiceKernel().process(silent, silent, 48000, 0);
	assert(
		silent.every((x) => x === 0),
		'no DC noise at silence'
	);
	let code = '',
		registered,
		processor;
	const oldURL = URL.createObjectURL,
		oldRevoke = URL.revokeObjectURL,
		oldNode = globalThis.AudioWorkletNode;
	try {
		let blob;
		URL.createObjectURL = (b) => {
			blob = b;
			return 'blob:bit-test';
		};
		URL.revokeObjectURL = () => {};
		const context = {
			state: 'running',
			audioWorklet: {
				async addModule() {
					code = await blob.text();
				},
			},
			createGain() {
				return { connect() {}, disconnect() {} };
			},
		};
		globalThis.AudioWorkletNode = class {
			port = { postMessage() {}, close() {} };
			connect() {}
			disconnect() {}
		};
		const effect = createBitVoiceEffect(context);
		effect.update(0);
		await new Promise((r) => setTimeout(r, 0));
		effect.disconnect();
		vm.runInNewContext(code, {
			Math,
			Number,
			Float32Array,
			sampleRate: 48000,
			AudioWorkletProcessor: class {
				port = {};
			},
			registerProcessor(name, type) {
				registered = name;
				processor = new type();
			},
		});
		assert.equal(registered, 'tanuki-bit-voice', 'actual bundled worklet registers without external helpers');
		processor.port.onmessage({ data: 0 });
		const block = new Float32Array(128);
		assert(processor.process([[input.subarray(0, 128)]], [[block]]));
		assert(block.some((x) => x !== 0));
		processor.port.onmessage({ data: 'stop' });
		assert.equal(processor.process([], []), false);
	} finally {
		URL.createObjectURL = oldURL;
		URL.revokeObjectURL = oldRevoke;
		globalThis.AudioWorkletNode = oldNode;
	}
	await mkdir(resolve('.cache'), { recursive: true });
	await writeFile(
		resolve('.cache/bit-character-pcm.json'),
		JSON.stringify({
			input: Array.from(input.subarray(0, 480)),
			expected: Array.from(
				(() => {
					const o = new Float32Array(480);
					new BitVoiceKernel().process(input.subarray(0, 480), o, 48000, 0);
					return o;
				})()
			),
		})
	);
	console.log(
		'PASS bit voice: all6stages including64bit, progressive quality, quiet speech, silence, chunking, PC/mobile parity, actual worklet, meeting/death/final bypass and transport validation'
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}
