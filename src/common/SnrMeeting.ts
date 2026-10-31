export interface SnrMeeting {
	enabled: boolean;
	/** SNR numbers the first page as one. */
	currentPage: number;
	/** Actual vote-area order, including dead/disconnected slots. */
	playerIds: number[];
}

/** Undefined keeps the existing non-paged layout; an empty array hides an unreadable paged HUD. */
export function snrMeetingPage<T extends { id: number }>(
	mod: string,
	players: readonly T[],
	meeting?: SnrMeeting
): readonly (T | undefined)[] | undefined {
	if (mod !== 'SUPER_NEW_ROLES' || (!meeting?.enabled && players.length <= 15)) return undefined;
	if (
		!meeting?.enabled ||
		!Array.isArray(meeting.playerIds) ||
		meeting.playerIds.length > 256 ||
		!meeting.playerIds.every((id) => Number.isInteger(id) && id >= 0 && id < 255) ||
		new Set(meeting.playerIds).size !== meeting.playerIds.length ||
		!Number.isInteger(meeting.currentPage) ||
		meeting.currentPage < 1 ||
		meeting.currentPage > Math.ceil(meeting.playerIds.length / 15)
	)
		return [];
	const byId = new Map(players.map((player) => [player.id, player]));
	const start = (meeting.currentPage - 1) * 15;
	return meeting.playerIds.slice(start, start + 15).map((id) => byId.get(id));
}
