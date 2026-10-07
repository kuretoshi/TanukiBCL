// Smoke test: verifies the externalized CommonJS dependencies load under
// Node's ESM loader the same way the packaged main process imports them
// (default import + destructure). Catches CJS/ESM interop regressions — e.g.
// "Named export 'X' not found" — at build time instead of at runtime.
import { basename } from 'node:path';
const checks = [
	['electron-log/main.js', ['transports', 'functions']],
	[
		'memoryjs',
		[
			'findModule',
			'getProcesses',
			'openProcess',
			'readBuffer',
			'readMemory',
			'findPattern',
			'virtualAllocEx',
			'writeBuffer',
			'writeMemory',
			'getProcessPath',
		],
	],
	['electron-overlay-window', ['overlayWindow']],
	['node-keyboard-watcher', ['keyboardWatcher']],
	['registry-js', ['enumerateValues', 'enumerateKeys', 'HKEY']],
	['vdf-parser', ['parse']],
	['electron-devtools-installer', ['default', 'installExtension', 'REACT_DEVELOPER_TOOLS']],
];

function verifyMemoryRead(memory) {
	const handle = memory.openProcess(process.pid);
	try {
		const executable = memory.findModule(basename(process.execPath), process.pid);
		const bytes = memory.readBuffer(handle.handle, executable.modBaseAddr, 2);
		if (bytes.toString() !== 'MZ') throw new Error('readBuffer returned an invalid executable header');
		console.log('ok memoryjs readBuffer (own process)');
	} finally {
		memory.closeProcess(handle.handle);
	}
}

let failed = false;
for (const [name, keys] of checks) {
	try {
		const mod = await import(name);
		const exported = mod.default ?? mod;
		const missing = keys.filter((k) => !(k in exported));
		if (missing.length > 0) {
			console.error(`FAIL ${name}: missing export(s): ${missing.join(', ')}`);
			failed = true;
			continue;
		}
		console.log(`ok ${name}`);
		if (name === 'memoryjs') verifyMemoryRead(exported);
	} catch (err) {
		console.error(`FAIL ${name}: ${err.message}`);
		failed = true;
	}
}

if (failed) {
	process.exit(1);
}
console.log('ESM interop check passed');
