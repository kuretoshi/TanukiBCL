import { GamePlatform } from './GamePlatform';

export interface ISettings {
	alwaysOnTop: boolean;
	language: string;
	microphone: string;
	speaker: string;
	pushToTalkMode: number;
	serverURL: string;
	serverURLs: string[];
	pushToTalkShortcut: string;
	deafenShortcut: string;
	muteShortcut: string;
	impostorRadioShortcut: string;
	jackalRadioShortcut?: string;
	hideCode: boolean;
	natFix: boolean;
	compactOverlay: boolean;
	overlayPosition: string;
	enableOverlay: boolean;
	meetingOverlay: boolean;

	myLobbySettings: ILobbySettings;
	ghostVolumeAsImpostor: number;
	crewVolumeAsGhost: number;
	masterVolume: number;
	microphoneGain: number;
	microphoneGainEnabled: boolean;
	voiceEffectStrength: number;
	snrPushReverbStrength: number;
	snrJumboVoiceEffectStrength: number;
	nosSizeVoiceEffectStrength: number;
	nosRokurokubiVoiceEffectStrength: number;
	nosBerserkerVoiceEffectStrength: number;
	nosCitrusVoiceEffectStrength: number;
	nosRainbowStarEchoStrength: number;
	nosVoiceJammingEffectStrength: number;
	nosMegaphoneEffectStrength: number;
	nosBibiriEchoStrength: number;
	micSensitivity: number;
	micSensitivityEnabled: boolean;
	mobileHost: boolean;
	hardware_acceleration: boolean;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	autoGainControl: boolean;
	oldSampleDebug: boolean;

	enableSpatialAudio: boolean;
	oldSampleDebug: boolean;
	playerConfigMap: playerConfigMap;
	obsOverlay: boolean;
	obsSecret: string | undefined;

	launchPlatform: GamePlatform | string;
	customPlatforms: GamePlatformMap;
}

export interface ILobbySettings {
	maxDistance: number;
	visionHearing: boolean;
	haunting: boolean;
	snrJumboVoice: boolean;
	snrPushReverb: boolean;
	snrJumboVoiceEffectStrength: number;
	jackalHaunting: boolean;
	jackalHearOutsideVents: boolean;
	jackalTalkInVents: boolean;
	jackalRadioEnabled: boolean;
	sidekickHaunting: boolean;
	sidekickHearOutsideVents: boolean;
	sidekickTalkInVents: boolean;
	nosNeutralKillerHaunting: boolean;
	nosVoicePositions: boolean;
	nosSizeVoiceEffect: boolean;
	nosSizeVoiceEffectStrength: number;
	nosBerserkerVoiceEffect: boolean;
	nosBerserkerVoiceEffectStrength: number;
	nosRokurokubiVoiceEffect: boolean;
	nosRokurokubiVoiceEffectStrength: number;
	nosCitrusVoiceEffect: boolean;
	nosCitrusVoiceEffectStrength: number;
	nosRainbowStarEcho: boolean;
	nosRainbowStarEchoStrength: number;
	nosVoiceJammingEffectStrength: number;
	nosMegaphoneEffectStrength: number;
	nosBibiriEchoStrength: number;
	nosFixerJammingVoiceBlock: boolean;
	nosFixerJammingLowpass: boolean;
	tohNeutralKillerHaunting: boolean;
	tohGhostRoles?: Record<string, boolean>;
	hearImpostorsInVents: boolean;
	impostersHearImpostersInvent: boolean;
	impostorRadioEnabled: boolean;
	impostorRadioOnlyMode: boolean;
	commsSabotage: boolean;
	voiceEffectEnabled: boolean;
	deadOnly: boolean;
	meetingGhostOnly: boolean;
	hearThroughCameras: boolean;
	wallsBlockAudio: boolean;
	publicLobby_on: boolean;
	publicLobby_title: string;
	publicLobby_language: string;
}

export interface SocketConfig {
	volume: number;
	isMuted: boolean;
}

export interface playerConfigMap {
	[socketId: number]: SocketConfig;
}
