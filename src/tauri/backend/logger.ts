import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from './electron';

export function getLogFilePaths(): string[] {
	return ['backend.log', 'frontend.log'].map((name) => join(app.getPath('userData'), 'logs', name));
}
export async function readDebugLog(): Promise<string> {
	return (
		await Promise.all(
			getLogFilePaths().map(async (file) => {
				try {
					return (await readFile(file, 'utf8')).slice(-65536);
				} catch {
					return '';
				}
			})
		)
	)
		.filter(Boolean)
		.join('\n');
}
