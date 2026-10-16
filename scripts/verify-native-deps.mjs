import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const target = process.argv[2] ?? 'source';
const roots = {
	source: 'node_modules',
	dist: 'dist/win-unpacked/resources/app.asar.unpacked/node_modules',
	'dist-lite': 'dist-lite/win-unpacked/resources/app.asar.unpacked/node_modules',
};
if (!(target in roots)) throw new Error(`Unknown native dependency target: ${target}`);

const binary = resolve(roots[target], 'registry-js/build/Release/registry.node');
if (!existsSync(binary)) {
	throw new Error(`Required Windows registry addon is missing: ${binary}\nRun npm rebuild registry-js, then rebuild the installer.`);
}

// Loading the addon also catches an incompatible or corrupt binary.
const require = createRequire(import.meta.url);
require(binary);
console.log(`Verified registry-js native addon in ${target}`);
