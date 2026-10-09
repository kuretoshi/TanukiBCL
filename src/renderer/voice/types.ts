import type { ConnectionQuality } from './connectionQuality';
import { AudioConnected, ClientBoolMap, SocketClientMap, numberStringMap } from '../../common/AmongUsState';
import { ILobbySettings } from '../../common/ISettings';
import type { VoiceProcessingEffect } from './sourceFilterEffect';
import type { TohRole, TohRoleDefinition } from '../../common/TohRole';
import type { NosRadioData } from '../../common/NosSnapshot';

export interface ExtendedAudioElement extends HTMLAudioElement {
	setSinkId: (sinkId: string) => Promise<void>;
}

export interface PeerAudioNodes {
	voiceEffect?: VoiceProcessingEffect;
	voiceEffectConnected: boolean;
	stream: MediaStream;
	dummyAudioElement: HTMLAudioElement;
	gain: GainNode;
	pan: PannerNode;
	reverb: ConvolverNode;
	radioEcho: RadioEchoNodes;
	starEcho?: RadioEchoNodes;
	starEchoConnected?: boolean;
	muffle: BiquadFilterNode;
	source: MediaStreamAudioSourceNode;
	reverbConnected: boolean;
	radioEchoConnected: boolean;
	muffleConnected: boolean;
}

export interface RadioEchoNodes {
	input: GainNode;
	output: GainNode;
	dry: GainNode;
	wet: GainNode;
	delay: DelayNode;
	feedback: GainNode;
}

export interface ClientPeerConfig {
	forceRelayOnly: boolean;
	iceServers: RTCIceServer[];
}

export const DEFAULT_ICE_CONFIG: RTCConfiguration = {
	iceTransportPolicy: 'all',
	iceServers: [
		{
			urls: 'stun:stun.l.google.com:19302',
		},
	],
};

export const DEFAULT_ICE_CONFIG_TURN: RTCConfiguration = {
	iceTransportPolicy: 'relay',
	iceServers: [
		{
			urls: 'turn:turn.bettercrewl.ink:3478',
			username: 'M9DRVaByiujoXeuYAAAG',
			credential: 'TpHR9HQNZ8taxjb3',
		},
	],
};

export { defaultLobbySettings } from '../../common/defaultLobbySettings';

export interface VoiceSnapshot {
	versionWarning: string;
	connected: boolean;
	error: string;
	talking: boolean;
	muted: boolean;
	deafened: boolean;
	otherTalking: ClientBoolMap;
	otherDead: ClientBoolMap;
	socketClients: SocketClientMap;
	playerSocketIds: numberStringMap;
	audioConnected: AudioConnected;
	connectionQuality: Record<string, ConnectionQuality | undefined>;
	serverQuality?: ConnectionQuality;
	impostorRadioClientId: number;
	impostorRadioClientIds: number[];
	activeLobbySettings: ILobbySettings | null;
	hostId: number;
	toh4eLobby: boolean;
	tohRole: TohRole | null;
	tohRoleCatalog: TohRoleDefinition[];
	tohGameStartNames: numberStringMap;
	nosRadiosByPlayer: Record<number, { clientId: number; radios: NosRadioData[]; receivedAt: number }>;
}
