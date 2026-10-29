import { GameState, type AmongUsState, type Player } from '../../common/AmongUsState';
import { hasTanukiAddon } from '../../common/tanukiAddon';

export function chargingMegaphone(state: AmongUsState, other: Player) {
	if (
		!hasTanukiAddon(state) ||
		state.gameState !== GameState.TASKS ||
		other.isDead ||
		other.disconnected ||
		other.isDummy ||
		other.bugged
	)
		return;
	return state.nosMegaphones?.find((entry) => entry.playerId === other.id && !entry.phase);
}

export function megaphoneGain(range: number, dx: number, dy: number): number {
	if (!Number.isFinite(range) || range <= 0) return 0;
	const distance = Math.hypot(dx, dy);
	// Fade the edge so expanding range doesn't suddenly switch listeners on.
	return Math.max(0, Math.min(1, (range - distance) / Math.min(2, range)));
}

export function portableMegaphoneExtraRange(state: AmongUsState, other: Player): number {
	if (
		!hasTanukiAddon(state) ||
		state.gameState !== GameState.TASKS ||
		other.isDead ||
		other.disconnected ||
		other.isDummy ||
		other.bugged
	)
		return 0;
	const extra = state.nosPortableMegaphones?.find((entry) => entry.playerId === other.id)?.extraRange;
	return extra !== undefined && Number.isFinite(extra) && extra >= 0 && extra <= 30 ? extra : 0;
}
