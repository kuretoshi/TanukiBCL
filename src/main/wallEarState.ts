import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validWallEar, type WallEarState } from '../common/WallEarState';

export function readWallEarState(
	pid: number,
	now = Date.now(),
	file = join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'NoS', `ears-${pid}.json`)
): WallEarState[] {
	try {
		if (statSync(file).size > 8192) return [];
		return parseWallEarState(readFileSync(file, 'utf8'), pid, now);
	} catch { return []; }
}
export function parseWallEarState(text: string | undefined, pid: number, now = Date.now()): WallEarState[] {
	try {
		if (text === undefined) return [];
		const p = JSON.parse(text);
		if (
			p.protocol !== 1 ||
			p.pid !== pid ||
			!Number.isSafeInteger(p.unixMs) ||
			now - p.unixMs > 1000 ||
			p.unixMs > now + 100 ||
			!Array.isArray(p.players) ||
			p.players.length > 24 ||
			!p.players.every(validWallEar)
		)
			return [];
		return new Set(p.players.map((e: WallEarState) => e.playerId)).size === p.players.length ? p.players : [];
	} catch {
		return [];
	}
}
