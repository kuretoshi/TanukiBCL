import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** The developer's protocol writes only the one-time RequireUpdate enable flag. */
export function resolveNosSnapshot(pid: number, command: 'layout' | 'palette' = 'layout'): Promise<unknown> {
	const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
	const executable = join(root, 'out', 'nos-reader', 'TbclSnapshotReader.exe');
	if (!existsSync(executable)) return Promise.reject(new Error('NoS読み取りツールが見つかりません。'));
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			[command, String(pid)],
			{ windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				try {
					const response = JSON.parse(stdout);
					if (error || response.status !== 'ok' || response.pid !== pid)
						throw new Error(response.message || 'NoS読み取り位置の取得に失敗しました。');
					resolve(response.metadata);
				} catch (error) {
					reject(error);
				}
			}
		);
	});
}
