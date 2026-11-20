// Exercise the actual Vosk loader without microphone/audio-device access.
// Reuse the installed/prepared model; never copy it for a path fixture.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'win32', 'Windows resource path regression');
const root = resolve(import.meta.dirname, '..');
const executable = resolve(process.argv[2] ?? join(root, 'src-tauri/target/release/tanuki-bcl-tauri.exe'));
const resources = await realpath(resolve(process.argv[3] ?? join(root, 'out/tauri-backend/rust-speech')));
const directory = join(root, '.tools/speech-path-fix');
await mkdir(directory, { recursive: true });
const verbatim = resources.startsWith('\\\\') ? `\\\\?\\UNC\\${resources.slice(2)}` : `\\\\?\\${resources}`;
for (const [name, path] of [['plain', resources], ['verbatim', verbatim]]) {
    const output = join(directory, `${name}-after.json`);
    const result = spawnSync(executable, [
        '--voice-speech-probe', '--speech-resources', path, '--voice-test-output', output,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.nativeModelLoaded, true);
    assert.equal(report.passed, true);
    console.log(`PASS ${name}: real Japanese model loaded and decoder accepted silence`);
}
