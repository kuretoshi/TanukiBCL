import { GameState, type AmongUsState, type Player } from './AmongUsState';
import { hasTanukiAddon } from './tanukiAddon';

export interface BitCharacterState {
	playerId: number;
	stage: number;
}
export function validBitCharacter(p: BitCharacterState): boolean {
	return (
		!!p &&
		Number.isInteger(p.playerId) &&
		p.playerId >= 0 &&
		p.playerId <= 255 &&
		Number.isInteger(p.stage) &&
		p.stage >= 0 &&
		p.stage <= 6
	);
}
export function bitCharacterStage(
	state: AmongUsState,
	speaker: Pick<Player, 'id' | 'isDead' | 'disconnected'>
): number {
	if (!hasTanukiAddon(state) || state.gameState !== GameState.TASKS || speaker.isDead || speaker.disconnected) return -1;
	const rows = state.nosBitCharacters;
	if (
		!Array.isArray(rows) ||
		rows.length > 24 ||
		!rows.every(validBitCharacter) ||
		new Set(rows.map((p) => p.playerId)).size !== rows.length
	)
		return -1;
	const stage = rows.find((p) => p.playerId === speaker.id)?.stage;
	return stage !== undefined && stage < 6 ? stage : -1;
}
