import React, { Suspense, lazy, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { CompatibleSocketVersion, connectCompatibleSocket } from './socket';
import { GameStateContext, HostSettingsContext, PlayerColorContext, SettingsContext } from './contexts';
import {
	AmongUsState,
	GameState,
	Player,
	SocketClientMap,
	AudioConnected,
	ClientBoolMap,
	numberStringMap,
	Client,
	VoiceState,
} from '../common/AmongUsState';
import Peer from 'simple-peer';
import { ipcRenderer } from 'electron';
import VAD from './vad';
import { ISettings, playerConfigMap, SocketConfig } from '../common/ISettings';
import { IpcRendererMessages, IpcMessages, IpcOverlayMessages, IpcHandlerMessages } from '../common/ipc-messages';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import makeStyles from '@mui/styles/makeStyles';
import SupportLink from './SupportLink';
import Divider from '@mui/material/Divider';
import { validateClientPeerConfig } from './validateClientPeerConfig';
// @ts-ignore
import reverbOgx from 'arraybuffer-loader!../../static/sounds/reverb.ogx'; // @ts-ignore
import radioOnSound from '../../static/sounds/radio_on.wav'; // @ts-ignore
import liteCrewmateImage from '../../static/images/lite/crew.png'; // @ts-ignore
import liteVisorImage from '../../static/images/lite/visor.png'; // @ts-ignore

import { CameraLocation, AmongUsMaps, MapType } from '../common/AmongusMap';
import { defaultLobbySettings } from '../common/defaultLobbySettings';
import { ObsVoiceState } from '../common/ObsOverlay';
import Footer from './Footer';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Slider from '@mui/material/Slider';
import VolumeOff from '@mui/icons-material/VolumeOff';
import VolumeUp from '@mui/icons-material/VolumeUp';
import Mic from '@mui/icons-material/Mic';
import MicOff from '@mui/icons-material/MicOff';
import WifiOff from '@mui/icons-material/WifiOff';
import LinkOff from '@mui/icons-material/LinkOff';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import Tooltip from 'react-tooltip-lite';
import adapter from 'webrtc-adapter';
import { VADOptions } from './vad';
import { pushToTalkOptions } from './settings/SettingsStore';
import { poseCollide } from '../common/ColliderMap';
import {
	createVoiceDisguiseEffect,
	disconnectVoiceDisguiseEffect,
	updateVoiceDisguiseEffect,
	VoiceDisguiseEffect,
} from './voiceEffect';

console.log(adapter.browserDetails.browser);

const isLiteApp =
	typeof window !== 'undefined' && new URLSearchParams(window.location.search.substring(1)).get('lite') === '1';
const queryParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search.substring(1)) : undefined;
const RichAvatar = lazy(() => import('./Avatar'));

interface VoiceAvatarProps {
	talking: boolean;
	borderColor: string;
	isAlive: boolean;
	player: Player;
	size: number;
	deafened?: boolean;
	muted?: boolean;
	connectionState?: 'disconnected' | 'novoice' | 'connected';
	socketConfig?: SocketConfig;
	showborder?: boolean;
	isUsingRadio?: boolean;
	onConfigChange?: () => void;
	mod: any;
	colorPalette?: string[];
}

export interface ExtendedAudioElement extends HTMLAudioElement {
	setSinkId: (sinkId: string) => Promise<void>;
}

interface PeerConnections {
	[peer: string]: Peer.Instance;
}

interface VadNode {
	connect: () => void;
	destroy: () => void;
	options: VADOptions;
	init: () => void;
}

interface AudioNodes {
	dummyAudioElement: HTMLAudioElement;
	audioElement: HTMLAudioElement;
	gain: GainNode;
	pan: PannerNode;
	reverb: ConvolverNode;
	muffle: BiquadFilterNode;
	voiceEffect: VoiceDisguiseEffect;
	destination: AudioNode;
	reverbConnected: boolean;
	muffleConnected: boolean;
	voiceEffectConnected: boolean;
	voiceDisguiseActive: boolean;
}

interface AudioElements {
	[peer: string]: AudioNodes;
}

interface ConnectionStuff {
	socket?: typeof Socket;
	overlaySocket?: typeof Socket;
	stream?: MediaStream;
	instream?: MediaStream;

	microphoneGain?: GainNode;
	audioListener?: VadNode;
	pushToTalkMode: number;
	deafened: boolean;
	muted: boolean;
	impostorRadio: boolean | null;
	toggleMute: () => void;
	toggleDeafen: () => void;
}

interface SocketError {
	message?: string;
}

interface ClientPeerConfig {
	forceRelayOnly: boolean;
	iceServers: RTCIceServer[];
}

interface DisplayAppearance {
	colorId: number;
	hatId: string;
	skinId: string;
	visorId: string;
}

interface AppearanceBaseline {
	[clientId: number]: string;
}

type VoiceDisguiseMode = 'none' | 'mixup';

const voiceDebugEnabled =
	queryParams?.get('debugVoice') === '1' ||
	process.env.BETTERCREWLINK_DEBUG_OVERLAY === '1' ||
	process.argv.some((arg) => arg === '--debug-voice' || arg === '--debugVoice') ||
	/debug/i.test(process.execPath);

interface VoiceDebugOverlayState {
	map: string | number;
	mod: string | undefined;
	gameState: string | undefined;
	audioGameState: string | undefined;
	airshipMeetingAudioFallback: boolean;
	airshipSpawnAudioFallback: boolean;
	meetingHud: number | undefined;
	meetingHudCachePtr: number | undefined;
	meetingHudState: number | undefined;
	rawGameState: number | undefined;
	onlineScene: number | undefined;
	mainMenuScene: number | undefined;
	localTaskPtr: number | undefined;
	localObjectFlags: string | undefined;
	initPatternDebug: string | undefined;
	airshipMeetingByOutfit: boolean | undefined;
	currentOutfits: string | undefined;
	localObjectDiffs: string | undefined;
	localPlayerDiffs: string | undefined;
	innerNetDiffs: string | undefined;
	localRoleTeam: number | undefined;
	localRoleLabel: string | undefined;
	localRolePtr: number | undefined;
	localRoleDiffs: string | undefined;
	localRoleSnapshot: string | undefined;
	socketIoVersion?: CompatibleSocketVersion;
	remoteName?: string;
	baseGain?: number;
	finalGain?: number;
	possibleBlocks: string[];
	updatedAt: number;
}

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
	iceTransportPolicy: 'all',
	iceServers: [
		{
			urls: 'stun:stun.l.google.com:19302',
		},
	],
};

const DEFAULT_ICE_CONFIG_TURN: RTCConfiguration = {
	iceTransportPolicy: 'relay',
	iceServers: [
		{
			urls: 'turn:turn.bettercrewl.ink:3478',
			username: 'M9DRVaByiujoXeuYAAAG',
			credential: 'TpHR9HQNZ8taxjb3',
		},
	],
};

const PEER_RECONNECT_DELAY_MS = 1500;
const PEER_TRACK_STALL_RECONNECT_MS = 4000;
const PEER_RELAY_FALLBACK_AFTER_ATTEMPTS = 2;
const AIRSHIP_SPAWN_AUDIO_GRACE_MS = 15000;
const SIGNAL_DEDUPE_MS = 1500;

export interface VoiceProps {
	t: (key: string) => string;
	error: string;
}

const useStyles = makeStyles((theme) => ({
	error: {
		position: 'absolute',
		top: '50%',
		transform: 'translateY(-50%)',
	},
	root: {
		paddingTop: theme.spacing(3),
	},
	top: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
	},
	right: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
	},
	username: {
		display: 'block',
		textAlign: 'center',
		fontSize: 20,
		whiteSpace: 'nowrap',
		maxWidth: '115px',
	},
	code: {
		fontFamily: "'Source Code Pro', monospace",
		display: 'block',
		width: 'fit-content',
		margin: '5px auto',
		padding: 5,
		borderRadius: 5,
		fontSize: 28,
	},
	otherplayers: {
		width: 225,
		height: 225,
		margin: '4px auto',
		'& .MuiGrid-grid-xs-1': {
			maxHeight: '8.3333333%',
		},
		'& .MuiGrid-grid-xs-2': {
			maxHeight: '16.666667%',
		},
		'& .MuiGrid-grid-xs-3': {
			maxHeight: '25%',
		},
		'& .MuiGrid-grid-xs-4': {
			maxHeight: '33.333333%',
		},
	},
	avatarWrapper: {
		width: 80,
		padding: theme.spacing(1),
	},
	muteButtons: {
		paddingLeft: '5px',
		paddingTop: '26px',
		float: 'right',
		display: 'grid',
	},
	left: { float: 'left' },
	debugOverlay: {
		position: 'fixed',
		left: 4,
		right: 4,
		bottom: 4,
		zIndex: 10000,
		padding: '4px 6px',
		borderRadius: 4,
		background: 'rgba(0, 0, 0, 0.82)',
		color: '#00ff8a',
		fontFamily: "'Source Code Pro', monospace",
		fontSize: 10,
		lineHeight: 1.25,
		pointerEvents: 'none',
		whiteSpace: 'pre-wrap',
		textShadow: '0 1px 1px #000',
	},
}));

