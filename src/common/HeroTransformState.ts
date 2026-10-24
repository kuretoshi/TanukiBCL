import { GameState, type AmongUsState } from './AmongUsState';

export interface HeroTransformState {
	playerId: number;
	kind: 'super' | 'evil';
}

export function validHeroTransform(value: unknown): value is HeroTransformState {
	if (!value || typeof value !== 'object') return false;
	const entry = value as HeroTransformState;
	return Number.isInteger(entry.playerId) && entry.playerId >= 0 && entry.playerId <= 255 &&
		(entry.kind === 'super' || entry.kind === 'evil');
}

export function isHeroTransformed(state: AmongUsState, playerId: number): boolean {
	return state.mod === 'NoS' && state.gameState === GameState.TASKS &&
		Array.isArray(state.nosHeroTransforms) && state.nosHeroTransforms.some(entry =>
			validHeroTransform(entry) && entry.playerId === playerId);
}
