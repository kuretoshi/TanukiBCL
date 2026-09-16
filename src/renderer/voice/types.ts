import type { ConnectionQuality } from './connectionQuality';
import { AudioConnected, ClientBoolMap, SocketClientMap, numberStringMap } from '../../common/AmongUsState';
import { ILobbySettings } from '../../common/ISettings';
import type { VoiceDisguiseEffect } from '../voiceEffect';

export interface ExtendedAudioElement extends HTMLAudioElement {
	setSinkId: (sinkId: string) => Promise<void>;
}

export interface PeerAudioNodes {
	voiceEffect?: VoiceDisguiseEffect;
	voiceEffectConnected: boolean;
	stream: MediaStream;
	dummyAudioElement: HTMLAudioElement;
	gain: GainNode;
	pan: PannerNode;
	reverb: ConvolverNode;
	muffle: BiquadFilterNode;
	source: MediaStreamAudioSourceNode;
	reverbConnected: boolean;
	muffleConnected: boolean;
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
	impostorRadioClientId: number;
	activeLobbySettings: ILobbySettings | null;
	hostId: number;
}
