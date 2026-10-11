import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MegaphoneState } from '../common/MegaphoneState';

export function readMegaphoneState(
	pid: number,
	now = Date.now(),
	filePath = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', 'megaphone-state.json') : ''
): MegaphoneState[] {
	try {
		if (!filePath || statSync(filePath).size > 16384) return [];
		const data = JSON.parse(readFileSync(filePath, 'utf8'));
		if (
			data.protocol !== 1 ||
			data.pid !== pid ||
			!Number.isFinite(data.unixMs) ||
			now - data.unixMs > 500 ||
			now - data.unixMs < -100 ||
			!Array.isArray(data.players) ||
			data.players.length > 255
		)
			return [];
		const ids = new Set<number>();
		for (const player of data.players) {
			if (
				!player ||
				!Number.isInteger(player.playerId) ||
				player.playerId < 0 ||
				player.playerId > 255 ||
				ids.has(player.playerId) ||
				!Number.isFinite(player.energy) ||
				player.energy < 0 ||
				player.energy > 1 ||
				!Number.isFinite(player.range) ||
				player.range < 2 ||
				player.range > 40 ||
				(player.voiceEffect !== undefined && typeof player.voiceEffect !== 'boolean')
			)
				return [];
			ids.add(player.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
