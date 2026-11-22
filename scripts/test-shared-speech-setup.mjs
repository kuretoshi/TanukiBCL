import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const temp = await mkdtemp(join(tmpdir(), 'tanuki-speech-setup-'));
const previous = process.env.LOCALAPPDATA;
globalThis.__testVcInstalled = false;
try {
	const result = await build({
		entryPoints: {
			status: 'src/main/localStoneSpeech.ts',
			probe: 'src/main/vcRuntime.ts',
			flow: 'src/common/SharedSpeechSetup.ts',
		},
		outdir: temp,
		platform: 'node',
		format: 'esm',
		bundle: true,
		write: false,
		plugins: [
			{
				name: 'runtime-presence',
				setup(b) {
					b.onResolve({ filter: /^\.\/vcRuntime$/ }, () => ({ path: 'presence', namespace: 'mock' }));
					b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
						contents: 'export const vcRuntimeInstalled=()=>globalThis.__testVcInstalled;',
					}));
				},
			},
		],
	});
	for (const file of result.outputFiles)
		await writeFile(join(temp, basename(file.path, '.js') + '.mjs'), file.contents);
	const probe = await import(pathToFileURL(join(temp, 'probe.mjs')));
	const flow = await import(pathToFileURL(join(temp, 'flow.mjs')));
	assert(!probe.hasVcRuntime(['runtime', 'System32'], () => false));
	assert(!probe.hasVcRuntime(['runtime', 'System32'], (p) => !p.endsWith('msvcp140_1.dll')));
	assert(probe.hasVcRuntime(['runtime', 'System32'], (p) => p.startsWith('System32')));
	assert(probe.hasVcRuntime(['runtime', 'System32'], (p) => p.startsWith('runtime')));
	assert(!probe.hasVcRuntime(['System32'], (p) => p.startsWith('SysWOW64')));
	assert.equal(flow.speechSetupDownloadUrl({ runtimeInstalled: false }), flow.vcRuntimeDownloadPage);
	assert.equal(flow.speechSetupDownloadUrl({ runtimeInstalled: true }), flow.sharedSpeechInstaller);
	process.env.LOCALAPPDATA = temp;
	const service = await import(pathToFileURL(join(temp, 'status.mjs')));
	const root = service.localSpeechRoot();
	for (const name of [
		'runtime/TanukiSpeechWorker.exe',
		'runtime/sherpa-onnx-c-api.dll',
		'runtime/onnxruntime.dll',
		'sensevoice/model.int8.onnx',
		'sensevoice/tokens.txt',
		'silero_vad.onnx',
	]) {
		const file = join(root, name);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, '');
	}
	assert.deepEqual(service.localSpeechStatus(true), {
		runtimeInstalled: false,
		modelAvailable: true,
		available: false,
		enabled: false,
		error: '',
	});
	const wav = Buffer.alloc(3244, 1);
	wav.write('RIFF');
	wav.writeUInt32LE(3236, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(16000, 24);
	wav.writeUInt32LE(32000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(3200, 40);
	assert.equal(await service.localStoneWorker.transcribe(wav, 8, AbortSignal.timeout(100)), undefined);
	assert.equal(service.localStoneWorker.child, undefined, 'Missing VC runtime must not start a recognition process');
	globalThis.__testVcInstalled = true;
	assert(service.localSpeechStatus(true).enabled, 'Recheck after installation enables the prepared model');
	await writeFile(join(root, 'preferences.json'), '{"enabled":false}');
	assert(!service.localSpeechStatus(true).enabled, 'Recheck preserves explicit opt-out');
	console.log(
		'PASS shared setup: missing/partial/x86-only runtime, Microsoft routing, post-install recheck, no worker, preference preservation'
	);
} finally {
	if (previous === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = previous;
	delete globalThis.__testVcInstalled;
	await rm(temp, { recursive: true, force: true });
}
