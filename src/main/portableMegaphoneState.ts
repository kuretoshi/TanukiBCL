import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function readPortableMegaphoneState(pid: number, now = Date.now(),
	filePath = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', 'portable-megaphone.json') : ''
): { playerId: number; extraRange: number }[] {
	try {
		if (!filePath || statSync(filePath).size > 16384) return [];
		const data = JSON.parse(readFileSync(filePath, 'utf8'));
		if (data.protocol !== 1 || data.pid !== pid || !Number.isFinite(data.unixMs) ||
			now - data.unixMs > 500 || now - data.unixMs < -100 || !Array.isArray(data.players) || data.players.length > 255) return [];
		const ids = new Set<number>();
		for (const p of data.players) {
			if (!p || !Number.isInteger(p.playerId) || p.playerId < 0 || p.playerId > 255 || ids.has(p.playerId) ||
				!Number.isFinite(p.extraRange) || p.extraRange < 0 || p.extraRange > 30) return [];
			ids.add(p.playerId);
		}
		return data.players;
	} catch { return []; }
}
