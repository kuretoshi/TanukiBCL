import { AmongUsState, GameState, Player } from './AmongUsState';
import { poseCollide } from './ColliderMap';

export interface ParrotState {
	mode?: 'clone';
	spoofTalking?: boolean;
	ownerId: number;
	birdId: number;
	x: number;
	y: number;
	range: number;
	seconds?: number;
	recordId: number;
	sourceId: number;
	started: number;
	clips: number[];
	playId: number;
	playClip: number;
	playStarted: number;
}
export const parrotSeconds = (p: ParrotState): number => (p.seconds === undefined ? 1.5 : p.seconds);
const sequence = (v: number) => Number.isInteger(v) && v >= 0 && v <= 2147483647;
const time = (v: number, now: number) => Number.isSafeInteger(v) && v >= 0 && v <= now + 100;
export function validParrot(value: unknown, now: number): value is ParrotState {
	if (!value || typeof value !== 'object') return false;
	const p = value as ParrotState;
	return (
		(p.mode === undefined || p.mode === 'clone') &&
		(p.spoofTalking === undefined || typeof p.spoofTalking === 'boolean') &&
		(p.spoofTalking !== true || p.mode === 'clone') &&
		(p.mode !== 'clone' ||
			(p.seconds === 10 &&
				p.sourceId === p.ownerId &&
				p.birdId === 1000000 + p.ownerId &&
				Array.isArray(p.clips) &&
				p.clips.length <= 1)) &&
		sequence(p.ownerId) &&
		p.ownerId <= 255 &&
		sequence(p.birdId) &&
		p.birdId > 0 &&
		Number.isFinite(p.x) &&
		Math.abs(p.x) <= 10000 &&
		Number.isFinite(p.y) &&
		Math.abs(p.y) <= 10000 &&
		Number.isFinite(p.range) &&
		p.range >= 1 &&
		p.range <= 10 &&
		Number.isFinite(parrotSeconds(p)) &&
		parrotSeconds(p) >= 0.5 &&
		parrotSeconds(p) <= (p.mode === 'clone' ? 10 : 5) &&
		sequence(p.recordId) &&
		sequence(p.sourceId) &&
		p.sourceId <= 255 &&
		time(p.started, now) &&
		(p.recordId === 0 || p.started > 0) &&
		Array.isArray(p.clips) &&
		p.clips.length <= 5 &&
		p.clips.every((v) => sequence(v) && v > 0) &&
		new Set(p.clips).size === p.clips.length &&
		sequence(p.playId) &&
		sequence(p.playClip) &&
		time(p.playStarted, now) &&
		(p.playId === 0 || (p.playStarted > 0 && p.clips.includes(p.playClip)))
	);
}
export function parrotNear(p: ParrotState, player: Player | undefined, state: AmongUsState): boolean {
	return (
		!!player &&
		!player.disconnected &&
		!player.inVent &&
		Math.hypot(p.x - player.x, p.y - player.y) <= p.range &&
		!poseCollide(player, p, state.map, state.closedDoors)
	);
}
export function parrotsActive(state: AmongUsState): boolean {
	return state.mod === 'NoS' && [GameState.TASKS, GameState.DISCUSSION].includes(state.gameState);
}
