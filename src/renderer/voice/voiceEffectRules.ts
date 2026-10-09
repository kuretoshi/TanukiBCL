import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import type { PitchShiftDirection } from '../voiceEffect';
import type { SourceFilterParameters } from './sourceFilterEffect';
import { hasSnrJumbo, isSnrJackalTeam } from '../../common/SnrRole';
import { MapType } from '../../common/AmongusMap';

export interface VoiceEffectSetting {
	strength: number;
	berserker?: boolean;
	direction?: PitchShiftDirection;
	formantScale?: number;
	jumbo?: boolean;
	squash?: number;
	toneRate?: number;
	directPitch?: boolean;
	sourceFilter?: SourceFilterParameters;
}

export function shouldApplyRainbowStarEcho(state: AmongUsState, other: Player, lobby?: ILobbySettings): boolean {
	return (
		state.mod === 'NoS' &&
		lobby?.nosRainbowStarEcho !== false &&
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
	if (other.isDead || other.disconnected || other.bugged || other.isDummy) return null;
	// Citrus changes the actual outfit at meeting start, rather than BodyType.
	// Keep the disguise throughout tasks and meetings while that outfit is visible.
	if (
		state.mod === 'NoS' &&
		lobby.nosCitrusVoiceEffect !== false &&
		(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
		(other.nosPlayer?.hat?.name === 'noshat_catudon_Citrus_Orange' ||
			other.nosPlayer?.hat?.name === 'noshat_catudon_Citrus_Lemon')
	) {
		return { strength: 100, direction: 'up' };
	}
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
	) {
		return { strength: 0, berserker: true };
	}
	if (state.mod === 'NoS' && lobby.nosRokurokubiVoiceEffect !== false && other.nosPlayer?.bodyType === 3) {
		const length = other.nosPlayer.neckLength;
		if (Number.isFinite(length) && length > 0) {
			// Smooth monotonic curve; about 40 game units raises pitch by one octave.
			const pitch = 1 + Math.min(1, Math.log1p(length) / Math.log1p(40));
			const x = other.nosPlayer.bodyRateX;
			const formant = Number.isFinite(x) && x > 0 ? Math.min(1.7, Math.max(0.55, 1 / x)) : 1;
			return { strength: 0, sourceFilter: { pitch, formant, squash: 0 } };
		}
	}
	if (state.mod === 'NoS' && lobby.nosSizeVoiceEffect !== false && other.nosPlayer) {
		const { bodyRateX, bodyRateY } = other.nosPlayer;
		if (
			bodyRateX !== undefined &&
			bodyRateY !== undefined &&
			Number.isFinite(bodyRateX) &&
			Number.isFinite(bodyRateY) &&
			bodyRateX > 0 &&
			bodyRateY >= 0
		) {
			const formant = Math.min(1.7, Math.max(0.55, 1 / bodyRateX));
			if (Math.abs(bodyRateX - 1) <= 0.02 && bodyRateY < 0.98) {
				const amount = 1 - bodyRateY;
				const squash = amount * amount * (3 - 2 * amount);
				return { strength: 0, sourceFilter: { pitch: 1 + squash * 0.25, formant: 1, squash } };
			}
			const pitch =
				bodyRateY < 0.98
					? 1 + Math.min(1, Math.log(1 / Math.max(0.1, bodyRateY)) / Math.log(10))
					: bodyRateY > 1.02
						? 1 - Math.min(1, Math.log(bodyRateY) / Math.log(5)) * 0.6
						: 1;
			if (pitch !== 1 || bodyRateX < 0.98 || bodyRateX > 1.02)
				return { strength: 0, sourceFilter: { pitch, formant, squash: 0 } };
		}
	}
	if (state.mod === 'SUPER_NEW_ROLES' && lobby.snrJumboVoice && hasSnrJumbo(other.snrRole)) {
		const size = other.snrRole?.jumbo;
		if (
			size &&
			Number.isFinite(size.currentSize) &&
			Number.isFinite(size.maxSize) &&
			size.maxSize > 0 &&
			size.currentSize > 0
		) {
			const growth = Math.min(1, size.currentSize / size.maxSize);
			return {
				strength: 0,
				sourceFilter: { pitch: 1 - growth * 0.6, formant: 1 - growth * 0.45, squash: 0 },
			};
		}
		return null;
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
	if (
		settings.voiceEffectStrength > 0 &&
		changed(other) &&
		state.players?.some((player) => !player.disconnected && !player.bugged && changed(player))
	) {
		return { strength: settings.voiceEffectStrength };
	}
	return null;
}
