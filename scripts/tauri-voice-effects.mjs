import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(import.meta.dirname, '..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
export async function prepareVoiceEffects() {
	await prepareChime();
	await prepareChime('radio','radio_on.wav');
	const original = join(root, 'static/sounds/reverb.ogx');
	const directory = join(root, 'src-tauri/audio');
	const destination = join(directory, 'reverb-48000.f32');
	const manifest = join(directory, 'reverb.json');
	const sourceSha256 = sha(await readFile(original));
	try {
		const metadata = JSON.parse(await readFile(manifest, 'utf8'));
		if (metadata.sourceSha256 === sourceSha256 && metadata.sha256 === sha(await readFile(destination))) return metadata;
	} catch {
		/* regenerate from the pinned release impulse */
	}
	const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', original, '-f', 'f32le', '-ar', '48000', '-ac', '2', '-'], {
		windowsHide: true,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (pcm.length % 8 || pcm.length > 48000 * 8 * 4) throw new Error('Unexpected impulse response dimensions');
	let power = 0;
	for (let n = 0; n < pcm.length; n += 4) power += pcm.readFloatLE(n) ** 2;
	power = Math.max(0.000125, Math.sqrt(power / (pcm.length / 4)));
	const scale = (0.00125 * (44100 / 48000)) / power;
	for (let n = 0; n < pcm.length; n += 4) pcm.writeFloatLE(pcm.readFloatLE(n) * scale, n);
	const metadata = {
		source: 'static/sounds/reverb.ogx',
		sourceSha256,
		sampleRate: 48000,
		channels: 2,
		frames: pcm.length / 8,
		normalization: 'Web Audio ConvolverNode RMS normalization',
		scale,
		sha256: sha(pcm),
	};
	await mkdir(directory, { recursive: true });
	await writeFile(destination, pcm);
	await writeFile(manifest, JSON.stringify(metadata, null, 2) + '\n');
	return metadata;
}
async function prepareChime(name='chime',file='chime.mp3') {
	const source = join(root, 'static/sounds',file);
	const destination = join(root, `src-tauri/audio/${name}-48000.f32`);
	const manifest = join(root, `src-tauri/audio/${name}.json`);
	const sourceSha256 = sha(await readFile(source));
	try {
		const previous = JSON.parse(await readFile(manifest, 'utf8'));
		if (previous.sourceSha256 === sourceSha256 && previous.sha256 === sha(await readFile(destination))) return;
	} catch {
		/* regenerate from the release chime */
	}
	const pcm = execFileSync(
		'ffmpeg',
		['-v', 'error', '-i', source, '-t', '4', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-'],
		{ windowsHide: true, maxBuffer: 1024 * 1024 }
	);
	if (pcm.length % 4 || pcm.length > 48000 * 4 * 4) throw new Error('Unexpected test chime dimensions');
	await mkdir(join(root, 'src-tauri/audio'), { recursive: true });
	await writeFile(destination, pcm);
	await writeFile(
		manifest,
		JSON.stringify(
			{
				source: 'static/sounds/'+file,
				sourceSha256,
				sampleRate: 48000,
				channels: 1,
				frames: pcm.length / 4,
				sha256: sha(pcm),
			},
			null,
			2
		) + '\n'
	);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	console.log(await prepareVoiceEffects());
