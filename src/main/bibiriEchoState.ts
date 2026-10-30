import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function readBibiriEchoState(
	pid: number,
	now = Date.now(),
	filePath = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', 'bibiri-echo.json') : ''
): { playerId: number; unixMs: number }[] {
	try {
		if (!filePath || statSync(filePath).size > 16384) return [];
		return parseBibiriEchoState(readFileSync(filePath, 'utf8'), pid, now);
	} catch {
		return [];
	}
}

export function parseBibiriEchoState(
	text: string | undefined,
	pid: number,
	now = Date.now()
): ReturnType<typeof readBibiriEchoState> {
	try {
		const data = JSON.parse(text ?? '');
		if (data.protocol !== 1 || data.pid !== pid || !Array.isArray(data.players) || data.players.length > 255) return [];
		const ids = new Set<number>();
		for (const p of data.players) {
			if (
				!p ||
				!Number.isInteger(p.playerId) ||
				p.playerId < 0 ||
				p.playerId > 255 ||
				ids.has(p.playerId) ||
				!Number.isFinite(p.unixMs) ||
				p.unixMs > now + 100
			)
				return [];
			ids.add(p.playerId);
		}
		return data.players.filter((p: { unixMs: number }) => now - p.unixMs <= 3000);
	} catch {
		return [];
	}
}
