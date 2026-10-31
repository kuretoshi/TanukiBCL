import { voiceJammingFor } from '../../common/VoiceJammingState';
import { isHeroTransformed } from '../../common/HeroTransformState';
import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import {
	getVoiceEffectTuning,
	isNeutralVoiceEffectTuning,
	VoiceEffectId,
	VoiceEffectTuning,
} from '../../common/VoiceEffectTuning';
import { hasSnrJumbo, isSnrJackalTeam } from '../../common/SnrRole';
import { MapType } from '../../common/AmongusMap';
import { chargingMegaphone } from './megaphoneVoice';

export interface VoiceEffectSetting {
	id: VoiceEffectId;
	tuning: VoiceEffectTuning;
}

function configuredEffect(settings: ISettings, id: VoiceEffectId): VoiceEffectSetting | null {
	const tuning = getVoiceEffectTuning(settings, id);
	return isNeutralVoiceEffectTuning(tuning) ? null : { id, tuning };
}

export function shouldApplyRainbowStarEcho(
	state: AmongUsState,
	other: Player,
	lobby?: ILobbySettings,
	settings?: ISettings
): boolean {
	return (
		state.mod === 'NoS' &&
		lobby?.nosRainbowStarEcho !== false &&
		!isNeutralVoiceEffectTuning(getVoiceEffectTuning(settings ?? {}, 'nosRainbowStar')) &&
		(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
		!other.isDead &&
		!other.disconnected &&
		!other.bugged &&
		!other.isDummy &&
		other.nosRole?.isRainbowStar === true
	);
}

export function selectVoiceEffect(
	state: AmongUsState,
	settings: ISettings,
	lobby: ILobbySettings,
	me: Player,
	other: Player,
	radioClientId: number,
	radioClientIds?: readonly number[]
): VoiceEffectSetting | null {
	const jamming = voiceJammingFor(state, other.id);
	if (jamming && jamming.pitch !== 1 && !other.disconnected && !other.bugged && !other.isDummy)
		return configuredEffect(settings, 'nosVoiceJamming');
	if (other.isDead || other.disconnected || other.bugged || other.isDummy) return null;
	const megaphone = chargingMegaphone(state, other);
	if (megaphone && megaphone.voiceEffect !== false) return configuredEffect(settings, 'nosMegaphone');
	if (isHeroTransformed(state, other.id)) return null;
	if (
		state.mod === 'NoS' &&
		lobby.nosCitrusVoiceEffect !== false &&
		(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
		(other.nosPlayer?.hat?.name === 'noshat_catudon_Citrus_Orange' ||
			other.nosPlayer?.hat?.name === 'noshat_catudon_Citrus_Lemon')
	)
		return configuredEffect(settings, 'nosCitrus');
	if (state.gameState !== GameState.TASKS) return null;
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
	if (
		state.mod === 'NoS' &&
		lobby.nosBerserkerVoiceEffect !== false &&
		other.nosRole?.roleName === 'berserker' &&
		(other.nosPlayer?.bodyType !== undefined
			? other.nosPlayer.bodyType === 2
			: other.nosRole.bodyType === 2 && other.nosRole.isBerserking === true)
	)
		return configuredEffect(settings, 'nosBerserker');
	if (
		state.mod === 'NoS' &&
		lobby.nosRokurokubiVoiceEffect !== false &&
		other.nosPlayer?.bodyType === 3 &&
		Number.isFinite(other.nosPlayer.neckLength) &&
		other.nosPlayer.neckLength > 0
	)
		return configuredEffect(settings, 'nosRokurokubi');
	if (state.mod === 'NoS' && lobby.nosSizeVoiceEffect !== false && other.nosPlayer) {
		const { bodyRateX: x, bodyRateY: y } = other.nosPlayer;
		if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y >= 0 && (x < 0.98 || x > 1.02 || y < 0.98 || y > 1.02))
			return configuredEffect(settings, 'nosSize');
	}
	if (state.mod === 'SUPER_NEW_ROLES' && lobby.snrJumboVoice && hasSnrJumbo(other.snrRole)) {
		const size = other.snrRole?.jumbo;
		return size &&
			Number.isFinite(size.currentSize) &&
			Number.isFinite(size.maxSize) &&
			size.maxSize > 0 &&
			size.currentSize > 0
			? configuredEffect(settings, 'snrJumbo')
			: null;
	}
	if (lobby.voiceEffectEnabled === false || me.isDead) return null;
	if (
		((me.isImpostor && other.isImpostor && (lobby.impostorRadioEnabled || lobby.impostorRadioOnlyMode)) ||
			(state.mod === 'SUPER_NEW_ROLES' &&
				lobby.jackalRadioEnabled === true &&
				lobby.impostorRadioOnlyMode !== true &&
				isSnrJackalTeam(me.snrRole) &&
				isSnrJackalTeam(other.snrRole))) &&
		(radioClientIds?.includes(other.clientId) ?? other.clientId === radioClientId)
	)
		return null;
	const changed = (player: Player) => (player.appearanceName || player.name) !== player.name;
	return changed(other) && state.players?.some((player) => !player.disconnected && !player.bugged && changed(player))
		? configuredEffect(settings, 'disguise')
		: null;
}
