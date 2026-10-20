import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validVoiceJamming, type VoiceJammingState } from '../common/VoiceJammingState';

export function readVoiceJammingState(
	pid: number,
	now = Date.now(),
	path = join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'NoS', `voice-jamming-${pid}.json`)
): VoiceJammingState[] {
	try {
		if (statSync(path).size > 65536) return [];
		const data = JSON.parse(readFileSync(path, 'utf8'));
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
		for (const entry of data.players) {
			if (!validVoiceJamming(entry) || ids.has(entry.playerId)) return [];
			ids.add(entry.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