const VoiceAvatar: React.FC<VoiceAvatarProps> = function (props: VoiceAvatarProps) {
	if (!isLiteApp) {
		return (
			<Suspense fallback={null}>
				<RichAvatar {...props} />
			</Suspense>
		);
	}

	const background = props.colorPalette?.[0] || '#6b7280';
	const avatarBorderColor =
		props.talking && props.connectionState === 'connected'
			? props.borderColor
			: props.showborder === true
				? '#ccbdcc86'
				: 'transparent';
	const scale = props.size / 100;
	const borderWidth = Math.max(2, props.size / 40);
	const avatarImageScale = props.size >= 80 ? 0.9 : 1;
	const imageWidth = Math.round(81 * scale * avatarImageScale);
	const imageHeight = Math.round(100 * scale * avatarImageScale);
	const imageLeft = Math.round((props.size - imageWidth) / 2);
	const imageTop = Math.round((props.size - imageHeight) / 2);
	const iconSize = Math.max(18, Math.round(30 * scale));
	const iconFontSize = Math.max(14, Math.round(20 * scale));
	const displayName = props.player.appearanceName || props.player.name;
	let statusIcon: React.ReactNode = null;

	if (props.player.bugged) {
		statusIcon = <ErrorOutline style={{ fontSize: iconFontSize, color: 'white' }} />;
	} else if (props.connectionState === 'disconnected') {
		statusIcon = <WifiOff style={{ fontSize: iconFontSize, color: 'white' }} />;
	} else if (props.connectionState === 'novoice') {
		statusIcon = <LinkOff style={{ fontSize: iconFontSize, color: 'white' }} />;
	} else if (props.connectionState === 'connected') {
		if (props.deafened === true || props.socketConfig?.isMuted === true || props.socketConfig?.volume === 0) {
			statusIcon = <VolumeOff style={{ fontSize: iconFontSize, color: 'white' }} />;
		} else if (props.muted === true) {
			statusIcon = <MicOff style={{ fontSize: iconFontSize, color: 'white' }} />;
		} else if (props.isUsingRadio) {
			statusIcon = <VolumeUp style={{ fontSize: iconFontSize, color: 'white' }} />;
		}
	}

	const avatar = (
		<div
			onClick={props.onConfigChange}
			style={{
				position: 'relative',
				width: props.size,
				height: props.size,
				boxSizing: 'border-box',
				borderRadius: '50%',
				borderStyle: 'solid',
				borderWidth,
				borderColor: avatarBorderColor,
				transition: 'border-color .2s ease-out, box-shadow .2s ease-out',
				boxShadow:
					props.talking && props.connectionState === 'connected'
						? `0 0 ${Math.max(6, Math.round(10 * scale))}px ${props.borderColor}`
						: 'none',
				opacity: props.isAlive ? 1 : 0.45,
				margin: '0 auto',
				cursor: 'pointer',
			}}
		>
			<div
				style={{
					position: 'absolute',
					left: Math.round(17 * scale),
					bottom: Math.round(2 * scale),
					width: Math.round(67 * scale),
					height: Math.round(13 * scale),
					borderRadius: '50%',
					background: 'rgba(0, 0, 0, 0.32)',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left: imageLeft,
					top: imageTop,
					width: imageWidth,
					height: imageHeight,
					filter: 'drop-shadow(0 2px 2px rgba(0, 0, 0, 0.35))',
				}}
			>
				<div
					style={{
						position: 'absolute',
						inset: 0,
						background,
						WebkitMaskImage: `url(${liteCrewmateImage})`,
						maskImage: `url(${liteCrewmateImage})`,
						WebkitMaskRepeat: 'no-repeat',
						maskRepeat: 'no-repeat',
						WebkitMaskSize: 'contain',
						maskSize: 'contain',
						WebkitMaskPosition: 'center',
						maskPosition: 'center',
					}}
				/>
				<img
					src={liteCrewmateImage}
					alt=""
					style={{
						position: 'absolute',
						inset: 0,
						width: '100%',
						height: '100%',
						objectFit: 'contain',
						mixBlendMode: 'multiply',
						opacity: 0.72,
						pointerEvents: 'none',
					}}
				/>
				<img
					src={liteVisorImage}
					alt=""
					style={{
						position: 'absolute',
						inset: 0,
						width: '100%',
						height: '100%',
						objectFit: 'contain',
						pointerEvents: 'none',
					}}
					/>
			</div>
			{statusIcon && (
				<div
					style={{
						position: 'absolute',
						right: -4,
						top: -4,
						width: iconSize,
						height: iconSize,
						borderRadius: '50%',
						background: props.connectionState === 'novoice' ? '#e67e22' : '#ea3c2a',
						border: props.connectionState === 'novoice' ? '2px solid #694900' : '2px solid #690a00',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						zIndex: 10,
					}}
				>
					{statusIcon}
				</div>
			)}
		</div>
	);

	if (!props.socketConfig) {
		return avatar;
	}

	return (
		<Tooltip
			mouseOutDelay={300}
			content={
				<div style={{ textAlign: 'center' }}>
					<b>{displayName}</b>
					<Grid container spacing={0} style={{ minWidth: 80 }}>
						<Grid item>
							<IconButton
								onClick={() => {
									if (props.socketConfig) {
										props.socketConfig.isMuted = !props.socketConfig.isMuted;
										props.onConfigChange?.();
									}
								}}
								style={{ margin: '1px 1px 0px 0px' }}
								size="large">
								{props.socketConfig.isMuted ? (
									<VolumeOff color="primary" />
								) : (
									<VolumeUp color="primary" />
								)}
							</IconButton>
						</Grid>
						<Grid item xs>
							<Slider
								size="small"
								value={props.socketConfig.volume}
								min={0}
								max={2}
								step={0.02}
								onChange={(_, newValue: number | number[]) => {
									if (props.socketConfig) {
										props.socketConfig.volume = newValue as number;
									}
								}}
								valueLabelDisplay="auto"
								valueLabelFormat={(value) => Math.floor(value * 100) + '%'}
								onMouseLeave={() => props.onConfigChange?.()}
								aria-labelledby="continuous-slider"
							/>
						</Grid>
					</Grid>
				</div>
			}
			padding={5}
		>
			{avatar}
		</Tooltip>
	);
};

const radioOnAudio = new Audio();
radioOnAudio.src = radioOnSound;
radioOnAudio.volume = 0.02;

// const radiobeepAudio2 = new Audio();
// radiobeepAudio2.src = radioBeep2;
// radiobeepAudio2.volume = 0.2;

