import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DyingVoiceState } from '../common/DyingVoiceState';

export function readDyingVoiceState(
	pid: number,
	now = Date.now(),
	filePath = join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'NoS', `dying-voice-${pid}.json`)
): DyingVoiceState[] {
	try {
		if (statSync(filePath).size > 32768) return [];
		const data = JSON.parse(readFileSync(filePath, 'utf8'));
		if (
			data.protocol !== 1 ||
			data.pid !== pid ||
			!Number.isSafeInteger(data.unixMs) ||
			now - data.unixMs > 1000 ||
			data.unixMs - now > 100 ||
			!Array.isArray(data.players) ||
			data.players.length > 255
		)
			return [];
		const ids = new Set<number>();
		for (const p of data.players) {
			if (
				!p ||
				!Number.isInteger(p.playerId) ||
				p.playerId < 0 ||
				p.playerId > 255 ||
				ids.has(p.playerId) ||
				!Number.isSafeInteger(p.started) ||
				p.started <= 0 ||
				p.started > now + 100 ||
				!Number.isFinite(p.seconds) ||
				p.seconds < 1 ||
				p.seconds > 30 ||
				!Number.isFinite(p.range) ||
				p.range < 0.5 ||
				p.range > 10 ||
				(p.loop !== undefined && typeof p.loop !== 'boolean') ||
				!Number.isFinite(p.x) ||
				!Number.isFinite(p.y) ||
				Math.abs(p.x) > 10000 ||
				Math.abs(p.y) > 10000
			)
				return [];
			ids.add(p.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
