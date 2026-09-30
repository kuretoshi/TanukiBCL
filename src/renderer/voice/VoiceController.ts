import { AmongUsState, ClientBoolMap, GameState, numberStringMap, Player } from '../../common/AmongUsState';
import { MapType } from '../../common/AmongusMap';
import { GameInfo } from '../../common/GameInfo';
import { ILobbySettings, ISettings, playerConfigMap } from '../../common/ISettings';
import { isLiteRuntime } from '../../common/appVariant';
import { IpcMessages, IpcOverlayMessages, IpcRendererMessages } from '../../common/ipc-messages';
import { ObsVoiceState } from '../../common/ObsOverlay';
import { canHearNosJackalRadio, isNosRadioData, nosColorHex, NOS_JACKAL_RADIO_KIND } from '../../common/NosSnapshot';
import { VoiceState } from '../../common/AmongUsState';
import { isTohRole, TohRole } from '../../common/TohRole';
import { ipcRenderer } from '../lib/electron-bridge';
import { TypedEmitter } from '../lib/TypedEmitter';
import SettingsStore from '../settings/SettingsStore';
import { gameStore } from '../state/gameStore';
import { AudioController } from './AudioController';
import { ConnectionController } from './ConnectionController';
import { defaultLobbySettings, VoiceSnapshot } from './types';
import { isToh4eHostName } from '../../common/Mods';
import { isSnrJackalTeam } from '../../common/SnrRole';
// @ts-ignore
import radioOnSound from '../../../static/sounds/radio_on.wav';

interface HostInfo {
	map: MapType;
	gamestate: GameState;
	code: string;
	hostId: number;
	parsedHostId: number;
	isHost: boolean;
	serverHostId: number;
}

interface VoiceControllerEvents extends Record<string, unknown[]> {
	change: [];
}

const radioOnAudio = new Audio();
radioOnAudio.src = radioOnSound;
radioOnAudio.volume = 0.02;

const OVERLAY_VOICE_KEYS: (keyof VoiceSnapshot)[] = [
	'otherTalking',
	'otherDead',
	'socketClients',
	'playerSocketIds',
	'audioConnected',
	'talking',
	'muted',
	'deafened',
	'impostorRadioClientId',
	'impostorRadioClientIds',
];

const EMPTY_SNAPSHOT: VoiceSnapshot = {
	connected: false,
	error: '',
	talking: false,
	muted: false,
	deafened: false,
	otherTalking: {},
	otherDead: {},
	socketClients: {},
	playerSocketIds: {},
	audioConnected: {},
	connectionQuality: {},
	impostorRadioClientId: -1,
	impostorRadioClientIds: [],
	activeLobbySettings: null,
	hostId: 0,
	toh4eLobby: false,
	tohRole: null,
	tohGameStartNames: {},
	nosRadiosByPlayer: {},
};

function emptyHost(): HostInfo {
	return {
		map: MapType.UNKNOWN,
		gamestate: GameState.UNKNOWN,
		code: 'MENU',
		hostId: 0,
		parsedHostId: 0,
		isHost: false,
		serverHostId: 0,
	};
}

function emptyPrev() {
	return {
		lobbyCode: '',
		gameState: GameState.UNKNOWN,
		isHost: false,
		playerId: -1,
		clientId: -1,
		playerName: '',
		vadHidden: false,
		playerCount: -1,
		publicLobbyTitle: '',
		publicLobbyLanguage: '',
		publicLobbyOn: false,
		publicLobbyGameState: GameState.UNKNOWN,
		pushToTalkMode: -1,
		microphoneGain: -1,
		micSensitivity: -1,
		speaker: '',
		inputSignature: '',
		serverURL: '',
		myLobbySettings: null as ILobbySettings | null,
		lobbySettingsLobby: null as string | null,
		lobbySettingsHosted: false,
		gameOpen: false,
		gameInfo: '',
		obsPayload: '',
		toh4eLobby: false,
		tohRole: null,
		tohRoleSentSignatures: {} as Record<number, string>,
		tohLobbySentSignature: '',
		tohSession: '',
		tohRoleSentAt: {} as Record<number, number>,
		tohRosterSentSignature: '',
		nosRadioSession: '',
		nosRadioSentSignature: '',
		nosRadioSentAt: 0,
	};
}

export class VoiceController extends TypedEmitter<VoiceControllerEvents> {
	private readonly audio = new AudioController();
	private readonly connection = new ConnectionController();

	private started = false;
	private startToken = 0;
	private snapshot: VoiceSnapshot = EMPTY_SNAPSHOT;
	private unsubscribers: (() => void)[] = [];
	private audioUnsubscribers: (() => void)[] = [];
	private connectionUnsubscribers: (() => void)[] = [];

	private otherVAD: ClientBoolMap = {};
	private localTalking = false;
	private playerConfigs: playerConfigMap = {};
	private impostorRadioPressed = false;
	private radioStatusVersion = 0;
	private radioStatusVersions: Record<number, number> = {};
	private lastRadioStatusSentAt = 0;
	private tohRoleOverride: TohRole | null = null;
	private tohRoleReceivedAt = 0;
	private tohLobbyNames: numberStringMap = {};

	private host: HostInfo = emptyHost();

	private prev = emptyPrev();

	private get activeLobbySettings(): ILobbySettings {
		return this.snapshot.activeLobbySettings ?? defaultLobbySettings;
	}

	getSnapshot = (): VoiceSnapshot => this.snapshot;

	/** The same host-derived MOD/role state is used by audio, settings and diagnostics. */
	getEffectiveGameState(state: AmongUsState): AmongUsState {
		if (!this.snapshot.toh4eLobby) return state;
		return {
			...state,
			mod: 'TOH4E',
			players: state.players?.map((player) => {
				const fixedName = this.snapshot.tohGameStartNames[player.clientId];
				const namedPlayer = fixedName ? { ...player, name: fixedName, appearanceName: fixedName } : player;
				return player.isLocal && !this.host.isHost
					? {
							...namedPlayer,
							tohRole: this.tohRoleOverride ?? undefined,
							roleName: this.tohRoleOverride?.roleName
								? `TOH4E: ${this.tohRoleOverride.roleName}`
								: 'TOH4E役職未取得（ホストからの受信待ち）',
						}
					: namedPlayer;
			}),
			...(state.debug && !this.host.isHost
				? {
						debug: {
							...state.debug,
							tohRoleStatus: this.tohRoleOverride
								? 'TOH4E役職取得済み／取得元: ホストのベタクル'
								: 'TOH4E役職未取得（ホストからの受信待ち）',
						},
					}
				: {}),
		};
	}

