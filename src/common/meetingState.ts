import { AmongUsState, GameState } from './AmongUsState';
import { CameraLocation } from './AmongusMap';

/** Discard stale disguise data on every meeting snapshot, before broadcasting it. */
export function normalizeMeetingState(state: AmongUsState): AmongUsState {
	if (state.gameState !== GameState.DISCUSSION) return state;
	return {
		...state,
		mixupSabotaged: false,
		camouflaged: false,
		comsSabotaged: false,
		currentCamera: CameraLocation.NONE,
		players: state.players.map((player) => ({
			...player,
			currentOutfit: 0,
			appearanceName: player.name,
			appearanceColorId: player.colorId,
			appearanceHatId: player.hatId,
			appearanceSkinId: player.skinId,
			appearanceVisorId: player.visorId,
			appearanceId: `${player.colorId}|${player.hatId}|${player.skinId}|${player.visorId}`,
			shiftedColor: -1,
			sizeScale: 1,
			inVent: false,
		})),
	};
}
