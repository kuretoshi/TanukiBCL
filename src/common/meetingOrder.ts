import type { Player } from './AmongUsState';

const unavailable = (player: Pick<Player, 'disconnected' | 'isDead'>): number =>
	player.disconnected || player.isDead ? 1 : 0;

/** The meeting tablet places living players first, then orders each group by player ID. */
export function sortMeetingPlayers(players: readonly Player[]): Player[] {
	return [...players].sort((a, b) => unavailable(a) - unavailable(b) || a.id - b.id);
}

/** Keep the meeting's participant identities while following late death updates at its start. */
export function reconcileMeetingPlayers(snapshot: readonly Player[], live: readonly Player[]): Player[] {
	const byId = new Map(live.map((player) => [player.id, player]));
	if (!snapshot.every((player) => byId.has(player.id))) return [...snapshot];
	return [...snapshot].sort((a, b) => unavailable(byId.get(a.id)!) - unavailable(byId.get(b.id)!) || a.id - b.id);
}
