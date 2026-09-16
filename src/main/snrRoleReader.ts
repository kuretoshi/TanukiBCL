import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export async function readSnrRoles(pid: number): Promise<unknown> {
	const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
	const executable = join(root, 'out', 'debug-reader', 'SnrRoleReader.exe');
	if (!existsSync(executable))
		return {
			status: 'error',
			message: 'SNR読み取りツールが未ビルドです。scripts/build-snr-reader.ps1を実行してください。',
		};
	return new Promise((resolve) => {
		execFile(
			executable,
			[String(pid)],
			{ windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				try {
					const result = JSON.parse(stdout);
					if (result.status === 'error') resolve(result);
					else if (!error && result.status === 'ok' && result.pid === pid && Array.isArray(result.players))
						resolve(result);
					else resolve({ status: 'error', message: '取得結果を検証できませんでした。' });
				} catch {
					resolve({
						status: 'error',
						message: error?.killed ? '取得がタイムアウトしました。' : 'SNR役職情報の取得に失敗しました。',
					});
				}
			}
		);
	});
}
