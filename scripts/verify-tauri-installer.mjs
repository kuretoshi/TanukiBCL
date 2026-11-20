// Verify a published installer without making another full resource/model copy.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rustResourcePaths } from './tauri-rust-resources.mjs';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const installer = join(root, `dist-tauri/TanukiBCL-Tauri-Beta-Setup-${version}.exe`);
const seven = 'C:/Program Files/7-Zip/7z.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(path) {
    if ((await stat(path)).isFile()) return [path];
    const rows = [];
    for (const item of await readdir(path)) rows.push(...await files(join(path, item)));
    return rows;
}
const prepared = join(root, 'out/tauri-backend');
const expected = [];
for (const name of rustResourcePaths) expected.push(...await files(join(prepared, name)));
const listing = execFileSync(seven, ['l', '-slt', installer], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
const entries = listing.split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7).replaceAll('\\', '/'));
const backend = expected.map(file => `backend/${relative(prepared, file).replaceAll('\\', '/')}`);
assert.deepEqual(entries.filter(path => path.startsWith('backend/')).sort(), backend.sort());
assert(entries.includes('tanuki-bcl-tauri.exe'));
assert(!entries.some(path => /node_modules|tanuki-node|TbclSnapshotReader|TbclSnrReader|\.deps\.json|\.runtimeconfig\.json/i.test(path)));
const extract = name => execFileSync(seven, ['e', '-so', installer, name], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
for (const file of expected) {
    const name = `backend/${relative(prepared, file).replaceAll('\\', '/')}`;
    assert.equal(sha(extract(name)), sha(await readFile(file)), `Installer resource differs: ${name}`);
}
const executable = await readFile(join(root, 'src-tauri/target/release/tanuki-bcl-tauri.exe'));
// Tauri patches UNK -> NSS while bundling, then restores the build executable.
// Allow exactly that one fixed marker; every other byte must match the build.
const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const markerAt = executable.indexOf(marker);
assert(markerAt >= 0 && executable.lastIndexOf(marker) === markerAt);
const bundledExecutable = Buffer.from(executable);
bundledExecutable.write('__TAURI_BUNDLE_TYPE_VAR_NSS', markerAt, 'ascii');
assert.equal(sha(extract('tanuki-bcl-tauri.exe')), sha(bundledExecutable));
const metadata = JSON.parse(extract('backend/release-base.json').toString('utf8'));
assert.equal(metadata.betaVersion, version);
assert.deepEqual(metadata, JSON.parse(await readFile(join(root, 'src-tauri/release-base.json'), 'utf8')));
const cargo = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
assert(cargo.includes(`version = "${version}"`));
const installerSource = await readFile(join(root, 'src-tauri/target/release/nsis/x64/installer.nsi'), 'utf8');
assert(installerSource.includes('!define BUNDLEID "work.kuretoshi.tanukibcl.tauri.beta"'));
assert(installerSource.includes('!define INSTALLMODE "currentUser"'));
const checksum = sha(await readFile(installer));
assert.equal((await readFile(`${installer}.sha256`, 'utf8')).split(/\s/)[0], checksum);
const report = { passed: true, version, baseVersion: metadata.baseVersion, installerSha256: checksum, installerBytes: (await stat(installer)).size,
    executableSha256: sha(bundledExecutable), buildExecutableSha256: sha(executable), nsisBundleTypeMarkerVerified: true,
    verifiedBackendFiles: expected.length, allPackagedResourcesMatched: true,
    portableResourceCopyCreated: false, physicalMicrophoneTested: false, liveGameLobbyExitTested: false };
await writeFile(join(root, `docs/validation-rust-package-${version.replace('-tauri-beta.', '-beta')}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
