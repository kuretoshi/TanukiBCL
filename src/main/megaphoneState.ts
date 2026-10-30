import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MegaphoneState } from '../common/MegaphoneState';

function stateFile(pid: number): string {
	if (!process.env.LOCALAPPDATA) return '';
	const root = join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS');
	const perProcess = join(root, `megaphone-state-${pid}.json`);
	return existsSync(perProcess) ? perProcess : join(root, 'megaphone-state.json');
}

export function readMegaphoneState(pid: number, now = Date.now(), filePath = stateFile(pid)): MegaphoneState[] {
	try {
		if (!filePath || statSync(filePath).size > 16384) return [];
		return parseMegaphoneState(readFileSync(filePath, 'utf8'), pid, now);
	} catch {
		return [];
	}
}

export function parseMegaphoneState(
	text: string | undefined,
	pid: number,
	now = Date.now()
): ReturnType<typeof readMegaphoneState> {
	try {
		const data = JSON.parse(text ?? '');
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
				(player.voiceEffect !== undefined && typeof player.voiceEffect !== 'boolean') ||
				(player.phase !== undefined &&
					(!['charging', 'firing'].includes(player.phase) ||
						!Number.isSafeInteger(player.shotId) ||
						player.shotId <= 0))
			)
				return [];
			ids.add(player.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
