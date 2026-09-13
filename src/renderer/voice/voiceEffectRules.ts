import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import type { PitchShiftDirection } from '../voiceEffect';

export interface VoiceEffectSetting {
	strength: number;
	direction?: PitchShiftDirection;
	formantScale?: number;
}

export function selectVoiceEffect(
	state: AmongUsState,
	settings: ISettings,
	lobby: ILobbySettings,
	me: Player,
	other: Player,
	radioClientId: number
): VoiceEffectSetting | null {
	if (
		state.gameState !== GameState.TASKS ||
		lobby.voiceEffectEnabled === false ||
		me.isDead ||
		other.isDead ||
		other.disconnected ||
		other.bugged ||
		other.isDummy
	)
		return null;
	if (me.isImpostor && other.isImpostor && lobby.impostorRadioEnabled && other.clientId === radioClientId) return null;
	const changed = (player: Player) => (player.appearanceName || player.name) !== player.name;
	if (
		settings.voiceEffectStrength > 0 &&
		changed(other) &&
		state.players?.some((player) => !player.disconnected && !player.bugged && changed(player))
	) {
		return { strength: settings.voiceEffectStrength };
	}
	/* TODO: ミニ・ジャンボの判定が完成するまでサイズによるエフェクトを無効化。
	if (!other.sizeScale || other.specialRole === 'UNKNOWN') return null;
	const difference = Math.min(1, Math.abs(other.sizeScale - 1));
	if (difference < 0.12) return null;
	return {
		strength: Math.max(20, Math.min(100, Math.round(difference * 85))),
		direction: other.sizeScale > 1 ? 'down' : 'up',
		formantScale: Math.max(0.65, Math.min(1.45, 1 / Math.sqrt(other.sizeScale))),
	};
	*/
	return null;
}
