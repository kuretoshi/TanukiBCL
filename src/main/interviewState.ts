import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validInterview, type InterviewState } from '../common/InterviewState';

export function readInterviewState(
	pid: number,
	now = Date.now(),
	path = join(process.env.LOCALAPPDATA ?? '', 'TanukiBCL', 'NoS', `interviews-${pid}.json`)
): InterviewState[] {
	try {
		if (statSync(path).size > 65536) return [];
		return parseInterviewState(readFileSync(path, 'utf8'), pid, now);
	} catch {
		return [];
	}
}

export function parseInterviewState(
	text: string | undefined,
	pid: number,
	now = Date.now()
): ReturnType<typeof readInterviewState> {
	try {
		const data = JSON.parse(text ?? '');
		if (
			data.protocol !== 1 ||
			data.pid !== pid ||
			!Number.isSafeInteger(data.unixMs) ||
			now - data.unixMs > 1000 ||
			data.unixMs - now > 100 ||
			!Array.isArray(data.players) ||
			data.players.length > 32
		)
			return [];
		const ids = new Set<number>();
		for (const entry of data.players) {
			if (!validInterview(entry, now) || ids.has(entry.playerId)) return [];
			ids.add(entry.playerId);
		}
		return data.players;
	} catch {
		return [];
	}
}
