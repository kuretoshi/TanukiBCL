import { statSync } from 'node:fs';
import { join } from 'node:path';

// File checks only: probing prerequisites must not load a DLL or recognition model.
export const vcRuntimeDlls = ['msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
function isRuntimeFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
export function hasVcRuntime(directories: string[], isFile: (path: string) => boolean = isRuntimeFile): boolean {
	return vcRuntimeDlls.every((dll) => directories.some((directory) => isFile(join(directory, dll))));
}
let cached: { key: string; until: number; installed: boolean } | undefined;
export function vcRuntimeInstalled(runtimeDirectory: string, refresh = false): boolean {
	if (process.platform !== 'win32') return false;
	const windows = process.env.SystemRoot ?? process.env.WINDIR;
	const system = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
	const directories = windows ? [runtimeDirectory, join(windows, system)] : [runtimeDirectory];
	const key = directories.join('|');
	if (!refresh && cached?.key === key && cached.until > Date.now()) return cached.installed;
	const installed = hasVcRuntime(directories);
	cached = { key, installed, until: Date.now() + 5000 };
	return installed;
}
