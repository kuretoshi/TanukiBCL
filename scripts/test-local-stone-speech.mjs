import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'tanuki-local-speech-'));
const root = join(process.env.LOCALAPPDATA, 'TanukiBCL/Speech/sherpa-2.0.2');
const preference = join(root, 'preferences.json');
let previous;
try {
	previous = await readFile(preference);
} catch {}
let worker;
function wavePcm(buffer) {
	let at = 12;
	while (at + 8 <= buffer.length) {
		const size = buffer.readUInt32LE(at + 4);
		if (buffer.toString('ascii', at, at + 4) === 'data') return buffer.subarray(at + 8, at + 8 + size);
		at += 8 + size + (size % 2);
	}
	throw Error('WAV');
}
try {
	const result = await build({
		entryPoints: ['src/main/localStoneSpeech.ts', 'src/common/VoiceStoneAudio.ts', 'src/common/HeroSpeech.ts'],
		outdir: dir,
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	});
	for (const file of result.outputFiles) {
		await mkdir(dirname(file.path), { recursive: true });
		await writeFile(file.path.replace(/\.js$/, '.mjs'), file.contents);
	}
	const { localSpeechStatus, setLocalSpeech, localStoneWorker } = await import(
		pathToFileURL(join(dir, 'main/localStoneSpeech.mjs'))
	).catch(async () => {
		const file = result.outputFiles.find((f) => f.path.includes('localStoneSpeech'));
		const target = join(dir, 'worker.mjs');
		await writeFile(target, file.contents);
		return import(pathToFileURL(target));
	});
	worker = localStoneWorker;
	assert(localSpeechStatus().available);
	if (!previous) assert(localSpeechStatus().enabled, 'Prepared shared model is the default');
	assert(setLocalSpeech(true));
	const audio = await readFile(join(root, '../evaluation/Microsoft_Haruka_Desktop-0.wav'));
	const pcm = wavePcm(audio);
	const common = result.outputFiles.find((f) => f.path.includes('VoiceStoneAudio'));
	const commonPath = join(dir, 'common.mjs');
	await writeFile(commonPath, common.contents);
	const { StonePcm } = await import(pathToFileURL(commonPath));
	const capture = new StonePcm();
	capture.append(
		Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768),
		16000
	);
	assert.equal(await worker.transcribe(capture.wav(), 8, AbortSignal.timeout(18000)), 'インポスター');
	const pid = worker.child.pid;
	assert.deepEqual(
		await Promise.all(Array.from({ length: 4 }, () => worker.transcribe(capture.wav(), 8, AbortSignal.timeout(18000)))),
		Array(4).fill('インポスター')
	);
	assert.equal(worker.child.pid, pid, 'One native worker serves concurrent role requests');
	const policyFile = result.outputFiles.find((f) => f.path.includes('HeroSpeech'));
	const policyPath = join(dir, 'policy.mjs');
	await writeFile(policyPath, policyFile.contents);
	const { heardTransformation, heardForbiddenWord } = await import(pathToFileURL(policyPath));
	for (const [file, kind, words] of [
		['Microsoft_Haruka_Desktop-6.wav', 'hero', ['変身']],
		['Microsoft_Haruka_Desktop-3.wav', 'ng', ['タスク']],
		['Microsoft_Haruka_Desktop-5.wav', 'ng', ['インポスター']],
	]) {
		const raw = wavePcm(await readFile(join(root, '../evaluation', file))),
			capture = new StonePcm();
		capture.append(
			Float32Array.from({ length: raw.length / 2 }, (_, i) => raw.readInt16LE(i * 2) / 32768),
			16000
		);
		const transcript = await worker.transcribeText(capture.wav(), AbortSignal.timeout(18000));
		assert(
			kind === 'hero' ? heardTransformation(transcript, words, true) : heardForbiddenWord(transcript, words, true),
			`shared ${kind} recognition: ${file}: ${JSON.stringify(transcript)}`
		);
	}
	assert.equal(worker.child.pid, pid, 'Stone, hero and NG share the same native model instance');
	const abort = new AbortController();
	abort.abort();
	assert.equal(await worker.transcribe(capture.wav(), 8, abort.signal), undefined);
	console.log(
		'PASS Electron local SenseVoice: existing shared model, Japanese compound, WAV bounds, cancellation and native process cleanup'
	);
} finally {
	worker?.close();
	if (previous) await writeFile(preference, previous);
	else await unlink(preference).catch(() => {});
	await rm(dir, { recursive: true, force: true });
}