	subscribe = (listener: () => void): (() => void) => this.on('change', listener);

	get running(): boolean {
		return this.started;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const token = ++this.startToken;

		const settings = SettingsStore.store;
		this.playerConfigs = settings.playerConfigMap;
		this.prev.pushToTalkMode = settings.pushToTalkMode;
		this.prev.microphoneGain = settings.microphoneGain;
		this.prev.micSensitivity = settings.micSensitivity;
		this.prev.speaker = settings.speaker;
		this.prev.inputSignature = VoiceController.inputSignature(settings);
		this.prev.serverURL = settings.serverURL;
		this.prev.myLobbySettings = settings.myLobbySettings;
		this.patch({ activeLobbySettings: settings.myLobbySettings ?? defaultLobbySettings, error: '' });

		this.wireAudio();
		this.wireConnection();

		try {
			await this.audio.start();
		} catch {
			if (token === this.startToken) this.teardown(true);
			return;
		}
		if (!this.started || token !== this.startToken) return;

		const stream = this.audio.outboundStream;
		if (!stream) {
			this.teardown(true);
			return;
		}

		this.connection.start(settings.serverURL, stream);

		this.unsubscribers.push(gameStore.subscribe(() => this.onGameStore()));
		const onSettings = (next: ISettings) => this.onSettings(next);
		SettingsStore.onDidAnyChange(onSettings);
		this.unsubscribers.push(() => SettingsStore.offDidAnyChange(onSettings));

		ipcRenderer.on(IpcRendererMessages.IMPOSTOR_RADIO, this.onImpostorRadioKey);
		this.unsubscribers.push(() => ipcRenderer.off(IpcRendererMessages.IMPOSTOR_RADIO, this.onImpostorRadioKey));

		this.onGameStore();
	}

	stop(): void {
		if (!this.started) return;
		this.teardown();
	}

	private teardown(preserveError = false): void {
		this.started = false;
		this.startToken++;
		const lastError = this.snapshot.error;

		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];

		this.connection.stop();
		this.audio.stop();
		this.unwireConnection();
		this.unwireAudio();

