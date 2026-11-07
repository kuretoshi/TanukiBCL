import { mkdir, readFile, writeFile, cp, access, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const sha = 'f1dcc9cca460630f81ea8f71794f69c80bed6556d2a4e6237b5785e1d2dff34b';
export async function prepareNativeSpeech(output) {
	const root = resolve(import.meta.dirname, '..'),
		cache = join(root, '.cache/hero-speech/native');
	await mkdir(cache, { recursive: true });
	const zip = join(cache, 'vosk-win64-0.3.45.zip');
	let bytes;
	try {
		bytes = await readFile(zip);
	} catch {
		const response = await fetch(
			'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip'
		);
		if (!response.ok) throw new Error(`Vosk download: ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
		await writeFile(zip, bytes);
	}
	if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('Native Vosk checksum mismatch');
	const tar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe');
	const extract = (args) => {
		const result = spawnSync(tar, args, { stdio: 'inherit', windowsHide: true });
		if (result.status !== 0) throw new Error('Native speech extraction failed');
	};
	try{await access(join(cache,'vosk-win64-0.3.45/libvosk.dll'));}catch{extract(['-xf', zip, '-C', cache]);}
	const dest = join(output, 'rust-speech');
	await mkdir(dest, { recursive: true });
	for (const name of ['libvosk.dll', 'libstdc++-6.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll'])
		await cp(join(cache, 'vosk-win64-0.3.45', name), join(dest, name));
	try {
		await access(join(dest, 'model/am/final.mdl'));
	} catch {
		let model = join(root, 'src/renderer/public/speech/model-ja.tar.gz');
		try {
			await access(model);
		} catch {
			model = join(root, 'out/tauri-renderer/speech/model-ja.tar.gz');
		}
		try{await access(model);extract(['-xzf', model, '-C', dest]);}
		catch(error){if(error.code!=='ENOENT')throw error;
			// A clean Rust build downloads the native model directly; browser
			// Vosk/React assets are never required by this runtime.
			const archive=join(root,'.cache/hero-speech/vosk-model-small-ja-0.22.zip');let bytes;
			try{bytes=await readFile(archive);}catch(error){if(error.code!=='ENOENT')throw error;const response=await fetch('https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip');if(!response.ok)throw Error(`Japanese model download: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());await writeFile(archive,bytes);}
			if(createHash('sha256').update(bytes).digest('hex')!=='efa092d280153a77615e9e0c7d7283e93e600de3d19d3bec686c57ef19d52eac')throw Error('Japanese model checksum mismatch');
			extract(['-xf',archive,'-C',dest]);await rename(join(dest,'vosk-model-small-ja-0.22'),join(dest,'model'));
		}
	}
	await cp(join(root, 'resources/tauri-speech/Apache-2.0.txt'), join(dest, 'Apache-2.0.txt'));
	await cp(join(root,'resources/tauri-speech/GCC-RUNTIME-EXCEPTION.txt'),join(dest,'GCC-RUNTIME-EXCEPTION.txt'));
	await cp(join(root,'LICENSE'),join(dest,'GPL-3.0.txt'));
	await writeFile(
		join(dest, 'provenance.json'),
		JSON.stringify(
			{
				engine: 'Vosk',
				version: '0.3.45',
				archiveSha256: sha,
				source: 'https://github.com/alphacep/vosk-api/releases/tag/v0.3.45',
				model: 'vosk-model-small-ja-0.22',
				license: 'Apache-2.0',
			},
			null,
			2
		) + '\n'
	);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
	await prepareNativeSpeech(resolve('out/tauri-backend'));
