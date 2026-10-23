// Run inside the packaged Electron runtime, resolving dependencies from app.asar.
// A missing native dependency must prevent publication of an installer.
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

function verify(appOutDir, executable, version) {
	const archive = join(resolve(appOutDir), 'resources', 'app.asar');
	const source = `
const assert = require('node:assert/strict');
const path = require('node:path');
const base = ${JSON.stringify(archive)};
assert.equal(require(path.join(base, 'package.json')).version, ${JSON.stringify(version)});
for (const name of ['registry-js', 'memoryjs', 'node-keyboard-watcher']) {
  require(path.join(base, 'node_modules', name));
  console.log('PASS packaged native module:', name);
}
require(path.join(base, 'node_modules', 'electron-overlay-window', 'prebuilds', 'win32-' + process.arch, 'electron-overlay-window.node'));
console.log('PASS packaged overlay native binding');
const registry = require(path.join(base, 'node_modules', 'registry-js'));
assert.ok(Array.isArray(registry.enumerateKeys(registry.HKEY.HKEY_CURRENT_USER, 'Software')));
console.log('PASS packaged registry read');
`;
	const result = spawnSync(join(resolve(appOutDir), executable), ['-e', source], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		encoding: 'utf8',
		windowsHide: true,
		timeout: 30000,
	});
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error || result.status !== 0) throw result.error ?? new Error('Packaged native module check failed');
}

module.exports = async (context) => {
	if (process.platform === 'win32' && context.electronPlatformName === 'win32')
		verify(
			context.appOutDir,
			context.packager.platformSpecificBuildOptions.executableName + '.exe',
			context.packager.appInfo.version
		);
};
module.exports.verify = verify;

if (require.main === module) verify(process.argv[2], process.argv[3], process.argv[4]);