		this.otherVAD = {};
		this.localTalking = false;
		this.tohRoleOverride = null;
		this.tohRoleReceivedAt = 0;
		this.tohLobbyNames = {};
		this.impostorRadioPressed = false;
		this.radioStatusVersion = 0;
		this.radioStatusVersions = {};
		this.lastRadioStatusSentAt = 0;
		this.playerConfigs = {};
		this.host = emptyHost();
		this.prev = emptyPrev();
		this.snapshot = preserveError && lastError ? { ...EMPTY_SNAPSHOT, error: lastError } : EMPTY_SNAPSHOT;
		this.emit('change');
	}

	toggleMute = (): void => this.audio.toggleMute();

	toggleDeafen = (): void => this.audio.toggleDeafen();

	private onImpostorRadioKey = (_: unknown, pressing: boolean): void => {
		this.setImpostorRadio(pressing);
	};

	setImpostorRadio(pressing: boolean): void {
		if (this.impostorRadioPressed !== pressing)
			this.radioStatusVersion = Math.max(Date.now(), this.radioStatusVersion + 1);
		this.impostorRadioPressed = pressing;
		this.applyImpostorRadio();
	}

	private patch(partial: Partial<VoiceSnapshot>): void {
		let changed = false;
		for (const key of Object.keys(partial) as (keyof VoiceSnapshot)[]) {
			if (this.snapshot[key] !== partial[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.snapshot = { ...this.snapshot, ...partial };
		this.emit('change');

		if (Object.keys(partial).some((key) => OVERLAY_VOICE_KEYS.includes(key as keyof VoiceSnapshot))) {
			this.publishOverlayVoiceState();
		}
	}

	private unwireAudio(): void {
		for (const unsubscribe of this.audioUnsubscribers) unsubscribe();
		this.audioUnsubscribers = [];
	}

	private unwireConnection(): void {
		for (const unsubscribe of this.connectionUnsubscribers) unsubscribe();
		this.connectionUnsubscribers = [];
	}

	private wireAudio(): void {
		this.unwireAudio();
		const add = this.audioUnsubscribers.push.bind(this.audioUnsubscribers);

		add(
			this.audio.on('talking', (talking) => {
				this.localTalking = talking;
				this.patch({ talking: talking && !this.prev.vadHidden });
				if (!this.prev.vadHidden || !talking) {
					this.connection.emitVad(talking && !this.prev.vadHidden);
				}
			})
		);

		add(this.audio.on('muteStateChanged', (muted, deafened) => this.patch({ muted, deafened })));

		add(
			this.audio.on('peerAudioReady', (peerId) => {
				this.patch({ audioConnected: { ...this.snapshot.audioConnected, [peerId]: true } });
			})
		);

		add(this.audio.on('error', (error) => this.patch({ error })));
	}

	private wireConnection(): void {
		this.unwireConnection();
		const add = this.connectionUnsubscribers.push.bind(this.connectionUnsubscribers);

		add(
			this.connection.on('connected', () => {
				this.patch({ connected: true });
				this.syncLobbyConnection(true);
				void this.publishGameInfo();
			})
		);

		add(
			this.connection.on('disconnected', () => {
				this.prev.gameInfo = '';
				this.tohRoleOverride = null;
				this.patch({ connected: false, tohRole: null, tohGameStartNames: {} });
			})
		);

		add(this.connection.on('error', (error) => this.patch({ error })));

		add(
			this.connection.on('serverHost', (hostId) => {
				this.host.serverHostId = hostId;
			})
		);

		add(
			this.connection.on('socketClients', (clients) => {
				this.patch({ socketClients: clients, playerSocketIds: this.connection.playerSocketIds });
				const { gameState } = gameStore.getSnapshot();
				const myPlayer = gameState?.players?.find((player) => player.isLocal);
				if (myPlayer) {
					this.publishToh4eLobby(gameState, true);
					this.publishToh4eRoster(gameState, true);
					this.publishToh4eRole(gameState);
				}
			})
		);

		add(
			this.connection.on('vad', (clientId, activity) => {
				this.otherVAD = { ...this.otherVAD, [clientId]: activity };
			})
		);

		add(
			this.connection.on('peerQuality', (peerId, quality) => {
				this.patch({ connectionQuality: { ...this.snapshot.connectionQuality, [peerId]: quality } });
			})
		);
		add(this.connection.on('serverQuality', (serverQuality) => this.patch({ serverQuality })));

		add(this.connection.on('peerStream', (peerId, stream) => this.audio.addPeer(peerId, stream)));
		add(
			this.connection.on('peerReady', () => {
				this.prev.tohRoleSentSignatures = {};
				this.prev.nosRadioSentAt = 0;
				const { gameState } = gameStore.getSnapshot();
				if (this.host.isHost) this.broadcastLobbySettings();
				this.publishToh4eLobby(gameState, true);
				this.publishToh4eRoster(gameState, true);
				this.publishToh4eRole(gameState);
				if (this.impostorRadioPressed) this.sendRadioStatus(gameState);
				this.syncNosRadioReports(
					gameState,
					gameState.players?.find((player) => player.isLocal)
				);
			})
		);

		add(
			this.connection.on('peerClosed', (peerId) => {
				this.prev.tohRoleSentSignatures = {};
				if (this.connection.getClient(peerId)?.clientId === this.host.parsedHostId) {
					this.tohRoleOverride = null;
					this.patch({ tohRole: null, tohGameStartNames: {} });
				}
				this.audio.removePeer(peerId);
				const audioConnected = { ...this.snapshot.audioConnected };
				delete audioConnected[peerId];
				const connectionQuality = { ...this.snapshot.connectionQuality };
				delete connectionQuality[peerId];
				const nosRadiosByPlayer = { ...this.snapshot.nosRadiosByPlayer };
				const clientId = this.connection.getClient(peerId)?.clientId;
				if (clientId !== undefined)
					for (const [playerId, report] of Object.entries(nosRadiosByPlayer))
						if (report.clientId === clientId) delete nosRadiosByPlayer[Number(playerId)];
				this.patch({ audioConnected, connectionQuality, nosRadiosByPlayer });
			})
		);

		add(
			this.connection.on('lobbyReset', () => {
				this.prev.tohLobbySentSignature = '';
				this.prev.tohRoleSentSignatures = {};
				this.otherVAD = {};
				this.patch({ otherTalking: {}, impostorRadioClientId: -1, impostorRadioClientIds: [], nosRadiosByPlayer: {} });
				this.prev.nosRadioSession = '';
				this.prev.nosRadioSentSignature = '';
				this.prev.nosRadioSentAt = 0;
				this.radioStatusVersions = {};
			})
		);

		add(this.connection.on('peerData', (peerId, data) => this.onPeerData(peerId, data)));
	}

	private onPeerData(peerId: string, data: Record<string, unknown>): void {
		const state = gameStore.getSnapshot().gameState;
		const senderClientId = this.connection.getClient(peerId)?.clientId;
		if (data.type === 'nos-radio-data') {
			const sender = state.players?.find((player) => player.clientId === senderClientId);
			if (
				state.mod !== 'NoS' ||
				(state.gameState !== GameState.TASKS && state.gameState !== GameState.DISCUSSION) ||
				data.lobbyCode !== state.lobbyCode ||
				!sender ||
				sender.isLocal ||
				sender.disconnected ||
				data.playerId !== sender.id ||
				!Array.isArray(data.radios) ||
				data.radios.length > 8 ||
				!data.radios.every(isNosRadioData)
			)
				return;
			this.patch({
				nosRadiosByPlayer: {
					...this.snapshot.nosRadiosByPlayer,
					[sender.id]: { clientId: sender.clientId, radios: data.radios, receivedAt: Date.now() },
				},
			});
			return;
		}
		const fromHost = senderClientId !== undefined && senderClientId === this.host.parsedHostId;
		if (data.type === 'toh4e-lobby' || data.type === 'toh4e-roster' || data.type === 'toh4e-role') {
			if (
				!fromHost ||
				this.host.isHost ||
				data.lobbyCode !== state.lobbyCode ||
				state.gameState === GameState.MENU ||
				state.gameState === GameState.UNKNOWN
			)
				return;
		}
		if (data.type === 'toh4e-lobby' && typeof data.enabled === 'boolean') {
			if (!data.enabled) {
				this.tohRoleOverride = null;
				this.patch({ tohRole: null, tohGameStartNames: {} });
			}
			this.patch({ toh4eLobby: data.enabled });
			return;
		}
		if (data.type === 'toh4e-roster' && Array.isArray(data.players)) {
			if (data.players.length > 20) return;
			const names: numberStringMap = {};
			for (const value of data.players) {
				if (!value || typeof value !== 'object') return;
				const player = value as { clientId?: unknown; name?: unknown };
				if (!Number.isInteger(player.clientId) || typeof player.name !== 'string' || player.name.length > 100) return;
				names[player.clientId as number] = player.name;
			}
			this.patch({ tohGameStartNames: names, toh4eLobby: true });
			return;
		}
		if (
			data.type === 'toh4e-role' &&
			data.targetClientId === state.clientId &&
			data.targetPlayerId === state.players?.find((player) => player.isLocal)?.id &&
			(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION)
		) {
			if (data.role !== null && !isTohRole(data.role)) return;
			const role = isTohRole(data.role) ? data.role : null;
			this.tohRoleOverride = role;
			this.tohRoleReceivedAt = Date.now();
			this.patch({ tohRole: role, toh4eLobby: true });
			return;
		}
		if (Object.prototype.hasOwnProperty.call(data, 'impostorRadio')) {
			const clientId = this.connection.getClient(peerId)?.clientId;
			const sender = state.players?.find((player) => player.clientId === clientId);
			if (
				clientId !== undefined &&
				typeof data.impostorRadio === 'boolean' &&
				(typeof data.impostorRadioVersion === 'number'
					? Number.isSafeInteger(data.impostorRadioVersion) &&
						data.impostorRadioVersion >= (this.radioStatusVersions[clientId] ?? 0)
					: this.radioStatusVersions[clientId] === undefined) &&
				(!data.impostorRadio ||
					(sender &&
						(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
						!sender.isDead &&
						this.canUseRadio(state, sender)))
			) {
				if (typeof data.impostorRadioVersion === 'number')
					this.radioStatusVersions[clientId] = data.impostorRadioVersion;
				this.setRadioClientActive(clientId, data.impostorRadio);
			}
		}

		if (Object.prototype.hasOwnProperty.call(data, 'maxDistance')) {
			if (this.host.parsedHostId !== this.connection.getClient(peerId)?.clientId) return;
			this.patch({ activeLobbySettings: { ...defaultLobbySettings, ...data } as ILobbySettings });
		}
	}

	private static inputSignature(settings: ISettings): string {
		return [
			settings.microphone,
			settings.echoCancellation,
			settings.noiseSuppression,
			settings.autoGainControl,
			settings.oldSampleDebug,
			settings.microphoneGainEnabled,
			settings.micSensitivityEnabled,
		].join('|');
	}

	private reconnectToServer(serverURL: string): void {
		const stream = this.audio.outboundStream;
		if (!stream) return;
		this.connection.stop();
		this.wireConnection();
		this.connection.start(serverURL, stream);
	}

	private async rebuildAudioInput(): Promise<void> {
		const track = await this.audio.restartInput();
		if (!track || !this.started) return;
		this.connection.replaceOutboundTrack(track);
	}

	private onSettings(settings: ISettings): void {
		this.playerConfigs = settings.playerConfigMap;

		const inputSignature = VoiceController.inputSignature(settings);
		if (inputSignature !== this.prev.inputSignature) {
			this.prev.inputSignature = inputSignature;
			void this.rebuildAudioInput();
		}

		if (settings.serverURL !== this.prev.serverURL) {
			this.prev.serverURL = settings.serverURL;
			this.reconnectToServer(settings.serverURL);
		}

		if (settings.pushToTalkMode !== this.prev.pushToTalkMode) {
			this.prev.pushToTalkMode = settings.pushToTalkMode;
			this.audio.setPushToTalkMode(settings.pushToTalkMode);
		}

		if (settings.speaker !== this.prev.speaker) {
			this.prev.speaker = settings.speaker;
			this.audio.setSpeaker(settings.speaker);
		}

		if (settings.microphoneGain !== this.prev.microphoneGain || settings.micSensitivity !== this.prev.micSensitivity) {
			this.prev.microphoneGain = settings.microphoneGain;
			this.prev.micSensitivity = settings.micSensitivity;
			this.audio.updateMicrophoneSettings(settings);
		}

		if (settings.myLobbySettings !== this.prev.myLobbySettings) {
			this.prev.myLobbySettings = settings.myLobbySettings;
			if (this.host.isHost) {
				this.patch({ activeLobbySettings: settings.myLobbySettings });
				this.broadcastLobbySettings();
			}
		}
	}

	private onGameState(state: AmongUsState): void {
		if (!state) return;
		const myPlayer = state.players?.find((player) => player.isLocal);
		this.audio.setJammed(
			state.mod === 'NoS' &&
				this.activeLobbySettings.nosFixerJammingVoiceBlock !== false &&
				myPlayer?.nosPlayer?.isJammed === true
		);
		const resolvedHostId = state.hostId > 0 ? state.hostId : this.host.serverHostId;
		const session = `${state.lobbyCode}|${resolvedHostId}|${state.clientId}|${myPlayer?.id}`;
		const inactive = state.gameState === GameState.MENU || state.gameState === GameState.UNKNOWN;
		if (session !== this.prev.tohSession || inactive) {
			this.prev.tohSession = session;
			this.prev.tohLobbySentSignature = '';
			this.prev.tohRoleSentSignatures = {};
			this.prev.tohRoleSentAt = {};
			this.prev.tohRosterSentSignature = '';
			this.tohRoleOverride = null;
			this.tohLobbyNames = {};
			this.patch({ toh4eLobby: false, tohRole: null, tohGameStartNames: {} });
		}
		if (state.gameState === GameState.LOBBY || Date.now() - this.tohRoleReceivedAt > 5000) {
			this.tohRoleOverride = null;
			this.patch({ tohRole: null });
		}

		if (state.players && myPlayer) {
			this.host = {
				map: state.map,
				gamestate: state.gameState,
				code: state.lobbyCode,
				hostId: state.hostId,
				isHost: state.hostId > 0 ? state.isHost : this.host.serverHostId === state.clientId,
				parsedHostId: state.hostId > 0 ? state.hostId : this.host.serverHostId,
				serverHostId: this.host.serverHostId,
			};
			this.patch({ hostId: this.host.parsedHostId });
			const hostPlayer = state.players.find((player) => player.clientId === this.host.parsedHostId);
			const toh4eDetected =
				!inactive &&
				((this.host.isHost && state.mod === 'TOH4E') ||
					isToh4eHostName(hostPlayer?.name) ||
					isToh4eHostName(hostPlayer?.appearanceName));
			if (toh4eDetected && !this.snapshot.toh4eLobby) this.patch({ toh4eLobby: true });
			this.claimLobbySettingsOwnership(state);

			const activeLobbySettings = this.activeLobbySettings;
			let maxDistance = activeLobbySettings.visionHearing
				? myPlayer.isImpostor
					? activeLobbySettings.maxDistance
					: state.lightRadius + 0.5
				: activeLobbySettings.maxDistance;
			if (maxDistance <= 0.6) maxDistance = 1;
			this.audio.setMaxDistance(maxDistance);
		}

		this.connection.setContext({
			isHost: this.host.isHost,
			lobbyCode: state.lobbyCode,
			gameState: state.gameState,
			parsedHostId: this.host.parsedHostId,
			activeLobbySettings: this.activeLobbySettings,
		});

		this.handleHostChange(state);
		this.handleGameStateTransition(state, myPlayer);
		this.handleLobbyConnection(state, myPlayer);
		this.publishToh4eLobby(state);
		this.publishToh4eRoster(state);
		this.publishToh4eRole(state);
		this.handlePlayerIdentity(state, myPlayer);
		this.syncNosRadioReports(state, myPlayer);
		this.handlePublicLobby(state, myPlayer);
		this.cleanupImpostorRadio(state, myPlayer);
		this.updatePeerAudio(state, myPlayer);
		this.publishMobileAndObs(state, myPlayer);
	}

	private syncNosRadioReports(state: AmongUsState, myPlayer: Player | undefined): void {
		const active =
			state.mod === 'NoS' &&
			(state.gameState === GameState.TASKS || state.gameState === GameState.DISCUSSION) &&
			!!myPlayer;
		const session = active ? `${state.lobbyCode}|${state.clientId}` : '';
		if (session !== this.prev.nosRadioSession) {
			this.prev.nosRadioSession = session;
			this.prev.nosRadioSentSignature = '';
			this.prev.nosRadioSentAt = 0;
			if (Object.keys(this.snapshot.nosRadiosByPlayer).length) this.patch({ nosRadiosByPlayer: {} });
		}
		if (!active || !myPlayer) return;

		const now = Date.now();
		const current = this.snapshot.nosRadiosByPlayer;
		const nosRadiosByPlayer = Object.fromEntries(
			Object.entries(current).filter(([playerId, report]) =>
				state.players.some(
					(player) =>
						player.id === Number(playerId) &&
						player.clientId === report.clientId &&
						!player.disconnected &&
						now - report.receivedAt < 10000
				)
			)
		) as VoiceSnapshot['nosRadiosByPlayer'];
		if (Object.keys(nosRadiosByPlayer).length !== Object.keys(current).length) this.patch({ nosRadiosByPlayer });

		if (!state.nosRadios) return;
		const signature = JSON.stringify(state.nosRadios);
		if (signature === this.prev.nosRadioSentSignature && now - this.prev.nosRadioSentAt < 3000) return;
		const peers = state.players
			.filter((player) => !player.isLocal && !player.disconnected)
			.map((player) => this.connection.playerSocketIds[player.clientId])
			.filter(Boolean);
		this.connection.sendControlToPeers(
			peers,
			JSON.stringify({
				type: 'nos-radio-data',
				lobbyCode: state.lobbyCode,
				playerId: myPlayer.id,
				radios: state.nosRadios,
			})
		);
		this.prev.nosRadioSentSignature = signature;
		this.prev.nosRadioSentAt = now;
	}

	private publishToh4eRoster(state: AmongUsState, force = false): void {
		if (
			!this.host.isHost ||
			state.mod !== 'TOH4E' ||
			!Object.keys(this.snapshot.tohGameStartNames).length ||
			(state.gameState !== GameState.TASKS && state.gameState !== GameState.DISCUSSION)
		)
			return;
		const players = Object.entries(this.snapshot.tohGameStartNames).map(([clientId, name]) => ({
			clientId: Number(clientId),
			name,
		}));
		const signature = `${state.lobbyCode}|${JSON.stringify(players)}|${Math.floor(Date.now() / 1000)}`;
		if (!force && signature === this.prev.tohRosterSentSignature) return;
		this.prev.tohRosterSentSignature = signature;
		this.connection.broadcast(JSON.stringify({ type: 'toh4e-roster', lobbyCode: state.lobbyCode, players }));
	}

	private publishToh4eLobby(state: AmongUsState, force = false): void {
		if (!this.host.isHost || state.gameState === GameState.MENU || state.gameState === GameState.UNKNOWN) return;
		const enabled = state.mod === 'TOH4E' || this.snapshot.toh4eLobby;
		const signature = `${state.lobbyCode}|${enabled ? 1 : 0}|${Math.floor(Date.now() / 1000)}`;
		if (!force && signature === this.prev.tohLobbySentSignature) return;
		this.prev.tohLobbySentSignature = signature;
		this.connection.broadcast(JSON.stringify({ type: 'toh4e-lobby', lobbyCode: state.lobbyCode, enabled }));
	}

	private publishToh4eRole(state: AmongUsState): void {
		if (
			!this.host.isHost ||
			state.mod !== 'TOH4E' ||
			(state.gameState !== GameState.TASKS && state.gameState !== GameState.DISCUSSION)
		)
			return;
		const players = state.players ?? [];
		for (const player of players) {
			if (player.isLocal || player.disconnected) continue;
			const peerId = this.connection.playerSocketIds[player.clientId];
			if (!peerId) continue;
			const role = player.tohRole ?? null;
			const signature = `${state.lobbyCode}|${peerId}|${player.id}|${JSON.stringify(role)}`;
			if (
				signature === this.prev.tohRoleSentSignatures[player.clientId] &&
				Date.now() - this.prev.tohRoleSentAt[player.clientId] < 1000
			)
				continue;
			const sent = this.connection.sendToPeers(
				[peerId],
				JSON.stringify({
					type: 'toh4e-role',
					lobbyCode: state.lobbyCode,
					targetClientId: player.clientId,
					targetPlayerId: player.id,
					role,
				})
			);
			if (sent > 0) {
				this.prev.tohRoleSentSignatures[player.clientId] = signature;
				this.prev.tohRoleSentAt[player.clientId] = Date.now();
			}
		}
	}

	private claimLobbySettingsOwnership(state: AmongUsState): void {
		const lobbyCode = state.lobbyCode ?? 'MENU';
		const joinedOtherLobby = lobbyCode !== this.prev.lobbySettingsLobby;
		const becameHost = this.host.isHost && !this.prev.lobbySettingsHosted;
		this.prev.lobbySettingsLobby = lobbyCode;
		this.prev.lobbySettingsHosted = this.host.isHost;
		if (!joinedOtherLobby && !becameHost) return;

		if (!this.host.isHost) {
			this.patch({ activeLobbySettings: null });
			return;
		}

		const ownSettings = SettingsStore.store.myLobbySettings ?? defaultLobbySettings;
		this.prev.myLobbySettings = ownSettings;
		this.patch({ activeLobbySettings: ownSettings });
		this.broadcastLobbySettings();
	}

	private broadcastLobbySettings(): void {
		const peers = Object.values(this.connection.playerSocketIds).filter(Boolean);
		this.connection.sendControlToPeers(peers, JSON.stringify(this.activeLobbySettings));
	}

	private onGameStore(): void {
		const { gameState, gameOpen } = gameStore.getSnapshot();
		if (gameOpen !== this.prev.gameOpen) {
			this.prev.gameOpen = gameOpen;
			if (gameOpen) void this.publishGameInfo();
			else {
				this.tohRoleOverride = null;
				this.prev.tohSession = '';
				this.tohLobbyNames = {};
				this.patch({ toh4eLobby: false, tohRole: null, tohGameStartNames: {} });
			}
		}
		if (!gameOpen) {
			this.audio.setJammed(false);
			return;
		}
		this.onGameState(gameState);
	}

	private async publishGameInfo(): Promise<void> {
		if (!this.started || !this.snapshot.connected || !gameStore.getSnapshot().gameOpen) return;

		let gameInfo: GameInfo | null = null;
		try {
			gameInfo = (await ipcRenderer.invoke(IpcMessages.REQUEST_GAME_INFO)) as GameInfo | null;
		} catch (error) {
			console.warn('failed to read game info:', error);
			return;
		}
		if (!this.started || !gameInfo || gameInfo.broadcastVersion < 0) return;

		const signature = JSON.stringify(gameInfo);
		if (signature === this.prev.gameInfo) return;
		this.prev.gameInfo = signature;
		this.connection.sendGameInfo(gameInfo);
	}

	private handleHostChange(state: AmongUsState): void {
		if (state.isHost === this.prev.isHost) return;
		this.prev.isHost = state.isHost;
		if (state.isHost && state.hostId > 0) {
			this.connection.emitSetHost(state.lobbyCode, state.clientId);
			this.host.serverHostId = state.hostId;
		}
	}

	private handleGameStateTransition(state: AmongUsState, myPlayer: Player | undefined): void {
		if (state.gameState === this.prev.gameState) return;
		const previous = this.prev.gameState;
		this.prev.gameState = state.gameState;
		if (this.impostorRadioPressed && state.gameState === GameState.DISCUSSION) this.sendRadioStatus(state);

		if (state.gameState === GameState.LOBBY) {
			this.prev.tohRoleSentSignatures = {};
			this.prev.tohRosterSentSignature = '';
			this.tohLobbyNames = Object.fromEntries(
				(state.players ?? []).filter((player) => !player.disconnected).map((player) => [player.clientId, player.name])
			);
			this.patch({ otherDead: {}, tohGameStartNames: {} });
		} else if (
			state.gameState === GameState.TASKS &&
			previous === GameState.LOBBY &&
			this.host.isHost &&
			state.mod === 'TOH4E'
		) {
			const names = Object.keys(this.tohLobbyNames).length
				? this.tohLobbyNames
				: Object.fromEntries(
						(state.players ?? [])
							.filter((player) => !player.disconnected)
							.map((player) => [player.clientId, player.name])
					);
			this.prev.tohRosterSentSignature = '';
			this.patch({ tohGameStartNames: { ...names } });
		} else if (state.gameState !== GameState.TASKS && state.players) {
			const otherDead = { ...this.snapshot.otherDead };
			for (const player of state.players) {
				otherDead[player.clientId] = player.isDead || player.disconnected;
			}
			this.patch({ otherDead });
		}

		if (
			state.lobbyCode &&
			myPlayer?.clientId !== undefined &&
			state.gameState === GameState.LOBBY &&
			(previous === GameState.DISCUSSION || previous === GameState.TASKS)
		) {
			this.connection.setMobileRunning(false);
			this.connection.joinLobby(
				state.lobbyCode,
				myPlayer.clientId,
				state.clientId,
				state.isHost,
				myPlayer.friendCode,
				myPlayer.playerUid,
				myPlayer.playerIdentifier
			);
			this.tohRoleOverride = null;
			this.patch({ tohRole: null });
		} else if (previous !== GameState.UNKNOWN && previous !== GameState.MENU && state.gameState === GameState.MENU) {
			this.connection.setMobileRunning(false);
			this.connection.leaveLobby();
			this.tohRoleOverride = null;
			this.tohLobbyNames = {};
			this.patch({ otherDead: {}, toh4eLobby: false, tohRole: null, tohGameStartNames: {} });
		}
	}

	private handleLobbyConnection(state: AmongUsState, myPlayer: Player | undefined): void {
		const lobbyCode = state.lobbyCode ?? 'MENU';
		const playerName = myPlayer?.name ?? '';
		if (lobbyCode === this.prev.lobbyCode && playerName === this.prev.playerName) return;
		this.prev.lobbyCode = lobbyCode;
		this.prev.playerName = playerName;
		this.syncLobbyConnection();
	}

	private syncLobbyConnection(force = false): void {
		const { gameState: state } = gameStore.getSnapshot();
		if (!state) return;
		const myPlayer = state.players?.find((player) => player.isLocal);
		if (force) {
			this.prev.lobbyCode = state.lobbyCode ?? 'MENU';
			this.prev.playerName = myPlayer?.name ?? '';
		}
		this.connection.joinLobby(
			state.lobbyCode ?? 'MENU',
			myPlayer?.id ?? 0,
			state.clientId,
			state.isHost,
			myPlayer?.friendCode,
			myPlayer?.playerUid,
			myPlayer?.playerIdentifier
		);
		this.publishPublicLobby(state, myPlayer);
	}

	private handlePlayerIdentity(state: AmongUsState, myPlayer: Player | undefined): void {
		if (myPlayer && myPlayer.clientId !== undefined) {
			if (myPlayer.id !== this.prev.playerId || myPlayer.clientId !== this.prev.clientId) {
				this.prev.playerId = myPlayer.id;
				this.prev.clientId = myPlayer.clientId;
				this.connection.emitId(
					myPlayer.id,
					state.clientId,
					myPlayer.friendCode,
					myPlayer.playerUid,
					myPlayer.playerIdentifier
				);
			}
		}

		const vadHidden = this.isVadHidden(state, myPlayer);
		if (vadHidden !== this.prev.vadHidden) {
			this.prev.vadHidden = vadHidden;
			if (vadHidden) {
				this.connection.emitVad(false);
				this.patch({ talking: false });
			} else {
				this.connection.emitVad(this.localTalking);
				this.patch({ talking: this.localTalking });
			}
		}
	}

	private isVadHidden(state: AmongUsState, myPlayer: Player | undefined): boolean {
		if (
			state.mod === 'NoS' &&
			this.activeLobbySettings.nosFixerJammingVoiceBlock !== false &&
			myPlayer?.nosPlayer?.isJammed === true
		)
			return true;
		if (state.gameState === GameState.DISCUSSION) return false;
		return (myPlayer?.shiftedColor ?? -1) !== -1;
	}

	private handlePublicLobby(state: AmongUsState, myPlayer: Player | undefined): void {
		const settings = this.activeLobbySettings;
		const playerCount = state.players?.length ?? -1;
		if (
			state.gameState === this.prev.publicLobbyGameState &&
			playerCount === this.prev.playerCount &&
			settings.publicLobby_title === this.prev.publicLobbyTitle &&
			settings.publicLobby_language === this.prev.publicLobbyLanguage &&
			settings.publicLobby_on === this.prev.publicLobbyOn
		) {
			return;
		}
		this.prev.publicLobbyGameState = state.gameState;
		this.prev.playerCount = playerCount;
		this.prev.publicLobbyTitle = settings.publicLobby_title;
		this.prev.publicLobbyLanguage = settings.publicLobby_language;
		this.prev.publicLobbyOn = settings.publicLobby_on;
		this.publishPublicLobby(state, myPlayer);
	}

	private publishPublicLobby(state: AmongUsState, myPlayer: Player | undefined): void {
		if (isLiteRuntime()) return;
		if (!state || !this.host.isHost || !state.lobbyCode || state.gameState === GameState.MENU || !state.players) {
			return;
		}
		const activeLobbySettings = this.activeLobbySettings;
		this.connection.publishLobby(state.lobbyCode, {
			id: -1,
			title: activeLobbySettings.publicLobby_title,
			host: myPlayer?.name ?? '',
			current_players: state.players.length,
			max_players: state.maxPlayers,
			language: activeLobbySettings.publicLobby_language,
			mods: state.mod,
			isPublic: activeLobbySettings.publicLobby_on,
			gameState: state.gameState,
		});
	}

	private applyImpostorRadio(): void {
		const { gameState: state } = gameStore.getSnapshot();
		const myPlayer = state?.players?.find((player) => player.isLocal);
		if (!myPlayer || (this.impostorRadioPressed && (myPlayer.isDead || !this.canUseRadio(state, myPlayer)))) {
			return;
		}

		void radioOnAudio.play().catch(() => {
			/* autoplay blocked */
		});

		this.setRadioClientActive(myPlayer.clientId, this.impostorRadioPressed);

		this.sendRadioStatus(state);
	}

	private sendRadioStatus(state: AmongUsState): void {
		const myPlayer = state.players?.find((player) => player.isLocal);
		if (!myPlayer) return;
		const playerSocketIds = this.connection.playerSocketIds;
		const targets = (state.players ?? [])
			.filter(
				(player) =>
					!player.isLocal &&
					!player.bugged &&
					!player.disconnected
			)
			.map((player) => playerSocketIds[player.clientId])
			.filter(Boolean);
		this.connection.sendControlToPeers(
			targets,
			JSON.stringify({ impostorRadio: this.impostorRadioPressed, impostorRadioVersion: this.radioStatusVersion })
		);
		this.lastRadioStatusSentAt = Date.now();
	}

	private setRadioClientActive(clientId: number, active: boolean): void {
		const ids = new Set(this.snapshot.impostorRadioClientIds);
		if (active) ids.add(clientId);
		else ids.delete(clientId);
		const impostorRadioClientIds = [...ids];
		this.patch({ impostorRadioClientIds, impostorRadioClientId: impostorRadioClientIds[0] ?? -1 });
	}

	private cleanupImpostorRadio(state: AmongUsState, myPlayer: Player | undefined): void {
		if (!state.players || !myPlayer) return;
		if (this.impostorRadioPressed && (myPlayer.isDead || !this.canUseRadio(state, myPlayer)))
			this.setImpostorRadio(false);
		else if (this.impostorRadioPressed && Date.now() - this.lastRadioStatusSentAt >= 1000) this.sendRadioStatus(state);
		const valid = this.snapshot.impostorRadioClientIds.filter((clientId) => {
			if (clientId === myPlayer.clientId) return this.impostorRadioPressed && this.canUseRadio(state, myPlayer);
			const player = state.players?.find((candidate) => candidate.clientId === clientId);
			return (
				!!player &&
				this.canUseRadio(state, player) &&
				!player.isDead &&
				!player.disconnected &&
				!player.bugged
			);
		});
		if (valid.length !== this.snapshot.impostorRadioClientIds.length)
			this.patch({ impostorRadioClientIds: valid, impostorRadioClientId: valid[0] ?? -1 });
	}

	private isJackalRadioPlayer(state: AmongUsState, player: Player): boolean {
		return state.mod === 'SUPER_NEW_ROLES' && isSnrJackalTeam(player.snrRole);
	}

	private getNosRadios(state: AmongUsState, player: Player) {
		if (state.mod !== 'NoS') return undefined;
		if (player.isLocal) return state.nosRadios;
		const report = this.snapshot.nosRadiosByPlayer[player.id];
		return report?.clientId === player.clientId ? report.radios : undefined;
	}

	private canNosJackalRadioReach(state: AmongUsState, sender: Player, listener: Player): boolean {
		return canHearNosJackalRadio(this.getNosRadios(state, sender), listener.id);
	}

	private hasNosJackalRadio(state: AmongUsState, player: Player): boolean {
		return this.getNosRadios(state, player)?.some((radio) => radio.kind === NOS_JACKAL_RADIO_KIND) ?? false;
	}

	private canUseRadio(state: AmongUsState, player: Player): boolean {
		if (state.mod === 'NoS' && this.hasNosJackalRadio(state, player))
			return (
				this.activeLobbySettings.jackalRadioEnabled === true && this.activeLobbySettings.impostorRadioOnlyMode !== true
			);
		if (this.isJackalRadioPlayer(state, player)) {
			return (
				this.activeLobbySettings.jackalRadioEnabled === true && this.activeLobbySettings.impostorRadioOnlyMode !== true
			);
		}
		return (
			player.isImpostor &&
			(this.activeLobbySettings.impostorRadioEnabled || this.activeLobbySettings.impostorRadioOnlyMode)
		);
	}

	private areRadioPartners(state: AmongUsState, first: Player, second: Player): boolean {
		if (state.mod === 'NoS' && this.hasNosJackalRadio(state, second))
			return (
				this.activeLobbySettings.jackalRadioEnabled === true &&
				this.activeLobbySettings.impostorRadioOnlyMode !== true &&
				this.canNosJackalRadioReach(state, second, first)
			);
		if (!this.areRadioTeammates(state, first, second)) return false;
		if (this.isJackalRadioPlayer(state, first)) {
			return (
				this.activeLobbySettings.jackalRadioEnabled === true && this.activeLobbySettings.impostorRadioOnlyMode !== true
			);
		}
		return this.activeLobbySettings.impostorRadioEnabled || this.activeLobbySettings.impostorRadioOnlyMode;
	}

	private areRadioTeammates(state: AmongUsState, first: Player, second: Player): boolean {
		if (state.mod === 'NoS' && this.hasNosJackalRadio(state, first))
			return this.canNosJackalRadioReach(state, first, second);
		if (this.isJackalRadioPlayer(state, first)) return this.isJackalRadioPlayer(state, second);
		return first.isImpostor && second.isImpostor && !this.isJackalRadioPlayer(state, second);
	}

	getVisibleRadioClientIds(state: AmongUsState): number[] {
		const local = state.players?.find((player) => player.isLocal);
		if (!local || !this.canUseRadio(state, local)) return [];
		return this.snapshot.impostorRadioClientIds.filter((clientId) => {
			const sender = state.players?.find((player) => player.clientId === clientId);
			return !!sender && (sender.isLocal || this.areRadioPartners(state, local, sender));
		});
	}

	private updatePeerAudio(state: AmongUsState, myPlayer: Player | undefined): void {
		if (!state.players || !myPlayer) return;

		const settings = SettingsStore.store;
		const activeLobbySettings = this.activeLobbySettings;
		const audioState = this.getEffectiveGameState(state);
		const audioMe = audioState.players.find((player) => player.isLocal) ?? myPlayer;
		const playerSocketIds = this.connection.playerSocketIds;
		const handledPeerIds: string[] = [];
		const otherTalking = { ...this.snapshot.otherTalking };
		let talkingChanged = false;

		for (const player of state.players) {
			if (player.isLocal || player.clientId === myPlayer.clientId) continue;
			const peerId = playerSocketIds[player.clientId];
			if (!peerId || !this.audio.hasPeer(peerId)) continue;

			handledPeerIds.push(peerId);
			let gain = this.audio.applyVoiceAudio(
				peerId,
				audioState,
				settings,
				activeLobbySettings,
				audioMe,
				player,
				this.snapshot.impostorRadioClientId,
				this.snapshot.impostorRadioClientIds,
				this.canNosJackalRadioReach(state, player, myPlayer)
			);
			if (gain === null) continue;

			if (
				this.audio.deafened ||
				(this.playerConfigs[player.playerConfigId] ?? this.playerConfigs[player.nameHash])?.isMuted
			) {
				gain = 0;
			}

			if (gain > 0) {
				const playerVolume = (this.playerConfigs[player.playerConfigId] ?? this.playerConfigs[player.nameHash])?.volume;
				gain = playerVolume === undefined ? gain : gain * playerVolume;
				if (myPlayer.isDead && !player.isDead) {
					gain = gain * (settings.crewVolumeAsGhost / 100);
				}
				gain = gain * (settings.masterVolume / 100);
			}

			this.audio.setPeerGain(peerId, gain);

			const talking = Boolean(this.otherVAD[player.clientId]) && gain > 0;
			if (talking !== otherTalking[player.clientId]) {
				otherTalking[player.clientId] = talking;
				talkingChanged = true;
			}
		}

		this.audio.silencePeersExcept(handledPeerIds);

		if (talkingChanged) {
			this.patch({ otherTalking });
		}
	}

	private publishMobileAndObs(state: AmongUsState, myPlayer: Player | undefined): void {
		state = this.getEffectiveGameState(state);
		myPlayer = state.players?.find((player) => player.isLocal) ?? myPlayer;
		const settings = SettingsStore.store;
		if (!state.players) return;
		if (!this.connection.isMobileRunning && !settings.obsOverlay) return;

		if (this.connection.isMobileRunning) {
			this.connection.signalTo(state.lobbyCode + '_mobile', {
				gameState: state,
				activeLobbySettings: this.activeLobbySettings,
			});
		}

		if (
			!settings.obsOverlay ||
			!settings.obsSecret ||
			settings.obsSecret.length !== 9 ||
			!(
				(state.gameState !== GameState.UNKNOWN && state.gameState !== GameState.MENU) ||
				state.oldGameState !== state.gameState
			)
		) {
			return;
		}

		const { playerColors } = gameStore.getSnapshot();
		const { socketClients, playerSocketIds, otherTalking, otherDead, talking } = this.snapshot;
		const visibleRadioClientIds = myPlayer ? this.getVisibleRadioClientIds(state) : [];

		const obsVoiceState: ObsVoiceState = {
			overlayState: {
				gameState: state.gameState,
				players: state.players.map((player) => ({
					id: player.id,
					clientId: player.clientId,
					inVent: player.inVent,
					isDead: player.isDead,
					name: player.name,
					hatId: player.hatId,
					petId: player.petId,
					skinId: player.skinId,
					visorId: player.visorId,
					disconnected: player.disconnected,
					isLocal: player.isLocal,
					bugged: player.bugged,
					...(state.mod === 'NoS'
						? { nosColor: player.nosLobbyColor ?? nosColorHex(player.nosPlayer) }
						: {
								colorId: player.colorId,
								shiftedColor: player.shiftedColor,
								realColor: playerColors[player.colorId],
							}),
					usingRadio:
						visibleRadioClientIds.includes(player.clientId),
					connected:
						(playerSocketIds[player.clientId] &&
							socketClients[playerSocketIds[player.clientId]]?.clientId === player.clientId) ||
						false,
				})),
			},
			otherTalking,
			otherDead,
			localTalking: talking,
			localIsAlive: !myPlayer?.isDead,
			mod: state.mod,
			oldMeetingHud: state.oldMeetingHud,
		};

		const payload = JSON.stringify(obsVoiceState);
		if (payload === this.prev.obsPayload) return;
		this.prev.obsPayload = payload;

		this.connection.signalTo(settings.obsSecret, obsVoiceState);
	}

	private publishOverlayVoiceState(): void {
		if (!SettingsStore.store.enableOverlay) return;
		const state = gameStore.getSnapshot().gameState;
		if (!state) return;
		const myPlayer = state.players?.find((player) => player.isLocal);
		const { otherTalking, playerSocketIds, otherDead, socketClients, audioConnected, talking, muted, deafened } =
			this.snapshot;
		const visibleRadioClientIds = this.getVisibleRadioClientIds(state);

		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, {
			otherTalking,
			playerSocketIds,
			otherDead,
			socketClients,
			audioConnected,
			localTalking: talking,
			localIsAlive: !myPlayer?.isDead,
			impostorRadioClientId: visibleRadioClientIds[0] ?? -1,
			impostorRadioClientIds: visibleRadioClientIds,
			muted,
			deafened,
			mod: state.mod,
		} as VoiceState);
	}
}
