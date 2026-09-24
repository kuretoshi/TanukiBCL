import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';

export function readTohLayout(pid: number): Promise<unknown> {
	const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
	return new Promise((resolve, reject) => {
		execFile(
			join(root, 'out', 'debug-reader', 'SnrRoleReader.exe'),
			[String(pid), '--toh'],
			{ windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				try {
					const result = JSON.parse(stdout);
					if (error || result.status !== 'ok' || result.pid !== pid)
						throw new Error(result.message || 'TOH4E読み取り失敗');
					resolve(result);
				} catch (error) {
					reject(error);
				}
			}
		);
	});
}
