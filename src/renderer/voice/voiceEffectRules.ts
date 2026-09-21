import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import type { PitchShiftDirection } from '../voiceEffect';
import { hasSnrJumbo } from '../../common/SnrRole';
import { MapType } from '../../common/AmongusMap';

export interface VoiceEffectSetting {
	strength: number;
	direction?: PitchShiftDirection;
	formantScale?: number;
	jumbo?: boolean;
}

export function selectVoiceEffect(
	state: AmongUsState,
	settings: ISettings,
	lobby: ILobbySettings,
	me: Player,
	other: Player,
	radioClientId: number
): VoiceEffectSetting | null {
	if (state.gameState !== GameState.TASKS || other.isDead || other.disconnected || other.bugged || other.isDummy)
		return null;
	if (
		state.map === MapType.AIRSHIP &&
		(state.airshipMeetingByOutfit ||
			state.debug?.airshipMeetingByOutfit ||
			(state.debug &&
				state.debug.meetingHudCachePtr !== 0 &&
				state.debug.meetingHudState >= 0 &&
				state.debug.meetingHudState < 4))
	)
		return null;
	if (state.mod === 'SUPER_NEW_ROLES' && lobby.snrJumboVoice && hasSnrJumbo(other.snrRole)) {
		const size = other.snrRole?.jumbo;
		if (
			size &&
			Number.isFinite(size.currentSize) &&
			Number.isFinite(size.maxSize) &&
			size.maxSize > 0 &&
			size.currentSize > 0
		) {
			return { strength: Math.min(100, (size.currentSize / size.maxSize) * 100), direction: 'down', jumbo: true };
		}
		return null;
	}
	if (lobby.voiceEffectEnabled === false || me.isDead) return null;
	if (me.isImpostor && other.isImpostor && lobby.impostorRadioEnabled && other.clientId === radioClientId) return null;
	const changed = (player: Player) => (player.appearanceName || player.name) !== player.name;
	if (
		settings.voiceEffectStrength > 0 &&
		changed(other) &&
		state.players?.some((player) => !player.disconnected && !player.bugged && changed(player))
	) {
		return { strength: settings.voiceEffectStrength };
	}
	return null;
}
