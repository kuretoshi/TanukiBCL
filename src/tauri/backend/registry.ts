// Registry discovery without the Electron-specific registry-js binary.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const HKEY = { HKEY_CLASSES_ROOT: 'HKEY_CLASSES_ROOT', HKEY_CURRENT_USER: 'HKEY_CURRENT_USER' };
function query(root: string, key: string): string {
	try {
		return execFileSync(
			join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
			['query', `${root}\\${key}`],
			{
				windowsHide: true,
				encoding: 'utf8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}
		);
	} catch {
		return '';
	}
}
function enumerateValues(root: string, key: string) {
	return query(root, key)
		.split(/\r?\n/)
		.flatMap((line) => {
			const match = line.match(/^\s+(.+?)\s{2,}(REG_\w+)\s*(.*)$/);
			return match ? [{ name: match[1], type: match[2], data: match[3] }] : [];
		});
}
function enumerateKeys(root: string, key: string) {
	const prefix = `${root}\\${key}\\`;
	return query(root, key)
		.split(/\r?\n/)
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length));
}
export default { HKEY, enumerateValues, enumerateKeys };
