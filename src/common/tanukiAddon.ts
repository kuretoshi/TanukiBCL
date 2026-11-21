import { GameState, type AmongUsState } from './AmongUsState';

/** Only the detected addon may activate Tanuki-don integrations. */
export function hasTanukiAddon(state: Pick<AmongUsState, 'mod' | 'nosAddonIds'> | undefined): boolean {
	return state?.mod === 'NoS' && state.nosAddonIds?.includes('tanuki.bcl.roles') === true;
}

export function isTanukiSpeechMuted(state: AmongUsState, playerId: number): boolean {
	return (
		hasTanukiAddon(state) &&
		(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
		state.nosLimitSpeechMuted?.includes(playerId) === true
	);
}
