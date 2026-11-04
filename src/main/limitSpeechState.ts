const remembered = new Map<number, number[]>();
// A missing heartbeat must not give an exhausted player their microphone back.
// Authoritative empty snapshots and leaving the match clear the restriction.
export function parseLimitSpeechState(
	text: string | undefined,
	pid: number,
	now = Date.now(),
	active = true,
	linked?: number[]
): number[] {
	if (!active) {
		remembered.delete(pid);
		return [];
	}
	if (linked) {
		remembered.set(pid, linked);
		return linked;
	}
	try {
		if (text === undefined) return remembered.get(pid) ?? [];
		const data = JSON.parse(text);
		if (
			data.protocol !== 1 ||
			data.pid !== pid ||
			!Number.isFinite(data.unixMs) ||
			now - data.unixMs > 1000 ||
			now - data.unixMs < -100 ||
			!Array.isArray(data.players) ||
			data.players.length > 255
		)
			return remembered.get(pid) ?? [];
		if (
			data.players.some((id: unknown) => !Number.isInteger(id) || Number(id) < 0 || Number(id) > 255) ||
			new Set(data.players).size !== data.players.length
		)
			return remembered.get(pid) ?? [];
		remembered.set(pid, data.players);
		return data.players;
	} catch {
		return remembered.get(pid) ?? [];
	}
}
