import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ISettings, ILobbySettings } from '../../common/ISettings';
import { AmongUsMaps, CameraLocation, MapType } from '../../common/AmongusMap';
import { poseCollide } from '../../common/ColliderMap';
import { isSnrJackal, isSnrSidekick, isSnrNeutralKiller } from '../../common/SnrRole';

export interface MuffleSetting {
	type: BiquadFilterType;
	frequency: number;
	q: number;
}

export interface VoiceAudioInput {
	state: AmongUsState;
	settings: ISettings;
	activeLobbySettings: ILobbySettings;
	me: Player;
	other: Player;
	maxDistance: number;
	impostorRadioClientId: number;
	airshipSpawnFallback?: boolean;
}

/**
 * `null` on an effect field means "leave the node as it is"; `false` means "ensure disconnected".
 */
export interface VoiceAudioResult {
	gain: number;
	panPosition: [number, number] | null;
	panMaxDistance: number | null;
	muffle: MuffleSetting | false | null;
	reverb: boolean | null;
}

function distance(panPos: [number, number]): number {
	return Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]);
}

export function calculateVoiceAudio(input: VoiceAudioInput): VoiceAudioResult {
	const { state, settings, activeLobbySettings, maxDistance, impostorRadioClientId } = input;
	const useNosPositions = state.mod === 'NoS' && activeLobbySettings.nosVoicePositions === true;
	const me = useNosPositions && state.nosLocalMicPosition ? { ...input.me, ...state.nosLocalMicPosition } : input.me;
	const other =
		useNosPositions && input.other.nosPlayer
			? { ...input.other, x: input.other.nosPlayer.speakerPositionX, y: input.other.nosPlayer.speakerPositionY }
			: input.other;

	const result: VoiceAudioResult = {
		gain: 0,
		panPosition: null,
		panMaxDistance: null,
		muffle: null,
		reverb: null,
	};

	if (other.disconnected || other.isDummy) {
		return result;
	}

	let panPos: [number, number] = [other.x - me.x, other.y - me.y];
	let endGain = 0;
	let wallCheckEnabled = false;
	let skipDistanceCheck = false;
	let muffleEnabled = false;
	const meJackal = state.mod === 'SUPER_NEW_ROLES' && isSnrJackal(me.snrRole);
	const otherJackal = state.mod === 'SUPER_NEW_ROLES' && isSnrJackal(other.snrRole);
	const meSidekick = state.mod === 'SUPER_NEW_ROLES' && isSnrSidekick(me.snrRole);
	const otherSidekick = state.mod === 'SUPER_NEW_ROLES' && isSnrSidekick(other.snrRole);
	const meJackalTeam = meJackal || meSidekick;
	const otherJackalTeam = otherJackal || otherSidekick;
	const snrVentConversation =
		meJackalTeam &&
		otherJackalTeam &&
		(meSidekick || otherSidekick ? activeLobbySettings.sidekickTalkInVents : activeLobbySettings.jackalTalkInVents);
	const snrNeutralKillerGhosts =
		state.mod === 'SUPER_NEW_ROLES' && activeLobbySettings.jackalHaunting && isSnrNeutralKiller(me.snrRole);
	const nosKillerGhosts =
		state.mod === 'NoS' &&
		activeLobbySettings.nosNeutralKillerHaunting &&
		me.nosPlayer?.isNeutral === true &&
		me.nosPlayer.isKiller === true &&
		me.nosPlayer.isImpostor === false;
	const canHearGhosts = meJackal
		? snrNeutralKillerGhosts
		: meSidekick
			? activeLobbySettings.sidekickHaunting
			: (state.mod === 'TOH4E' &&
					activeLobbySettings.tohNeutralKillerHaunting === true &&
					me.tohRole?.isKiller === true) ||
				nosKillerGhosts ||
				snrNeutralKillerGhosts ||
				(me.isImpostor && activeLobbySettings.haunting);
	const meetingFallback =
		state.map === MapType.AIRSHIP &&
		state.gameState === GameState.TASKS &&
		(state.airshipMeetingByOutfit ||
			state.debug?.airshipMeetingByOutfit ||
			(state.debug &&
				state.debug.meetingHudCachePtr !== 0 &&
				state.debug.meetingHudState >= 0 &&
				state.debug.meetingHudState < 4));

	switch (state.gameState) {
		case GameState.MENU:
			return result;

		case GameState.LOBBY:
			endGain = 1;
			break;

		case GameState.TASKS:
			endGain = 1;
			if (meetingFallback || (!me.isDead && input.airshipSpawnFallback)) {
				skipDistanceCheck = true;
				panPos = [0, 0];
			}

			if (activeLobbySettings.meetingGhostOnly) {
				endGain = 0;
			}
			if (!me.isDead && activeLobbySettings.commsSabotage && state.comsSabotaged && !me.isImpostor) {
				endGain = 0;
			}

			if (
				other.inVent &&
				!((meJackalTeam || otherJackalTeam) && me.inVent
					? snrVentConversation
					: activeLobbySettings.hearImpostorsInVents || (activeLobbySettings.impostersHearImpostersInvent && me.inVent))
			) {
				endGain = 0;
			}
			wallCheckEnabled = activeLobbySettings.wallsBlockAudio && !me.isDead;
			if (
				me.isImpostor &&
				other.isImpostor &&
				activeLobbySettings.impostorRadioEnabled &&
				other.clientId === impostorRadioClientId
			) {
				skipDistanceCheck = true;
				muffleEnabled = true;
				result.muffle = { type: 'highpass', frequency: 1000, q: 10 };
			}

			if (!me.isDead && other.isDead && canHearGhosts) {
				result.reverb = true;
				wallCheckEnabled = false;
				endGain *= settings.ghostVolumeAsImpostor / 100;
			} else if (other.isDead && !me.isDead) {
				endGain = 0;
			}
			if (
				!me.isDead &&
				meJackalTeam &&
				me.inVent &&
				!other.inVent &&
				!(meJackal ? activeLobbySettings.jackalHearOutsideVents : activeLobbySettings.sidekickHearOutsideVents)
			)
				endGain = 0;
			if (meetingFallback && !me.isDead && other.isDead) endGain = 0;
			break;

		case GameState.DISCUSSION:
			panPos = [0, 0];
			endGain = 1;
			if (!me.isDead && other.isDead) {
				endGain = 0;
			}
			break;

		case GameState.UNKNOWN:
		default:
			endGain = 0;
			break;
	}

	if (state.lightRadiusChanged) {
		result.panMaxDistance = maxDistance;
	}

	if (!other.isDead || state.gameState !== GameState.TASKS || !canHearGhosts || me.isDead) {
		result.reverb = false;
	}

	if (activeLobbySettings.deadOnly) {
		panPos = [0, 0];
		if (!me.isDead || !other.isDead) {
			endGain = 0;
		}
	}

	let isOnCamera = state.currentCamera !== CameraLocation.NONE;
	if (
		input.airshipSpawnFallback &&
		wallCheckEnabled &&
		poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, state.map, state.closedDoors)
	)
		return result;
	if (!skipDistanceCheck && distance(panPos) > maxDistance) {
		if (!activeLobbySettings.hearThroughCameras || state.gameState !== GameState.TASKS) {
			return result;
		}

		if (state.currentCamera !== CameraLocation.NONE && state.currentCamera !== CameraLocation.Skeld) {
			const cameraPos = AmongUsMaps[state.map].cameras[state.currentCamera];
			panPos = [other.x - cameraPos.x, other.y - cameraPos.y];
		} else if (state.currentCamera === CameraLocation.Skeld) {
			let closest = 999;
			let cameraPos = { x: 999, y: 999 };
			for (const camera of Object.values(AmongUsMaps[state.map].cameras)) {
				const cameraDist = Math.sqrt(Math.pow(other.x - camera.x, 2) + Math.pow(other.y - camera.y, 2));
				if (closest > cameraDist) {
					closest = cameraDist;
					cameraPos = camera;
				}
			}
			if (closest !== 999) {
				panPos = [other.x - cameraPos.x, other.y - cameraPos.y];
			}
		}

		if (distance(panPos) > maxDistance) {
			return result;
		}
	} else {
		if (
			!skipDistanceCheck &&
			wallCheckEnabled &&
			poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, state.map, state.closedDoors)
		) {
			return result;
		}
		isOnCamera = false;
	}

	const inVentMuffle = (me.inVent && !me.isDead) || (other.inVent && !other.isDead);
	if ((inVentMuffle || isOnCamera) && state.gameState === GameState.TASKS) {
		result.muffle = {
			type: 'lowpass',
			frequency: isOnCamera ? 2300 : 2000,
			q: isOnCamera ? -15 : 20,
		};
		if (endGain === 1) endGain = isOnCamera ? 0.8 : 0.5;
	} else if (!muffleEnabled) {
		result.muffle = false;
	}

	if (!settings.enableSpatialAudio || skipDistanceCheck) {
		panPos = [0, 0];
	}

	result.panPosition = panPos;
	result.gain = endGain;
	return result;
}
