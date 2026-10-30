import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validHeroTransform, type HeroTransformState } from '../common/HeroTransformState';

export function readHeroTransformState(
	pid: number,
	now = Date.now(),
	path = join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'NoS', `hero-transforms-${pid}.json`)
): HeroTransformState[] {
	try {
		if (statSync(path).size > 8192) return [];
		return parseHeroTransformState(readFileSync(path, 'utf8'), pid, now);
	} catch {
		return [];
	}
}

export function parseHeroTransformState(
	text: string | undefined,
	pid: number,
	now = Date.now()
): ReturnType<typeof readHeroTransformState> {
	try {
		const data = JSON.parse(text ?? '');
		if (
			!data ||
			data.protocol !== 1 ||
			data.pid !== pid ||
			!Number.isSafeInteger(data.unixMs) ||
			now - data.unixMs > 1000 ||
			data.unixMs - now > 100 ||
			!Array.isArray(data.players) ||
			data.players.length > 24
		)
			return [];
		const ids = new Set<number>();
		for (const entry of data.players) {
			if (!validHeroTransform(entry) || ids.has(entry.playerId)) return [];
			ids.add(entry.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
