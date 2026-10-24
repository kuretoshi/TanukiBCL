import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
if (process.platform !== 'win32') {
	console.log('NoS host speech recognition is supported on Windows.');
} else if (['vosk.js', 'model-ja.tar.gz'].some((name) => !existsSync(new URL(`src/renderer/public/speech/${name}`, root)))) {
	const result = spawnSync(
		'powershell.exe',
		['-NoProfile', '-File', fileURLToPath(new URL('scripts/prepare-hero-speech.ps1', root))],
		{ stdio: 'inherit', windowsHide: true }
	);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