const Voice: React.FC<VoiceProps> = function ({ t, error: initialError }: VoiceProps) {
	const [error, setError] = useState('');
	const [settings, setSetting] = useContext(SettingsContext);

	const settingsRef = useRef<ISettings>(settings);
	const [lobbySettings, setHostLobbySettings] = useContext(HostSettingsContext);
	const lobbySettingsRef = useRef(lobbySettings);
	const maxDistanceRef = useRef(2);
	const appearanceBaselineRef = useRef<AppearanceBaseline>({});
	const previousVoiceDisguiseModeRef = useRef<VoiceDisguiseMode>('none');
	const gameState = useContext(GameStateContext);
	const playerColors = useContext(PlayerColorContext);

	const hostRef = useRef({
		map: MapType.UNKNOWN,
		mobileRunning: false,
		gamestate: gameState.gameState,
		code: gameState.lobbyCode,
		hostId: gameState.hostId,
		parsedHostId: gameState.hostId,
		isHost: gameState.isHost,
		serverHostId: 0,
	});
	let { lobbyCode: displayedLobbyCode } = gameState;
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';
	const [talking, setTalking] = useState(false);
	const [socketClients, setSocketClients] = useState<SocketClientMap>({});
	const [playerConfigs] = useState<playerConfigMap>(settingsRef.current.playerConfigMap);
	const socketClientsRef = useRef(socketClients);
	const [peerConnections, setPeerConnections] = useState<PeerConnections>({});
	const peerConnectionsRef = useRef<PeerConnections>({});
	const reconnectTimers = useRef<{ [peer: string]: number }>({});
	const reconnectAttempts = useRef<{ [peer: string]: number }>({});
	const stalledAudioTimers = useRef<{ [peer: string]: number }>({});
	const intentionalDisconnects = useRef<{ [peer: string]: boolean }>({});
	const convolverBuffer = useRef<AudioBuffer | null>(null);
	const playerSocketIdsRef = useRef<numberStringMap>({});
	const gameStateDebugRef = useRef<string>('');
	const gameStateDebugTimeRef = useRef<number>(0);
	const voiceAvailabilityDebugRef = useRef<Record<string, string>>({});
	const voiceAvailabilityDebugTimeRef = useRef<Record<string, number>>({});
	const socketIoVersionRef = useRef<CompatibleSocketVersion | undefined>(undefined);
	const airshipSpawnAudioFallbackUntilRef = useRef<number>(0);
	const classes = useStyles();

	const [connect, setConnect] = useState<{
		connect: (lobbyCode: string, playerId: number, clientId: number, isHost: boolean) => void;
	} | null>(null);
	const [otherTalking, setOtherTalking] = useState<ClientBoolMap>({});
	const [otherVAD, setOtherVAD] = useState<ClientBoolMap>({});

	const [otherDead, setOtherDead] = useState<ClientBoolMap>({});
	const impostorRadioClientId = useRef<number>(-1);

	const audioElements = useRef<AudioElements>({});
	const [audioConnected, setAudioConnected] = useState<AudioConnected>({});

	const [deafenedState, setDeafened] = useState(false);
	const [mutedState, setMuted] = useState(false);
	const [connected, setConnected] = useState(false);
	const [voiceDebugOverlay, setVoiceDebugOverlay] = useState<VoiceDebugOverlayState | null>(null);

	function applyEffect(gain: AudioNode, effectNode: AudioNode, destination: AudioNode, player: Player) {
		console.log('Apply effect->', effectNode);
		try {
			gain.disconnect(destination);
			gain.connect(effectNode);
			effectNode.connect(destination);
		} catch {
			console.log('error with applying effect: ', player.name, effectNode);
		}
	}

	function restoreEffect(gain: AudioNode, effectNode: AudioNode, destination: AudioNode, player: Player) {
		console.log('restore effect->', effectNode);
		try {
			effectNode.disconnect(destination);
			gain.disconnect(effectNode);
			gain.connect(destination);
		} catch {
			console.log('error with applying effect: ', player.name, effectNode);
		}
	}

	function applyVoiceEffect(gain: AudioNode, effect: VoiceDisguiseEffect, destination: AudioNode, player: Player) {
		console.log('Apply voice disguise effect->', player.name);
		try {
			try {
				gain.disconnect();
			} catch {
				// Already disconnected.
			}
			try {
				effect.output.disconnect();
			} catch {
				// Already disconnected.
			}
			gain.connect(effect.input);
			effect.output.connect(destination);
		} catch {
			console.log('error with applying voice disguise effect: ', player.name);
		}
	}

	function resetAudioRoute(audio: AudioNodes, player: Player) {
		console.log('Reset audio route->', player.name);
		try {
			updateVoiceDisguiseEffect(audio.voiceEffect, 0);
			try {
				audio.voiceEffect.output.disconnect();
			} catch {
				// Already disconnected.
			}
			try {
				audio.muffle.disconnect();
			} catch {
				// Already disconnected.
			}
			try {
				audio.reverb.disconnect();
			} catch {
				// Already disconnected.
			}
			try {
				audio.gain.disconnect();
			} catch {
				// Already disconnected.
			}
			audio.gain.connect(audio.destination);
		} catch {
			console.log('error with resetting audio route: ', player.name);
		}

		audio.voiceEffectConnected = false;
		audio.voiceDisguiseActive = false;
		audio.reverbConnected = false;
		audio.muffleConnected = false;
	}

	function restoreTransientEffects(audio: AudioNodes, player: Player) {
		const { gain, muffle, reverb, destination } = audio;

		if (audio.voiceEffectConnected || audio.voiceDisguiseActive) {
			resetAudioRoute(audio, player);
			return;
		}
		if (audio.reverbConnected) {
			audio.reverbConnected = false;
			restoreEffect(gain, reverb, destination, player);
		}
		if (audio.muffleConnected) {
			audio.muffleConnected = false;
			restoreEffect(gain, muffle, destination, player);
		}
	}

	function restoreVoiceDisguiseRoute(audio: AudioNodes, player: Player) {
		resetAudioRoute(audio, player);
	}

	function getDisplayAppearance(player: Player): DisplayAppearance {
		const hasDisplayOutfit = player.currentOutfit > 0 && player.currentOutfit <= 10;
		return {
			colorId: hasDisplayOutfit && player.appearanceColorId >= 0 ? player.appearanceColorId : player.colorId,
			hatId: hasDisplayOutfit ? player.appearanceHatId || '' : player.hatId || '',
			skinId: hasDisplayOutfit ? player.appearanceSkinId || '' : player.skinId || '',
			visorId: hasDisplayOutfit ? player.appearanceVisorId || '' : player.visorId || '',
		};
	}

	function getOriginalAppearance(player: Player): DisplayAppearance {
		return {
			colorId: player.colorId,
			hatId: player.hatId || '',
			skinId: player.skinId || '',
			visorId: player.visorId || '',
		};
	}

	function normalizeHatId(hatId: string): string {
		return hatId === 'hat_NoHat' ? '' : hatId;
	}

	function normalizeSkinId(skinId: string): string {
		return skinId === 'skin_None' ? '' : skinId;
	}

	function normalizeVisorId(visorId: string): string {
		return visorId === 'visor_EmptyVisor' ? '' : visorId;
	}

	function getAppearanceKey(appearance: DisplayAppearance): string {
		return [
			appearance.colorId,
			normalizeHatId(appearance.hatId || ''),
			normalizeSkinId(appearance.skinId || ''),
			normalizeVisorId(appearance.visorId || ''),
		].join('|');
	}

	function captureAppearanceBaseline(players: Player[]) {
		appearanceBaselineRef.current = players.reduce((baseline: AppearanceBaseline, player) => {
			if (!player.disconnected && !player.bugged) {
				baseline[player.clientId] = getAppearanceKey(getDisplayAppearance(player));
			}
			return baseline;
		}, {});
	}

	function getBaselineAppearanceKey(player: Player): string {
		return appearanceBaselineRef.current[player.clientId] || getAppearanceKey(getOriginalAppearance(player));
	}

	function hasCurrentAppearanceChanged(player: Player): boolean {
		return getAppearanceKey(getDisplayAppearance(player)) !== getBaselineAppearanceKey(player);
	}

	function getVoiceDisguiseMode(state: AmongUsState, players: Player[] | undefined): VoiceDisguiseMode {
		if (state.gameState !== GameState.TASKS) {
			return 'none';
		}

		if (!players) {
			return 'none';
		}

		if (state.mixupSabotaged) {
			return 'mixup';
		}

		return 'none';
	}

	function isVoiceDisguiseEffectActive(player: Player, mode: VoiceDisguiseMode): boolean {
		if (mode === 'none') {
			return false;
		}

		if (player.disconnected || player.bugged || player.isDead) {
			return false;
		}

		return hasCurrentAppearanceChanged(player);
	}

	function canHearGhosts(player: Player): boolean {
		return (
			(player.isImpostor && lobbySettings.haunting) ||
			(player.isThirdParty && lobbySettings.thirdPartyHaunting)
		);
	}

	function getStateMap(state: AmongUsState): MapType {
		if (state.map !== undefined && MapType[state.map] !== undefined) {
			return state.map;
		}
		if (hostRef.current.map !== undefined && MapType[hostRef.current.map] !== undefined) {
			return hostRef.current.map;
		}
		return MapType.UNKNOWN;
	}

	function isAirshipMeetingAudioFallback(state: AmongUsState): boolean {
		const hasMeetingHudSignal =
			!!state.debug &&
			state.debug.meetingHudCachePtr !== 0 &&
			state.debug.meetingHudState >= 0 &&
			state.debug.meetingHudState < 4;
		const hasOutfitSignal = !!state.debug?.airshipMeetingByOutfit;

		return (
			state.gameState === GameState.TASKS &&
			getStateMap(state) === MapType.AIRSHIP &&
			(hasMeetingHudSignal || hasOutfitSignal)
		);
	}

	function isAirshipSpawnAudioFallback(state: AmongUsState): boolean {
		const hasSpawnHudSignal =
			!!state.debug &&
			state.debug.meetingHudState === 4;

		return (
			state.gameState === GameState.TASKS &&
			getStateMap(state) === MapType.AIRSHIP &&
			(hasSpawnHudSignal || Date.now() < airshipSpawnAudioFallbackUntilRef.current)
		);
	}

	function getAudioGameState(state: AmongUsState): GameState {
		return state.gameState;
	}

	useEffect(() => {
		const isAirshipTasks = getStateMap(gameState) === MapType.AIRSHIP && gameState?.gameState === GameState.TASKS;
		if (!isAirshipTasks) {
			airshipSpawnAudioFallbackUntilRef.current = 0;
			return;
		}

		const hasSpawnHudSignal =
			!!gameState.debug &&
			gameState.debug.meetingHudState === 4;
		if (gameState.oldGameState === GameState.DISCUSSION || hasSpawnHudSignal) {
			airshipSpawnAudioFallbackUntilRef.current = Date.now() + AIRSHIP_SPAWN_AUDIO_GRACE_MS;
		}
	}, [
		gameState?.map,
		gameState?.gameState,
		gameState?.oldGameState,
		gameState?.debug?.meetingHudCachePtr,
		gameState?.debug?.meetingHudState,
	]);

	useEffect(() => {
		if (!voiceDebugEnabled) {
			return;
		}
		const snapshot = {
			lobbyCode: gameState.lobbyCode,
			map: MapType[getStateMap(gameState)] || getStateMap(gameState),
			gameState: GameState[gameState.gameState],
			oldGameState: GameState[gameState.oldGameState],
			playerCount: gameState.players?.length || 0,
			localPlayer: gameState.players?.find((player) => player.isLocal)?.name,
			players: gameState.players?.map((player) => ({
				name: player.name,
				clientId: player.clientId,
				isLocal: player.isLocal,
				isDead: player.isDead,
				disconnected: player.disconnected,
				bugged: player.bugged,
			})),
			lobbySettings: {
				deadOnly: lobbySettings.deadOnly,
				meetingGhostOnly: lobbySettings.meetingGhostOnly,
				commsSabotage: lobbySettings.commsSabotage,
				wallsBlockAudio: lobbySettings.wallsBlockAudio,
				haunting: lobbySettings.haunting,
				thirdPartyHaunting: lobbySettings.thirdPartyHaunting,
			},
			stateFlags: {
				comsSabotaged: gameState.comsSabotaged,
				mixupSabotaged: gameState.mixupSabotaged,
				camouflaged: gameState.camouflaged,
				closedDoors: gameState.closedDoors,
			},
			readerDebug: gameState.debug,
			connected,
			muted: connectionStuff.current.muted,
			deafened: connectionStuff.current.deafened,
		};
		const serialized = JSON.stringify(snapshot);
		const now = Date.now();
		if (gameStateDebugRef.current !== serialized || now - gameStateDebugTimeRef.current > 2000) {
			gameStateDebugRef.current = serialized;
			gameStateDebugTimeRef.current = now;
			console.warn('[BetterCrewLinkKai game state debug]', snapshot);
			setVoiceDebugOverlay((current) => ({
				map: snapshot.map,
				mod: gameState.mod,
				gameState: snapshot.gameState,
				audioGameState: GameState[getAudioGameState(gameState)],
				airshipMeetingAudioFallback: isAirshipMeetingAudioFallback(gameState),
				airshipSpawnAudioFallback: isAirshipSpawnAudioFallback(gameState),
				meetingHud: gameState.debug?.meetingHud,
				meetingHudCachePtr: gameState.debug?.meetingHudCachePtr,
				meetingHudState: gameState.debug?.meetingHudState,
				rawGameState: gameState.debug?.rawGameState,
				onlineScene: gameState.debug?.onlineScene,
				mainMenuScene: gameState.debug?.mainMenuScene,
				localTaskPtr: gameState.debug?.localTaskPtr,
				localObjectFlags: gameState.debug?.localObjectFlags,
				initPatternDebug: gameState.debug?.initPatternDebug,
				airshipMeetingByOutfit: gameState.debug?.airshipMeetingByOutfit,
				currentOutfits: gameState.debug?.currentOutfits,
				localObjectDiffs: gameState.debug?.localObjectDiffs,
				localPlayerDiffs: gameState.debug?.localPlayerDiffs,
				innerNetDiffs: gameState.debug?.innerNetDiffs,
				localRoleTeam: gameState.debug?.localRoleTeam,
				localRoleLabel: gameState.debug?.localRoleLabel,
				localRolePtr: gameState.debug?.localRolePtr,
				localRoleDiffs: gameState.debug?.localRoleDiffs,
				localRoleSnapshot: gameState.debug?.localRoleSnapshot,
				socketIoVersion: socketIoVersionRef.current || current?.socketIoVersion,
				remoteName: current?.remoteName,
				baseGain: current?.baseGain,
				finalGain: current?.finalGain,
				possibleBlocks: current?.possibleBlocks || [],
				updatedAt: now,
			}));
		}
	}, [connected, gameState, lobbySettings]);

	function debugVoiceAvailability(
		state: AmongUsState,
		me: Player,
		other: Player,
		baseGain: number,
		finalGain: number,
		voiceDisguiseMode: VoiceDisguiseMode,
		extraBlocks: string[] = []
	) {
		if (!voiceDebugEnabled) {
			return;
		}
		const audioGameState = getAudioGameState(state);
		const possibleBlocks: string[] = [...extraBlocks];
		const wallCollides =
			lobbySettings.wallsBlockAudio &&
			!me.isDead &&
			(audioGameState === GameState.TASKS || (audioGameState === GameState.DISCUSSION && getStateMap(state) === MapType.AIRSHIP)) &&
			poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, getStateMap(state), state.closedDoors);
		if (!connected) possibleBlocks.push('not-connected');
		if (connectionStuff.current.muted) possibleBlocks.push('local-muted');
		if (connectionStuff.current.deafened) possibleBlocks.push('local-deafened');
		if (playerConfigs[other.nameHash]?.isMuted) possibleBlocks.push('remote-muted-by-user-config');
		if (other.disconnected) possibleBlocks.push('remote-disconnected');
		if (other.isDummy) possibleBlocks.push('remote-dummy');
		if (audioGameState === GameState.TASKS && lobbySettings.meetingGhostOnly) possibleBlocks.push('meeting-only-enabled');
		if (lobbySettings.deadOnly && !(audioGameState === GameState.DISCUSSION && getStateMap(state) === MapType.AIRSHIP)) {
			possibleBlocks.push('ghost-only-enabled');
		}
		if (audioGameState === GameState.TASKS && lobbySettings.commsSabotage && state.comsSabotaged && !me.isImpostor) {
			possibleBlocks.push('comms-sabotage');
		}
		if (audioGameState === GameState.TASKS && other.isDead && !me.isDead && !canHearGhosts(me)) {
			possibleBlocks.push('remote-is-dead');
		}
		if (wallCollides) possibleBlocks.push('wall-collision');
		if (baseGain <= 0 && possibleBlocks.length === 0) possibleBlocks.push('audio-rule-gain-zero');
		if (finalGain <= 0 && baseGain > 0 && possibleBlocks.length === 0) possibleBlocks.push('post-audio-gain-zero');

		const snapshot = {
			lobbyCode: state.lobbyCode,
			map: MapType[getStateMap(state)] || getStateMap(state),
			gameState: GameState[state.gameState],
			audioGameState: GameState[audioGameState],
			airshipMeetingAudioFallback: isAirshipMeetingAudioFallback(state),
			airshipSpawnAudioFallback: isAirshipSpawnAudioFallback(state),
			oldGameState: GameState[state.oldGameState],
			local: {
				name: me.name,
				clientId: me.clientId,
				isDead: me.isDead,
				isImpostor: me.isImpostor,
				isThirdParty: me.isThirdParty,
				talking,
				muted: connectionStuff.current.muted,
				deafened: connectionStuff.current.deafened,
				canSpeakNow: connected && talking && !connectionStuff.current.muted && !connectionStuff.current.deafened,
				position: { x: me.x, y: me.y },
			},
			remote: {
				name: other.name,
				clientId: other.clientId,
				isDead: other.isDead,
				isImpostor: other.isImpostor,
				isThirdParty: other.isThirdParty,
				inVent: other.inVent,
				disconnected: other.disconnected,
				bugged: other.bugged,
				vadTalking: !!otherVAD[other.clientId],
				mutedByUserConfig: !!playerConfigs[other.nameHash]?.isMuted,
				canHearOther: finalGain > 0,
				position: { x: other.x, y: other.y },
			},
			audio: {
				baseGain,
				finalGain,
				maxDistance: maxDistanceRef.current,
				voiceDisguiseMode,
			},
			lobbySettings: {
				deadOnly: lobbySettings.deadOnly,
				meetingGhostOnly: lobbySettings.meetingGhostOnly,
				commsSabotage: lobbySettings.commsSabotage,
				wallsBlockAudio: lobbySettings.wallsBlockAudio,
				haunting: lobbySettings.haunting,
				thirdPartyHaunting: lobbySettings.thirdPartyHaunting,
			},
			stateFlags: {
				comsSabotaged: state.comsSabotaged,
				mixupSabotaged: state.mixupSabotaged,
				camouflaged: state.camouflaged,
				closedDoors: state.closedDoors,
			},
			readerDebug: state.debug,
			possibleBlocks,
		};
		const key = `${other.clientId}`;
		const serialized = JSON.stringify(snapshot);
		const now = Date.now();
		if (voiceAvailabilityDebugRef.current[key] !== serialized || now - (voiceAvailabilityDebugTimeRef.current[key] || 0) > 2000) {
			voiceAvailabilityDebugRef.current[key] = serialized;
			voiceAvailabilityDebugTimeRef.current[key] = now;
			console.warn('[BetterCrewLinkKai voice availability]', snapshot);
			setVoiceDebugOverlay((current) => ({
				map: snapshot.map,
				mod: state.mod,
				gameState: snapshot.gameState,
				audioGameState: snapshot.audioGameState,
				airshipMeetingAudioFallback: snapshot.airshipMeetingAudioFallback,
				airshipSpawnAudioFallback: snapshot.airshipSpawnAudioFallback,
				meetingHud: state.debug?.meetingHud,
				meetingHudCachePtr: state.debug?.meetingHudCachePtr,
				meetingHudState: state.debug?.meetingHudState,
				rawGameState: state.debug?.rawGameState,
				onlineScene: state.debug?.onlineScene,
				mainMenuScene: state.debug?.mainMenuScene,
				localTaskPtr: state.debug?.localTaskPtr,
				localObjectFlags: state.debug?.localObjectFlags,
				initPatternDebug: state.debug?.initPatternDebug,
				airshipMeetingByOutfit: state.debug?.airshipMeetingByOutfit,
				currentOutfits: state.debug?.currentOutfits,
				localObjectDiffs: state.debug?.localObjectDiffs,
				localPlayerDiffs: state.debug?.localPlayerDiffs,
				innerNetDiffs: state.debug?.innerNetDiffs,
				localRoleTeam: state.debug?.localRoleTeam,
				localRoleLabel: state.debug?.localRoleLabel,
				localRolePtr: state.debug?.localRolePtr,
				localRoleDiffs: state.debug?.localRoleDiffs,
				localRoleSnapshot: state.debug?.localRoleSnapshot,
				socketIoVersion: socketIoVersionRef.current || current?.socketIoVersion,
				remoteName: other.name,
				baseGain,
				finalGain,
				possibleBlocks,
				updatedAt: now,
			}));
		}
	}

	function calculateVoiceAudio(
		state: AmongUsState,
		settings: ISettings,
		me: Player,
		other: Player,
		audio: AudioNodes,
		voiceDisguiseMode: VoiceDisguiseMode
	): number {
		const { pan, gain, muffle, reverb, voiceEffect, destination } = audio;
		const audioContext = pan.context;
		const useLightSource = true;
		const audioGameState = getAudioGameState(state);
		const map = getStateMap(state);
		let maxdistance = maxDistanceRef.current;
		let panPos = [other.x - me.x, other.y - me.y];
		let endGain = 0;
		let collided = false;
		let skipDistanceCheck = false;
		let muffleEnabled = false;
		let voiceEffectEnabled = false;
		const airshipSpawnAudioFallback = !me.isDead && isAirshipSpawnAudioFallback(state);
		const aliveHearingDeadInTasks = audioGameState === GameState.TASKS && !me.isDead && other.isDead;
		const canHearDeadInTasks = aliveHearingDeadInTasks && canHearGhosts(me);
		const voiceDisguiseActive = isVoiceDisguiseEffectActive(other, voiceDisguiseMode);
		const muteAudio = () => {
			restoreTransientEffects(audio, other);
			return 0;
		};
		if (audio.voiceDisguiseActive && !voiceDisguiseActive) {
			resetAudioRoute(audio, other);
		} else if (audio.voiceEffectConnected && !voiceDisguiseActive) {
			restoreVoiceDisguiseRoute(audio, other);
		}

		if (other.disconnected || other.isDummy) {
			return muteAudio();
		}

		switch (audioGameState) {
			case GameState.MENU:
				return muteAudio();
			case GameState.LOBBY:
				endGain = 1;
				break;

			case GameState.TASKS:
				endGain = 1;

				if (lobbySettings.meetingGhostOnly) {
					endGain = 0;
				}
				if (
					!me.isDead &&
					lobbySettings.commsSabotage &&
					state.comsSabotaged &&
					!me.isImpostor
				) {
					endGain = 0;
				}

				// Mute other players which are in a vent
				if (
					other.inVent &&
					!(lobbySettings.hearImpostorsInVents || (lobbySettings.impostersHearImpostersInvent && me.inVent))
				) {
					endGain = 0;
				}
				if (
					lobbySettings.wallsBlockAudio &&
					!me.isDead &&
					poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, map, state.closedDoors)
				) {
					collided = true;
				}
				if (airshipSpawnAudioFallback) {
					skipDistanceCheck = true;
					panPos = [0, 0];
				}
				if (
					me.isImpostor &&
					other.isImpostor &&
					lobbySettings.impostorRadioEnabled &&
					other.clientId === impostorRadioClientId.current
				) {
					skipDistanceCheck = true;
					muffle.type = 'highpass';
					muffle.frequency.value = 1000;
					muffle.Q.value = 10;
					muffleEnabled = true;
					if (!audio.muffleConnected) {
						audio.muffleConnected = true;
						applyEffect(gain, muffle, destination, other);
					}
				}
				if (
					voiceDisguiseActive &&
					lobbySettings.voiceEffectEnabled !== false &&
					settings.voiceEffectStrength > 0 &&
					!me.isDead &&
					!other.isDead &&
					!muffleEnabled
				) {
					updateVoiceDisguiseEffect(voiceEffect, settings.voiceEffectStrength);
					voiceEffectEnabled = true;
					audio.voiceDisguiseActive = true;
					if (!audio.voiceEffectConnected) {
						audio.voiceEffectConnected = true;
						applyVoiceEffect(gain, voiceEffect, destination, other);
					}
				}

				if (canHearDeadInTasks) {
					if (!audio.reverbConnected) {
						audio.reverbConnected = true;
						applyEffect(gain, reverb, destination, other);
					}
					endGain = settings.ghostVolumeAsImpostor / 100;
				} else if (other.isDead && !me.isDead) {
					endGain = 0;
				}
				break;
			case GameState.DISCUSSION:
				panPos = [0, 0];
				endGain = 1;
				if (!me.isDead && other.isDead) {
					endGain = 0;
				}
				if (
					map === MapType.AIRSHIP &&
					lobbySettings.wallsBlockAudio &&
					!me.isDead &&
					poseCollide({ x: me.x, y: me.y }, { x: other.x, y: other.y }, map, state.closedDoors)
				) {
					return muteAudio();
				}
				break;

			case GameState.UNKNOWN:
			default:
				return muteAudio();
		}

		if (useLightSource && state.lightRadiusChanged) {
			pan.maxDistance = maxDistanceRef.current;
		}

		if (!other.isDead || audioGameState !== GameState.TASKS || !canHearGhosts(me) || me.isDead) {
			if (audio.reverbConnected && reverb) {
				audio.reverbConnected = false;
				restoreEffect(gain, reverb, destination, other);
			}
		}

		if (aliveHearingDeadInTasks && !canHearDeadInTasks) {
			return muteAudio();
		}

		if (lobbySettings.deadOnly) {
			panPos = [0, 0];
			if (!me.isDead || !other.isDead) {
				endGain = 0;
			}
		}

		let isOnCamera = state.currentCamera !== CameraLocation.NONE;
		if (!skipDistanceCheck && Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]) > maxdistance) {
			if (lobbySettings.hearThroughCameras && audioGameState === GameState.TASKS) {
				if (state.currentCamera !== CameraLocation.NONE && state.currentCamera !== CameraLocation.Skeld) {
					const camerapos = AmongUsMaps[map].cameras[state.currentCamera];
					panPos = [other.x - camerapos.x, other.y - camerapos.y];
					console.log('camerapos: ', camerapos);
				} else if (state.currentCamera === CameraLocation.Skeld) {
					let distance = 999;
					let camerapos = { x: 999, y: 999 };
					for (const camera of Object.values(AmongUsMaps[map].cameras)) {
						const cameraDist = Math.sqrt(Math.pow(other.x - camera.x, 2) + Math.pow(other.y - camera.y, 2));
						if (distance > cameraDist) {
							distance = cameraDist;
							camerapos = camera;
						}
					}
					if (distance != 999) {
						panPos = [other.x - camerapos.x, other.y - camerapos.y];
					}
				}

				if (Math.sqrt(panPos[0] * panPos[0] + panPos[1] * panPos[1]) > maxdistance) {
					return muteAudio();
				}
			} else {
				return muteAudio();
			}
		} else {
			isOnCamera = false;
		}

		if (collided && (!skipDistanceCheck || airshipSpawnAudioFallback)) {
			return muteAudio();
		}

		// Muffling in vents
		if (
			((me.inVent && !me.isDead) || (other.inVent && !other.isDead) || isOnCamera) &&
			audioGameState === GameState.TASKS
		) {
			if (!audio.muffleConnected) {
				audio.muffleConnected = true;
				applyEffect(gain, muffle, destination, other);
			}
			maxdistance = isOnCamera ? 3 : 0.8;
			muffle.frequency.value = isOnCamera ? 2300 : 2000;
			muffle.Q.value = isOnCamera ? -15 : 20;
			if (endGain === 1) endGain = isOnCamera ? 0.8 : 0.5; // Too loud at 1
		} else {
			if (audio.muffleConnected && !muffleEnabled) {
				audio.muffleConnected = false;
				restoreEffect(gain, muffle, destination, other);
			}
		}
		if (audio.voiceEffectConnected && !voiceEffectEnabled) {
			restoreVoiceDisguiseRoute(audio, other);
		}
		if (endGain <= 0) {
			restoreTransientEffects(audio, other);
		}

		if (!settings.enableSpatialAudio || skipDistanceCheck) {
			panPos = [0, 0];
		}

		pan.positionX.setValueAtTime(panPos[0], audioContext.currentTime);
		pan.positionY.setValueAtTime(panPos[1], audioContext.currentTime);
		pan.positionZ.setValueAtTime(-0.5, audioContext.currentTime);
		return endGain;
	}

	function notifyMobilePlayers() {
		if (
			settingsRef.current.mobileHost &&
			hostRef.current.gamestate !== GameState.MENU &&
			hostRef.current.gamestate !== GameState.UNKNOWN
		) {
			connectionStuff.current.socket?.emit('signal', {
				to: hostRef.current.code + '_mobile',
				data: { mobileHostInfo: { isHostingMobile: true, isGameHost: hostRef.current.isHost } },
			});
		}
		setTimeout(() => notifyMobilePlayers(), 5000);
	}

	function disconnectAudioHtmlElement(element: HTMLAudioElement) {
		console.log('disableing element?', element);
		element.pause();
		if (element.srcObject) {
			const mediaStream = element.srcObject as MediaStream;
			mediaStream.getTracks().forEach((track) => track.stop());
		}
		element.removeAttribute('srcObject');
		element.removeAttribute('src');
		element.srcObject = null;
		element.load();
		element.remove();
	}
	function disconnectAudioElement(peer: string) {
		if (audioElements.current[peer]) {
			console.log('removing element..');
			disconnectAudioHtmlElement(audioElements.current[peer].audioElement);
			disconnectAudioHtmlElement(audioElements.current[peer].dummyAudioElement);
			audioElements.current[peer].pan.disconnect();
			audioElements.current[peer].gain.disconnect();
			// if (audioElements.current[peer].reverbGain != null) audioElements.current[peer].reverbGain?.disconnect();
			if (audioElements.current[peer].reverb != null) audioElements.current[peer].reverb?.disconnect();
			disconnectVoiceDisguiseEffect(audioElements.current[peer].voiceEffect);
			delete audioElements.current[peer];
		}
	}

	function clearReconnectTimer(peer: string) {
		if (reconnectTimers.current[peer]) {
			window.clearTimeout(reconnectTimers.current[peer]);
			delete reconnectTimers.current[peer];
		}
	}

	function clearStalledAudioTimer(peer: string) {
		if (stalledAudioTimers.current[peer]) {
			window.clearTimeout(stalledAudioTimers.current[peer]);
			delete stalledAudioTimers.current[peer];
		}
	}

	function removePeerConnection(peer: string) {
		delete peerConnectionsRef.current[peer];
		setPeerConnections({ ...peerConnectionsRef.current });
		setAudioConnected((old) => ({ ...old, [peer]: false }));
		clearStalledAudioTimer(peer);
		disconnectAudioElement(peer);
	}

	function disconnectClient(client: Client) {
		if (!client || !client.clientId)
			return;
		const oldSocketId = playerSocketIdsRef.current[client.clientId];
		console.log("Checking for  old connection ....", client.clientId, oldSocketId)
		if (oldSocketId && audioElements.current[oldSocketId]) {
			console.log("found old connection disconnecting....", client.clientId)
			disconnectPeer(oldSocketId);
		}
	}

	function disconnectPeer(peer: string) {
		console.log('Disconnect peer: ', peer);
		clearReconnectTimer(peer);
		intentionalDisconnects.current[peer] = true;
		const connection = peerConnectionsRef.current[peer];
		if (!connection) {
			removePeerConnection(peer);
			return;
		}
		connection.destroy();
		removePeerConnection(peer);
	}
	// Handle pushToTalk, if set
	useEffect(() => {
		if (!connectionStuff.current.instream) return;
		connectionStuff.current.instream.getAudioTracks()[0].enabled =
			!connectionStuff.current.deafened &&
			!connectionStuff.current.muted &&
			settings.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
		connectionStuff.current.pushToTalkMode = settings.pushToTalkMode;
	}, [settings.pushToTalkMode]);

	// Emit lobby settings to connected peers
	useEffect(() => {
		if (hostRef.current.isHost !== true) return;
		Object.values(peerConnections).forEach((peer) => {
			try {
				console.log('sendxx > ', JSON.stringify(settings.localLobbySettings));
				peer.send(JSON.stringify(settings.localLobbySettings));
			} catch (e) {
				console.warn('failed to update lobby settings: ', e);
			}
		});

		setHostLobbySettings(settings.localLobbySettings);
	}, [settings.localLobbySettings, hostRef.current.isHost]);

	useEffect(() => {
		for (const peer in audioElements.current) {
			audioElements.current[peer].pan.maxDistance = maxDistanceRef.current;
		}
	}, [lobbySettings.maxDistance, lobbySettings.visionHearing]);

	useEffect(() => {
		if (
			!gameState ||
			!gameState.players ||
			!connectionStuff.current.socket ||
			(!hostRef.current.mobileRunning && !settings.obsOverlay)
		) {
			return;
		}
		if (hostRef.current.mobileRunning) {
			connectionStuff.current.socket?.emit('signal', {
				to: gameState.lobbyCode + '_mobile',
				data: { gameState, lobbySettings },
			});
		}

		if (
			settings.obsOverlay &&
			settings.obsSecret &&
			settings.obsSecret.length === 9 &&
			((gameState.gameState !== GameState.UNKNOWN && gameState.gameState !== GameState.MENU) ||
				gameState.oldGameState !== gameState.gameState)
		) {
			connectionStuff.current.overlaySocket = connectionStuff.current.socket;

			const obsvoiceState: ObsVoiceState = {
				overlayState: {
					gameState: gameState.gameState,
					players: gameState.players.map((o) => ({
						id: o.id,
						clientId: o.clientId,
						inVent: o.inVent,
						isDead: o.isDead,
						name: o.name,
						colorId: o.colorId,
						hatId: o.hatId,
						petId: o.petId,
						skinId: o.skinId,
						visorId: o.visorId,
						disconnected: o.disconnected,
						isLocal: o.isLocal,
						shiftedColor: o.shiftedColor,
						bugged: o.bugged,
						realColor: playerColors[o.colorId],
						usingRadio: o.clientId === impostorRadioClientId.current && myPlayer?.isImpostor,
						connected:
							(playerSocketIdsRef.current[o.clientId] &&
								socketClients[playerSocketIdsRef.current[o.clientId]]?.clientId === o.clientId) ||
							false,
					})),
				},
				otherTalking,
				otherDead,
				localTalking: talking,
				localIsAlive: !myPlayer?.isDead,
				mod: gameState.mod,
				oldMeetingHud: gameState.oldMeetingHud,
			};
			connectionStuff.current.overlaySocket?.emit('signal', {
				to: settings.obsSecret,
				data: obsvoiceState,
			});
		}
	}, [gameState]);

	// Add settings to settingsRef
	useEffect(() => {
		settingsRef.current = settings;
	}, [settings]);

	// Add socketClients to socketClientsRef
	useEffect(() => {
		socketClientsRef.current = socketClients;
	}, [socketClients]);

	useEffect(() => {
		if (connectionStuff.current?.microphoneGain?.gain) {
			if (!settingsRef.current.micSensitivityEnabled)
				connectionStuff.current.microphoneGain.gain.value = settings.microphoneGainEnabled
					? settings.microphoneGain / 100
					: 1;

			if (connectionStuff.current?.audioListener?.options) {
				connectionStuff.current.audioListener.options.minNoiseLevel = settings.micSensitivityEnabled
					? settings.micSensitivity
					: 0.15;
				connectionStuff.current.audioListener.init();
			}
		}
	}, [settings.microphoneGain, settings.microphoneGainEnabled, settings.micSensitivity, settings.micSensitivityEnabled]);

	useEffect(() => {
		Object.values(audioElements.current).forEach((audio) => {
			updateVoiceDisguiseEffect(audio.voiceEffect, settings.voiceEffectStrength);
		});
	}, [settings.voiceEffectStrength]);

	const updateLobby = () => {
		console.log(gameState);
		if (
			isLiteApp ||
			!gameState ||
			!hostRef.current.isHost ||
			!gameState.lobbyCode ||
			gameState.gameState === GameState.MENU ||
			!gameState.players
		) {
			return;
		}
		connectionStuff.current.socket?.emit('lobby', gameState.lobbyCode, {
			id: -1,
			title: lobbySettings.publicLobby_title,
			host: myPlayer?.name,
			current_players: gameState.players.length,
			max_players: gameState.maxPlayers,
			server: gameState.currentServer,
			language: lobbySettings.publicLobby_language,
			mods: gameState.mod,
			isPublic: lobbySettings.publicLobby_on,
			gameState: gameState.gameState,
		});
	};

	useEffect(() => {
		if (gameState.isHost && gameState.hostId > 0) {
			connectionStuff.current.socket?.emit('setHost', gameState.lobbyCode, gameState.clientId);
			hostRef.current.serverHostId = gameState.hostId;
		}
	}, [gameState.isHost]);

	useEffect(() => {
		if (isLiteApp) {
			return;
		}
		updateLobby();
	}, [
		gameState.gameState,
		gameState?.players?.length,
		lobbySettings.publicLobby_title,
		lobbySettings.publicLobby_language,
		lobbySettings.publicLobby_on,
	]);

	// Add lobbySettings to lobbySettingsRef
	useEffect(() => {
		lobbySettingsRef.current = lobbySettings;
	}, [lobbySettings]);



	// Set dead player data
	useEffect(() => {
		if (gameState.gameState === GameState.LOBBY) {
			setOtherDead({});
		} else if (gameState.gameState !== GameState.TASKS) {
			if (!gameState.players) return;
			setOtherDead((old) => {
				for (const player of gameState.players) {
					old[player.clientId] = player.isDead || player.disconnected;
				}
				return { ...old };
			});
		}
	}, [gameState.gameState]);

	useEffect(() => {
		if (!gameState.players) {
			return;
		}

		if (gameState.gameState === GameState.LOBBY) {
			captureAppearanceBaseline(gameState.players);
			previousVoiceDisguiseModeRef.current = 'none';
			return;
		}

		if (gameState.gameState === GameState.MENU || gameState.gameState === GameState.UNKNOWN) {
			appearanceBaselineRef.current = {};
			previousVoiceDisguiseModeRef.current = 'none';
		}
	}, [gameState.gameState, gameState.lobbyCode, gameState.players]);

	useEffect(() => {
		if (gameState.gameState !== GameState.TASKS || !gameState.players) {
			previousVoiceDisguiseModeRef.current = 'none';
			return;
		}

		const voiceDisguiseMode = getVoiceDisguiseMode(gameState, gameState.players);
		const previousVoiceDisguiseMode = previousVoiceDisguiseModeRef.current;
		previousVoiceDisguiseModeRef.current = voiceDisguiseMode;

		if (Object.keys(appearanceBaselineRef.current).length === 0 && voiceDisguiseMode === 'none') {
			captureAppearanceBaseline(gameState.players);
		}

		const playersByClientId = new Map(gameState.players.map((player) => [player.clientId, player]));
		if (previousVoiceDisguiseMode !== 'none' && voiceDisguiseMode === 'none') {
			for (const [peerId, audio] of Object.entries(audioElements.current)) {
				if (audio.voiceEffectConnected || audio.voiceDisguiseActive) {
					const clientId = socketClientsRef.current[peerId]?.clientId;
					const player = clientId === undefined ? undefined : playersByClientId.get(clientId);
					resetAudioRoute(audio, player || ({ name: peerId } as Player));
				}
			}
			return;
		}

		for (const player of gameState.players) {
			const peerId = playerSocketIdsRef.current[player.clientId];
			const audio = peerId ? audioElements.current[peerId] : undefined;
			if (audio && (audio.voiceEffectConnected || audio.voiceDisguiseActive)) {
				if (!isVoiceDisguiseEffectActive(player, voiceDisguiseMode)) {
					resetAudioRoute(audio, player);
				}
			}
		}
		for (const [peerId, audio] of Object.entries(audioElements.current)) {
			const clientId = socketClientsRef.current[peerId]?.clientId;
			const player = clientId === undefined ? undefined : playersByClientId.get(clientId);
			if ((audio.voiceEffectConnected || audio.voiceDisguiseActive) && !player) {
				resetAudioRoute(audio, { name: peerId } as Player);
			}
		}
	}, [gameState]);

	// const [audioContext] = useState<AudioContext>(() => new AudioContext());
	const connectionStuff = useRef<ConnectionStuff>({
		pushToTalkMode: settings.pushToTalkMode,
		deafened: false,
		muted: false,
		impostorRadio: null,
		toggleMute: () => {
			/*empty*/
		},
		toggleDeafen: () => {
			/*empty*/
		},
	});

	useEffect(() => {
		(async () => {
			const context = new AudioContext();
			convolverBuffer.current = await context.decodeAudioData(reverbOgx);
			await context.close();
		})();
	}, []);

	useEffect(() => {
		const pressing = connectionStuff.current.impostorRadio;
		if (
			pressing == null ||
			!myPlayer ||
			!myPlayer.isImpostor ||
			myPlayer.isDead ||
			!(impostorRadioClientId.current === myPlayer.clientId || impostorRadioClientId.current === -1) ||
			!lobbySettingsRef.current.impostorRadioEnabled
		) {
			return;
		}
		radioOnAudio.play();
		connectionStuff.current.impostorRadio = pressing;
		impostorRadioClientId.current = pressing ? myPlayer.clientId : -1;
		for (const player of otherPlayers.filter((o) => o.isImpostor && !o.bugged && !o.isDead)) {
			const peer = playerSocketIdsRef.current[player.clientId];
			const connection = peerConnectionsRef.current[peer];
			if (connection !== undefined && connection.writable)
				connection?.send(JSON.stringify({ impostorRadio: connectionStuff.current.impostorRadio }));
		}
	}, [connectionStuff.current.impostorRadio]);

	useEffect(() => {
		// (async function anyNameFunction() {
		let currentLobby = '';
		// Connect to voice relay server
		connectionStuff.current.socket = connectCompatibleSocket(settings.serverURL);

		const { socket } = connectionStuff.current;

		socket.on('error', (error: SocketError) => {
			if (error.message) {
				setError(error.message);
			}
			console.error('socketIO error:', error);
			currentLobby = 'MENU';
		});
		socket.on('connect', () => {
			setConnected(true);
			console.log('CONNECTED??');
		});
		socket.on('compatible_socket_version', (socketIoVersion: CompatibleSocketVersion) => {
			socketIoVersionRef.current = socketIoVersion;
			console.log(`Socket.IO debug version: ${socketIoVersion}`);
			setVoiceDebugOverlay((current) => (current ? { ...current, socketIoVersion } : current));
		});

		socket.on('setHost', (hostId: number) => {
			hostRef.current.serverHostId = hostId;
		});

		socket.on('disconnect', () => {
			setConnected(false);
			currentLobby = 'MENU';
			console.log('DISCONNECTED??');
		});

		notifyMobilePlayers();

		let iceConfig: RTCConfiguration = DEFAULT_ICE_CONFIG;
		socket.on('clientPeerConfig', (clientPeerConfig: ClientPeerConfig) => {
			if (!validateClientPeerConfig(clientPeerConfig)) {
				let errorsFormatted = '';
				if (validateClientPeerConfig.errors) {
					errorsFormatted = validateClientPeerConfig.errors
						.map((error) => error.dataPath + ' ' + error.message)
						.join('\n');
				}
				alert(
					`Server sent a malformed peer config. Default config will be used. See errors below:\n${errorsFormatted}`
				);
				return;
			}

			if (
				clientPeerConfig.forceRelayOnly &&
				!clientPeerConfig.iceServers.some((server) => server.urls.toString().includes('turn:'))
			) {
				alert('Server has forced relay mode enabled but provides no relay servers. Default config will be used.');
				return;
			}

			iceConfig = {
				iceTransportPolicy: clientPeerConfig.forceRelayOnly ? 'relay' : 'all',
				iceServers: clientPeerConfig.iceServers,
			};
		});

		socket.on('VAD', (data: { activity: boolean; client: Client; socketId: string }) => {
			setOtherVAD((old) => ({
				...old,
				[data.client.clientId]: data.activity,
			}));
		});

		socket.on('setClient', (socketId: string, client: Client) => {
			socketClientsRef.current = { ...socketClientsRef.current, [socketId]: client };
			setSocketClients({ ...socketClientsRef.current });
		});

		socket.on('setClients', (clients: SocketClientMap) => {
			socketClientsRef.current = clients;
			setSocketClients(clients);
		});

		// Initialize variables
		let audioListener: VadNode;

		const audio: MediaTrackConstraints & Record<string, unknown> = {
			deviceId: (undefined as unknown) as string,
			autoGainControl: false,
			channelCount: 2,
			echoCancellation: settings.echoCancellation,
			latency: 0,
			noiseSuppression: settings.noiseSuppression,// @ts-ignore-line
			googNoiseSuppression: settings.noiseSuppression, // @ts-ignore-line
			googEchoCancellation: settings.echoCancellation, // @ts-ignore-line
			googTypingNoiseDetection: settings.noiseSuppression, // @ts-ignore-line
			sampleRate: settings.oldSampleDebug? 48000 : undefined,
			sampleSize: settings.oldSampleDebug? 16 : undefined,
		};

		// Get microphone settings
		if (settingsRef.current.microphone.toLowerCase() !== 'default') audio.deviceId = settingsRef.current.microphone;
		navigator.mediaDevices.getUserMedia({ video: false, audio })
		.then(async (inStream) => {
			let stream = inStream;
			const ac = new AudioContext();
			let microphoneGain: GainNode | undefined;
			const source = ac.createMediaStreamSource(inStream);
			if (settings.microphoneGainEnabled || settings.micSensitivityEnabled) {
				console.log('Microphone volume or sensitivityEnabled..');
				stream = (() => {
					microphoneGain = ac.createGain();
					const destination = ac.createMediaStreamDestination();
					source.connect(microphoneGain);
					microphoneGain.gain.value = settings.microphoneGainEnabled ? settings.microphoneGain / 100 : 1;
					microphoneGain.connect(destination);
					connectionStuff.current.microphoneGain = microphoneGain;
					return destination.stream;
				})();
			}

			if (settingsRef.current.vadEnabled) {
				audioListener = VAD(ac, source, undefined, {
					onVoiceStart: () => {
						if (microphoneGain && settingsRef.current.micSensitivityEnabled) {
							microphoneGain.gain.value = settingsRef.current.microphoneGainEnabled
								? settingsRef.current.microphoneGain / 100
								: 1;
						}
						setTalking(true);
					},
					onVoiceStop: () => {
						if (microphoneGain && settingsRef.current.micSensitivityEnabled) {
							microphoneGain.gain.value = 0;
						}
						setTalking(false);
					},
					noiseCaptureDuration: 0,
					stereo: false,
				});

				audioListener.options.minNoiseLevel = settingsRef.current.micSensitivityEnabled
					? settingsRef.current.micSensitivity
					: 0.15;
				audioListener.options.maxNoiseLevel = 1;

				audioListener.init();
				connectionStuff.current.audioListener = audioListener;
				connectionStuff.current.microphoneGain = microphoneGain;
			}
			connectionStuff.current.stream = stream;
			connectionStuff.current.instream = inStream;

			inStream.getAudioTracks()[0].enabled = settings.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;

			connectionStuff.current.toggleDeafen = () => {
				connectionStuff.current.deafened = !connectionStuff.current.deafened;
				inStream.getAudioTracks()[0].enabled =
					!connectionStuff.current.deafened &&
					!connectionStuff.current.muted &&
					connectionStuff.current.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
				setDeafened(connectionStuff.current.deafened);
			};

			connectionStuff.current.toggleMute = () => {
				connectionStuff.current.muted = !connectionStuff.current.muted;
				if (connectionStuff.current.deafened) {
					connectionStuff.current.deafened = false;
					connectionStuff.current.muted = false;
				}
				inStream.getAudioTracks()[0].enabled =
					!connectionStuff.current.muted &&
					!connectionStuff.current.deafened &&
					connectionStuff.current.pushToTalkMode !== pushToTalkOptions.PUSH_TO_TALK;
				setMuted(connectionStuff.current.muted);
				setDeafened(connectionStuff.current.deafened);
			};

			ipcRenderer.on(IpcRendererMessages.TOGGLE_DEAFEN, connectionStuff.current.toggleDeafen);

			ipcRenderer.on(IpcRendererMessages.IMPOSTOR_RADIO, (_: unknown, pressing: boolean) => {
				connectionStuff.current.impostorRadio = pressing;
			});

			ipcRenderer.on(IpcRendererMessages.TOGGLE_MUTE, connectionStuff.current.toggleMute);
			ipcRenderer.on(IpcRendererMessages.PUSH_TO_TALK, (_: unknown, pressing: boolean) => {
				if (connectionStuff.current.pushToTalkMode === pushToTalkOptions.VOICE) return;
				if (!connectionStuff.current.deafened && !connectionStuff.current.muted) {
					inStream.getAudioTracks()[0].enabled =
						connectionStuff.current.pushToTalkMode === pushToTalkOptions.PUSH_TO_TALK ? pressing : !pressing;
				}
			});

			audioElements.current = {};

			const connect = (lobbyCode: string, playerId: number, clientId: number, isHost: boolean) => {
				console.log('connect called..', lobbyCode);
				setOtherVAD({});
				setOtherTalking({});
				if (lobbyCode === 'MENU') {
					Object.keys(peerConnectionsRef.current).forEach((k) => {
						disconnectPeer(k);
					});
					setSocketClients({});
					currentLobby = lobbyCode;
				} else if (currentLobby !== lobbyCode) {
					console.log('Currentlobby', currentLobby, lobbyCode);
					socket.emit('leave');
					socket.emit('id', playerId, clientId);
					socket.emit('join', lobbyCode, playerId, clientId, isHost);
					currentLobby = lobbyCode;
				}
			};

			setConnect({ connect });

			const recentSignals: Record<string, { hash: string; time: number }> = {};
			function shouldIgnoreDuplicateSignal(peer: string, data: Peer.SignalData) {
				const now = Date.now();
				const hash = JSON.stringify(data);
				const recent = recentSignals[peer];
				recentSignals[peer] = { hash, time: now };
				return !!recent && recent.hash === hash && now - recent.time < SIGNAL_DEDUPE_MS;
			}

			function schedulePeerReconnect(peer: string, client: Client, initiator: boolean, restartExisting = false) {
				if (reconnectTimers.current[peer] || !(socket as any).connected || hostRef.current.gamestate === GameState.MENU) {
					return;
				}
				console.log('Scheduling peer reconnect:', peer);
				reconnectTimers.current[peer] = window.setTimeout(() => {
					delete reconnectTimers.current[peer];
					if (
						!(socket as any).connected ||
						hostRef.current.gamestate === GameState.MENU ||
						!socketClientsRef.current[peer]
					) {
						return;
					}
					const existingConnection = peerConnectionsRef.current[peer];
					if (existingConnection) {
						const state = ((existingConnection as any)._pc as RTCPeerConnection | undefined)?.iceConnectionState;
						if (!restartExisting || state === 'connected' || state === 'completed') {
							return;
						}
						intentionalDisconnects.current[peer] = true;
						existingConnection.destroy();
						removePeerConnection(peer);
					}
					createPeerConnection(peer, initiator, client);
				}, PEER_RECONNECT_DELAY_MS);
			}

			function getPeerIceConfig(peer: string): RTCConfiguration {
				if (
					settingsRef.current.natFix ||
					reconnectAttempts.current[peer] >= PEER_RELAY_FALLBACK_AFTER_ATTEMPTS
				) {
					return DEFAULT_ICE_CONFIG_TURN;
				}

				return iceConfig;
			}

			function markPeerUnstable(peer: string) {
				reconnectAttempts.current[peer] = (reconnectAttempts.current[peer] || 0) + 1;
			}

			function markPeerHealthy(peer: string) {
				reconnectAttempts.current[peer] = 0;
			}

			function watchRemoteAudioTrack(peer: string, client: Client, initiator: boolean, stream: MediaStream) {
				clearStalledAudioTimer(peer);
				const track = stream.getAudioTracks()[0];
				if (!track) {
					markPeerUnstable(peer);
					schedulePeerReconnect(peer, client, initiator, true);
					return;
				}

				track.onmute = () => {
					clearStalledAudioTimer(peer);
					stalledAudioTimers.current[peer] = window.setTimeout(() => {
						delete stalledAudioTimers.current[peer];
						console.log('Remote audio track stayed muted, reconnecting:', peer);
						markPeerUnstable(peer);
						schedulePeerReconnect(peer, client, initiator, true);
					}, PEER_TRACK_STALL_RECONNECT_MS);
				};
				track.onunmute = () => {
					clearStalledAudioTimer(peer);
					markPeerHealthy(peer);
				};
				track.onended = () => {
					clearStalledAudioTimer(peer);
					console.log('Remote audio track ended, reconnecting:', peer);
					markPeerUnstable(peer);
					schedulePeerReconnect(peer, client, initiator, true);
				};
			}

			function createPeerConnection(peer: string, initiator: boolean, client: Client) {
				console.log('CreatePeerConnection: ', peer, initiator);
				clearReconnectTimer(peer);
				const existingConnection = peerConnectionsRef.current[peer];
				if (existingConnection) {
					intentionalDisconnects.current[peer] = true;
					existingConnection.destroy();
					removePeerConnection(peer);
				}
				disconnectClient(client);
				const connection = new Peer({
					stream,
					initiator, // @ts-ignore-line
					iceRestartEnabled: true,
					config: getPeerIceConfig(peer),
				});

				peerConnectionsRef.current[peer] = connection;
				setPeerConnections({ ...peerConnectionsRef.current });

				connection.on('connect', () => {
					clearReconnectTimer(peer);
					setTimeout(() => {
						if (hostRef.current.isHost && connection.writable) {
							try {
								console.log('sending settings..');
								connection.send(JSON.stringify(lobbySettingsRef.current));
							} catch (e) {
								console.warn('failed to update lobby settings: ', e);
							}
						}
					}, 1000);
				});

				const rtcConnection = (connection as any)._pc as RTCPeerConnection | undefined;
				if (rtcConnection) {
					rtcConnection.oniceconnectionstatechange = () => {
						const state = rtcConnection.iceConnectionState;
						console.log('ICE connection state:', peer, state);
						if (state === 'failed') {
							markPeerUnstable(peer);
							removePeerConnection(peer);
							connection.destroy();
							schedulePeerReconnect(peer, client, initiator);
						} else if (state === 'disconnected') {
							markPeerUnstable(peer);
							schedulePeerReconnect(peer, client, initiator, true);
						} else if (state === 'connected' || state === 'completed') {
							clearStalledAudioTimer(peer);
						}
					};
					rtcConnection.onconnectionstatechange = () => {
						const state = rtcConnection.connectionState;
						console.log('Peer connection state:', peer, state);
						if (state === 'failed' || state === 'disconnected') {
							markPeerUnstable(peer);
							schedulePeerReconnect(peer, client, initiator, true);
						} else if (state === 'connected') {
							clearStalledAudioTimer(peer);
						}
					};
				}

				connection.on('stream', async (stream: MediaStream) => {
					console.log('ONSTREAM');

					const existingAudio = audioElements.current[peer];
					if (existingAudio) {
						if (existingAudio.dummyAudioElement.srcObject === stream) {
							console.warn('Ignoring duplicate stream for peer:', peer);
							return;
						}
						console.warn('Replacing existing audio stream for peer:', peer);
						disconnectAudioElement(peer);
					}
					markPeerHealthy(peer);
					watchRemoteAudioTrack(peer, client, initiator, stream);
					setAudioConnected((old) => ({ ...old, [peer]: true }));
					const dummyAudio = new Audio();
					dummyAudio.srcObject = stream;
					const context = new AudioContext();
					const source = context.createMediaStreamSource(stream);
					const dest = context.createMediaStreamDestination();

					const gain = context.createGain();
					const pan = context.createPanner();
					gain.gain.value = 0;
					pan.refDistance = 0.1;
					pan.panningModel = 'equalpower';
					pan.distanceModel = 'linear';
					pan.maxDistance = maxDistanceRef.current;
					pan.rolloffFactor = 1;

					const muffle = context.createBiquadFilter();
					muffle.type = 'lowpass';

					source.connect(pan);
					pan.connect(gain);

					const reverb = context.createConvolver();
					reverb.buffer = convolverBuffer.current;
					const voiceEffect = createVoiceDisguiseEffect(context, convolverBuffer.current, settingsRef.current.voiceEffectStrength);
					const destination: AudioNode = dest;
					// if (settingsRef.current.vadEnabled) {
					// 	VAD(context, gain, undefined, {
					// 		onVoiceStart: () => setTalking(true),
					// 		onVoiceStop: () => setTalking(false),
					// 		stereo: false,
					// 	});
					// }
					gain.connect(destination);
					const audio = document.createElement('audio') as ExtendedAudioElement;
					document.body.appendChild(audio);
					audio.setAttribute('autoplay', '');
					audio.srcObject = dest.stream;
					if (settingsRef.current.speaker.toLowerCase() !== 'default') {
						audio.setSinkId(settingsRef.current.speaker);
					}


					audioElements.current[peer] = {
						dummyAudioElement: dummyAudio,
						audioElement: audio,
						gain,
						pan,
						reverb,
						muffle,
						voiceEffect,
						muffleConnected: false,
						reverbConnected: false,
						voiceEffectConnected: false,
						voiceDisguiseActive: false,
						destination,
					};
				});

				connection.on('signal', (data) => {
					socket.emit('signal', {
						data,
						to: peer,
					});
				});

				connection.on('data', (data) => {
					const parsedData = JSON.parse(data);
					if (parsedData.hasOwnProperty('impostorRadio')) {
						const clientId = socketClientsRef.current[peer]?.clientId;
						if (impostorRadioClientId.current === -1 && parsedData['impostorRadio']) {
							impostorRadioClientId.current = clientId;
						} else if (impostorRadioClientId.current === clientId && !parsedData['impostorRadio']) {
							impostorRadioClientId.current = -1;
						}
						console.log('Recieved impostor radio request', parsedData);
					}
					if (parsedData.hasOwnProperty('maxDistance')) {
						if (!hostRef.current || hostRef.current.parsedHostId !== socketClientsRef.current[peer]?.clientId) return;
						const newSettings = { ...defaultLobbySettings, ...parsedData };
						setHostLobbySettings(newSettings);
					}
				});
				connection.on('close', () => {
					console.log('Disconnected from', peer, 'Initiator:', initiator);
					const wasIntentional = intentionalDisconnects.current[peer];
					delete intentionalDisconnects.current[peer];
					removePeerConnection(peer);
					if (!wasIntentional) {
						markPeerUnstable(peer);
						schedulePeerReconnect(peer, client, initiator);
					}
				});
				connection.on('error', (err) => {
					console.log('Peer error:', peer, err);
					markPeerUnstable(peer);
					schedulePeerReconnect(peer, client, initiator, true);
				});
				return connection;
			}

			socket.on('join', async (peer: string, client: Client) => {
				socketClientsRef.current = { ...socketClientsRef.current, [peer]: client };
				setSocketClients({ ...socketClientsRef.current });
				createPeerConnection(peer, true, client);
			});

			socket.on('signal', ({ data, from, client }: { data: Peer.SignalData; from: string, client: Client }) => {
				if (data.hasOwnProperty('mobilePlayerInfo')) {
					// eslint-disable-line
					const mobiledata = data as mobileHostInfo;
					if (
						mobiledata.mobilePlayerInfo.code === hostRef.current.code &&
						hostRef.current.gamestate !== GameState.MENU
					) {
						hostRef.current.mobileRunning = true;
						console.log('setting mobileRunning to true..');
					}
					return;
				}
				let connection: Peer.Instance;
				if (!socketClientsRef.current[from] && client) {
					socketClientsRef.current = { ...socketClientsRef.current, [from]: client };
					setSocketClients({ ...socketClientsRef.current });
				}
				if (!socketClientsRef.current[from]) {
					console.warn('SIGNAL FROM UNKOWN SOCKET..');
					return;
				}
				if (data.hasOwnProperty('type')) {
					if (shouldIgnoreDuplicateSignal(from, data)) {
						console.warn('Ignoring duplicate signal from peer:', from);
						return;
					}
					if (peerConnectionsRef.current[from] && data.type !== 'offer') {
						connection = peerConnectionsRef.current[from];
					} else {
						connection = createPeerConnection(from, false, client);
					}
					connection.signal(data);
				}
			});
		},
		(error) => {
			console.error(error);
			setError("Couldn't connect to your microphone:\n" + error);
			// ipcRenderer.send(IpcMessages.SHOW_ERROR_DIALOG, {
			// 	title: 'Error',
			// 	content: 'Couldn\'t connect to your microphone:\n' + error
			// });
		});

		return () => {
			hostRef.current.mobileRunning = false;
			socket.emit('leave');
			Object.keys(peerConnectionsRef.current).forEach((k) => {
				disconnectPeer(k);
			});
			Object.keys(reconnectTimers.current).forEach(clearReconnectTimer);
			Object.keys(stalledAudioTimers.current).forEach(clearStalledAudioTimer);
			connectionStuff.current.socket?.close();

			audioListener?.destroy();
		};
		// })();
	}, []);

	interface mobileHostInfo {
		mobilePlayerInfo: {
			code: string;
			askingForHost: boolean;
		};
	}

	//data: { mobilePlayerInfo: { code: this.gamecode, askingForHost: true }
	const myPlayer = useMemo(() => {
		if (!gameState || !gameState.players) {
			return undefined;
		} else {
			return gameState.players.find((p) => p.isLocal);
		}
	}, [gameState.players]);

	const otherPlayers = useMemo(() => {
		let otherPlayers: Player[];
		if (!gameState || !gameState.players || !myPlayer) return [];
		else otherPlayers = gameState.players.filter((p) => !p.isLocal);
		maxDistanceRef.current = lobbySettings.visionHearing
			? myPlayer.isImpostor
				? lobbySettings.maxDistance
				: gameState.lightRadius + 0.5
			: lobbySettings.maxDistance;
		if (maxDistanceRef.current <= 0.6) {
			maxDistanceRef.current = 1;
		}
		hostRef.current = {
			map: getStateMap(gameState),
			mobileRunning: hostRef.current.mobileRunning,
			gamestate: gameState.gameState,
			code: gameState.lobbyCode,
			hostId: gameState.hostId,
			isHost: gameState.hostId > 0 ? gameState.isHost : hostRef.current.serverHostId === gameState.clientId,
			parsedHostId: gameState.hostId > 0 ? gameState.hostId : hostRef.current.serverHostId,
			serverHostId: hostRef.current.serverHostId,
		};
		const playerSocketIds: numberStringMap = {};
		for (const k of Object.keys(socketClients)) {
			playerSocketIds[socketClients[k].clientId] = k;
		}
		playerSocketIdsRef.current = playerSocketIds;
		const voiceDisguiseMode = getVoiceDisguiseMode(gameState, gameState.players);
		const handledPeerIds: string[] = [];
		let foundRadioUser = false;
		const tempTalking = { ...otherTalking };
		let talkingUpdate = false;
		for (const player of otherPlayers) {
			const peerId = playerSocketIds[player.clientId];
			const audio = player.clientId === myPlayer.clientId ? undefined : audioElements.current[peerId];
			if (
				player.clientId === impostorRadioClientId.current &&
				player.isImpostor &&
				!player.isDead &&
				!player.disconnected &&
				!player.bugged
			) {
				foundRadioUser = true;
			}
			if (audio) {
				handledPeerIds.push(peerId);
				let gain = calculateVoiceAudio(gameState, settings, myPlayer, player, audio, voiceDisguiseMode);
				const baseGain = gain;
				if (connectionStuff.current.deafened || playerConfigs[player.nameHash]?.isMuted) {
					gain = 0;
				}

				if (gain > 0) {
					const playerVolume = playerConfigs[player.nameHash]?.volume;
					gain = playerVolume === undefined ? gain : gain * playerVolume;

					if (myPlayer.isDead && !player.isDead) {
						gain = gain * (settings.crewVolumeAsGhost / 100);
					}
					gain = gain * (settings.masterVolume / 100);
				}
				debugVoiceAvailability(gameState, myPlayer, player, baseGain, gain, voiceDisguiseMode);
				audio.gain.gain.value = gain;
				tempTalking[player.clientId] = otherVAD[player.clientId] && gain > 0;
				if (tempTalking[player.clientId] != otherTalking[player.clientId]) {
					talkingUpdate = true;
				}
			} else {
				debugVoiceAvailability(
					gameState,
					myPlayer,
					player,
					0,
					0,
					voiceDisguiseMode,
					[peerId ? 'no-audio-node' : 'no-peer']
				);
			}
		}
		if (talkingUpdate) {
			setOtherTalking(tempTalking);
		}

		if (
			((!foundRadioUser && impostorRadioClientId.current !== myPlayer.clientId) || !myPlayer.isImpostor) &&
			impostorRadioClientId.current !== -1
		) {
			impostorRadioClientId.current = -1;
		}
		for (const peerId of Object.keys(audioElements.current).filter((e) => !handledPeerIds.includes(e))) {
			const audio = audioElements.current[peerId];
			if (audio && audio.gain) {
				restoreTransientEffects(audio, {
					name: peerId,
				} as Player);
				audio.gain.gain.value = 0;
			}
			// maybe disconnect later
		}

		return otherPlayers;
	}, [
		gameState,
		otherVAD,
		lobbySettings,
		settings.crewVolumeAsGhost,
		settings.enableSpatialAudio,
		settings.ghostVolumeAsImpostor,
		settings.masterVolume,
		settings.voiceEffectStrength,
	]);

	// Connect to P2P negotiator, when lobby and connect code change
	useEffect(() => {
		if (connect?.connect) {
			connect.connect(gameState?.lobbyCode ?? 'MENU', myPlayer?.id ?? 0, gameState.clientId, gameState.isHost);
			updateLobby();
		}
	}, [connect?.connect, gameState?.lobbyCode, connected]);

	useEffect(() => {
		connectionStuff.current.socket?.emit('VAD', talking);
	}, [talking])

	// Connect to P2P negotiator, when game mode change
	useEffect(() => {
		if (
			connect?.connect &&
			gameState.lobbyCode &&
			myPlayer?.clientId !== undefined &&
			gameState.gameState === GameState.LOBBY &&
			(gameState.oldGameState === GameState.DISCUSSION || gameState.oldGameState === GameState.TASKS)
		) {
			hostRef.current.mobileRunning = false;
			connect.connect(gameState.lobbyCode, myPlayer.clientId, gameState.clientId, gameState.isHost);
		} else if (
			gameState.oldGameState !== GameState.UNKNOWN &&
			gameState.oldGameState !== GameState.MENU &&
			gameState.gameState === GameState.MENU
		) {
			console.log('DISCONNECT TO MENU!');
			// On change from a game to menu, exit from the current game properly
			hostRef.current.mobileRunning = false; // On change from a game to menu, exit from the current game properly
			connectionStuff.current.socket?.emit('leave');
			Object.keys(peerConnectionsRef.current).forEach((k) => {
				disconnectPeer(k);
			});
			setOtherDead({});
		}
	}, [gameState.gameState]);

	// Emit player id to socket
	useEffect(() => {
		if (connectionStuff.current.socket && myPlayer && myPlayer.clientId !== undefined) {
			connectionStuff.current.socket.emit('id', myPlayer.id, gameState.clientId);
		}
	}, [myPlayer?.id, myPlayer?.clientId]);

	// Pass voice state to overlay
	useEffect(() => {
		if (!settings.enableOverlay) {
			return;
		}
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, {
			otherTalking,
			playerSocketIds: playerSocketIdsRef.current,
			otherDead,
			socketClients,
			audioConnected,
			localTalking: talking,
			localIsAlive: !myPlayer?.isDead,
			impostorRadioClientId: !myPlayer?.isImpostor ? -1 : impostorRadioClientId.current,
			muted: mutedState,
			deafened: deafenedState,
			mod: gameState.mod,
		} as VoiceState);
	}, [
		otherTalking,
		otherDead,
		socketClients,
		audioConnected,
		talking,
		mutedState,
		deafenedState,
		impostorRadioClientId.current,
	]);

	return (
		<div className={classes.root}>
			{(error || initialError) && (
				<div className={classes.error}>
					<Typography align="center" variant="h6" color="error">
						ERROR
					</Typography>
					<Typography align="center" style={{ whiteSpace: 'pre-wrap' }}>
						{error}
						{initialError}
					</Typography>
					<SupportLink />
				</div>
			)}
			{(!error && !initialError) && (<>

				<div className={classes.top}>
					{myPlayer && gameState.lobbyCode !== 'MENU' && (
						<>
							<div className={classes.avatarWrapper}>
								<VoiceAvatar
									deafened={deafenedState}
									muted={mutedState}
									player={myPlayer}
									borderColor="#2ecc71"
									connectionState={connected ? 'connected' : 'disconnected'}
									isUsingRadio={myPlayer?.isImpostor && impostorRadioClientId.current === myPlayer.clientId}
									talking={talking}
									isAlive={!myPlayer.isDead}
									size={isLiteApp ? 80 : 100}
									mod={gameState.mod}
									colorPalette={playerColors[myPlayer.colorId]}
								/>
							</div>
						</>
					)}
					<div className={classes.right}>
						<div>
							<div className={classes.left}>
								{myPlayer && gameState?.gameState !== GameState.MENU && (
									<span className={classes.username}>{myPlayer.appearanceName || myPlayer.name}</span>
								)}
								<span
									className={classes.code}
									style={{
										background: gameState.lobbyCode === 'MENU' ? 'transparent' : '#3e4346',
									}}
								>
									{displayedLobbyCode === 'MENU' ? t('game.menu') : displayedLobbyCode}
								</span>
							</div>
							{gameState.lobbyCode !== 'MENU' && (
								<div className={classes.muteButtons}>
									<IconButton onClick={connectionStuff.current.toggleMute} size="small">
										{mutedState || deafenedState ? <MicOff /> : <Mic />}
									</IconButton>
									<IconButton onClick={connectionStuff.current.toggleDeafen} size="small">
										{deafenedState ? <VolumeOff /> : <VolumeUp />}
									</IconButton>
								</div>
							)}
						</div>
					</div>
				</div>
				{lobbySettings.deadOnly && (
					<div className={classes.top}>
						<small style={{ padding: 0 }}>{t('settings.lobbysettings.ghost_only_warning2')}</small>
					</div>
				)}
				{lobbySettings.meetingGhostOnly && (
					<div className={classes.top}>
						<small style={{ padding: 0 }}>{t('settings.lobbysettings.meetings_only_warning2')}</small>
					</div>
				)}
				{gameState.lobbyCode && <Divider />}
				{displayedLobbyCode === 'MENU' && !isLiteApp && (
					<div className={classes.top}>
						<Button
							style={{ margin: '10px' }}
							onClick={() => {
								ipcRenderer.send(IpcHandlerMessages.OPEN_LOBBYBROWSER);
							}}
							color="primary"
							variant="outlined"
						>
							{t('buttons.public_lobby')}
						</Button>
					</div>
				)}
				{myPlayer && gameState.lobbyCode !== 'MENU' && (
					<Grid
						container
						spacing={1}
						className={classes.otherplayers}
						alignItems="flex-start"
						alignContent="flex-start"
						justifyContent="flex-start"
					>
						{otherPlayers.map((player) => {
							const peer = playerSocketIdsRef.current[player.clientId];
							const connected = socketClients[peer]?.clientId === player.clientId || false;
							const audio = audioConnected[peer];

							if (!playerConfigs[player.nameHash]) {
								playerConfigs[player.nameHash] = { volume: 1, isMuted: false };
							}
							const socketConfig = playerConfigs[player.nameHash];

							return (
								<Grid item key={player.id} xs={getPlayersPerRow(otherPlayers.length)}>
									<VoiceAvatar
										connectionState={!connected ? 'disconnected' : audio ? 'connected' : 'novoice'}
										player={player}
										talking={!player.inVent && otherTalking[player.clientId]}
										borderColor="#2ecc71"
										isAlive={!otherDead[player.clientId]}
										isUsingRadio={
											myPlayer?.isImpostor &&
											!(player.disconnected || player.bugged) &&
											impostorRadioClientId.current === player.clientId
										}
										size={50}
										socketConfig={socketConfig}
										onConfigChange={() => setSetting(`playerConfigMap.${player.nameHash}`, playerConfigs[player.nameHash])}
										mod={gameState.mod}
										colorPalette={playerColors[player.colorId]}
									/>
								</Grid>
							);
						})}
					</Grid>
				)}
			</>)}
			{otherPlayers.length <= 6 && <Footer />}
			{voiceDebugEnabled && voiceDebugOverlay && (
				<div className={classes.debugOverlay}>
					{[
						`socketIO=${voiceDebugOverlay.socketIoVersion || '-'} map=${voiceDebugOverlay.map} mod=${voiceDebugOverlay.mod || '-'} state=${voiceDebugOverlay.gameState} audio=${voiceDebugOverlay.audioGameState} airshipFallback=${voiceDebugOverlay.airshipMeetingAudioFallback} airshipSpawn=${voiceDebugOverlay.airshipSpawnAudioFallback}`,
						`raw=${voiceDebugOverlay.rawGameState} meetingHud=${voiceDebugOverlay.meetingHud} cache=${voiceDebugOverlay.meetingHudCachePtr} hudState=${voiceDebugOverlay.meetingHudState}`,
						`scene=${voiceDebugOverlay.onlineScene}/${voiceDebugOverlay.mainMenuScene} task=${voiceDebugOverlay.localTaskPtr}`,
						`role=${voiceDebugOverlay.localRoleLabel || '-'} team=${voiceDebugOverlay.localRoleTeam ?? '-'} ptr=${voiceDebugOverlay.localRolePtr || '-'}`,
						`roleDiff=${voiceDebugOverlay.localRoleDiffs || '-'}`,
						`roleRaw=${voiceDebugOverlay.localRoleSnapshot || '-'}`,
						`pat=${voiceDebugOverlay.initPatternDebug || '-'}`,
						`outfits=${voiceDebugOverlay.currentOutfits || '-'} outfitMeet=${voiceDebugOverlay.airshipMeetingByOutfit}`,
						`objDiff=${voiceDebugOverlay.localObjectDiffs || '-'}`,
						`plrDiff=${voiceDebugOverlay.localPlayerDiffs || '-'}`,
						`netDiff=${voiceDebugOverlay.innerNetDiffs || '-'}`,
						`flags=${voiceDebugOverlay.localObjectFlags || '-'}`,
						`remote=${voiceDebugOverlay.remoteName || '-'} base=${voiceDebugOverlay.baseGain?.toFixed(3)} final=${voiceDebugOverlay.finalGain?.toFixed(3)}`,
						`blocks=${voiceDebugOverlay.possibleBlocks.length ? voiceDebugOverlay.possibleBlocks.join(',') : 'none'}`,
					].join('\n')}
				</div>
			)}
		</div>
	);
};

type ValidPlayersPerRow = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
function getPlayersPerRow(playerCount: number): ValidPlayersPerRow {
	if (playerCount <= 9) return (12 / 3) as ValidPlayersPerRow;
	else return Math.min(12, Math.floor(12 / Math.ceil(Math.sqrt(playerCount)))) as ValidPlayersPerRow;
}

export default Voice;
