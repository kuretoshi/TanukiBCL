import { AmongUsState, GameState, Player } from './AmongUsState';

export interface WallEarState {
	playerId: number;
	x: number;
	y: number;
	range: number;
}
export function validWallEar(value: unknown): value is WallEarState {
	if (!value || typeof value !== 'object') return false;
	const p = value as WallEarState;
	return (
		Number.isInteger(p.playerId) &&
		p.playerId >= 0 &&
		p.playerId <= 255 &&
		Number.isFinite(p.x) &&
		Math.abs(p.x) <= 10000 &&
		Number.isFinite(p.y) &&
		Math.abs(p.y) <= 10000 &&
		Number.isFinite(p.range) &&
		p.range >= 1 &&
		p.range <= 10
	);
}
export function wallEarFor(state: AmongUsState, me: Player): WallEarState | undefined {
	if (state.mod !== 'NoS' || state.gameState !== GameState.TASKS || me.isDead || me.disconnected || me.inVent) return;
	const ears = state.nosWallEars;
	if (!Array.isArray(ears) || ears.length > 24) return;
	let result: WallEarState | undefined;
	for (const ear of ears) {
		if (!validWallEar(ear)) return;
		if (ear.playerId !== me.id) continue;
		if (result) return;
		result = ear;
	}
	// A teleport or stale host state must not create a remote listening station.
	if (result && Math.hypot(result.x - me.x, result.y - me.y) <= 1.6) return result;
}
