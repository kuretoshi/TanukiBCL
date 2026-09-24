import { ILobbySettings } from '../../common/ISettings';
import { IpcMessages, IpcSettingsMessages } from '../../common/ipc-messages';
import { ipcRenderer } from '../lib/electron-bridge';
import { voiceController } from '../voice/useVoiceController';
import { gameStore } from './gameStore';

let started = false;
let unsubscribeGameStore: (() => void) | undefined;
let unsubscribeVoice: (() => void) | undefined;
let lastSentGameState: unknown;
let lastSentPlayerColors: unknown;
let lastSentActiveLobbySettings: ILobbySettings | null | undefined;
let lastSentHostId: number | undefined;
let lastSentTohLobby: boolean | undefined;
let lastSentTohRole: unknown;
let lastSentTohNames: unknown;

function sendGameState(): void {
	const { gameState } = gameStore.getSnapshot();
	lastSentGameState = gameState;
	const voice = voiceController.getSnapshot();
	lastSentTohLobby = voice.toh4eLobby;
	lastSentTohRole = voice.tohRole;
	lastSentTohNames = voice.tohGameStartNames;
	ipcRenderer.send(
		IpcMessages.SEND_TO_SETTINGS,
		IpcSettingsMessages.NOTIFY_GAME_STATE_CHANGED,
		voiceController.getEffectiveGameState(gameState)
	);
}

function sendPlayerColors(): void {
	const { playerColors } = gameStore.getSnapshot();
	lastSentPlayerColors = playerColors;
	ipcRenderer.send(IpcMessages.SEND_TO_SETTINGS, IpcSettingsMessages.NOTIFY_PLAYER_COLORS_CHANGED, playerColors);
}

function sendActiveLobbySettings(): void {
	const { activeLobbySettings } = voiceController.getSnapshot();
	lastSentActiveLobbySettings = activeLobbySettings;
	ipcRenderer.send(
		IpcMessages.SEND_TO_SETTINGS,
		IpcSettingsMessages.NOTIFY_ACTIVE_LOBBY_SETTINGS_CHANGED,
		activeLobbySettings
	);
}

function sendHostId(): void {
	const { hostId } = voiceController.getSnapshot();
	lastSentHostId = hostId;
	ipcRenderer.send(IpcMessages.SEND_TO_SETTINGS, IpcSettingsMessages.NOTIFY_HOST_ID_CHANGED, hostId);
}

function sendDebugVoice(): void {
	const voice = voiceController.getSnapshot();
	ipcRenderer.send(IpcMessages.SEND_TO_SETTINGS, IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED, {
		connected: voice.connected,
		error: voice.error,
		muted: voice.muted,
		deafened: voice.deafened,
		talking: voice.talking,
		otherTalking: voice.otherTalking,
		playerSocketIds: voice.playerSocketIds,
		audioConnected: voice.audioConnected,
		impostorRadioClientId: voice.impostorRadioClientId,
		toh4eLobby: voice.toh4eLobby,
		tohRole: voice.tohRole,
	});
}
function sendAll(): void {
	sendDebugVoice();
	sendGameState();
	sendPlayerColors();
	sendActiveLobbySettings();
	sendHostId();
}

function onGameStoreChanged(): void {
	const { gameState, playerColors } = gameStore.getSnapshot();
	if (gameState !== lastSentGameState) sendGameState();
	if (playerColors !== lastSentPlayerColors) sendPlayerColors();
}

function onVoiceChanged(): void {
	sendDebugVoice();
	const { activeLobbySettings, hostId } = voiceController.getSnapshot();
	const { toh4eLobby, tohRole, tohGameStartNames } = voiceController.getSnapshot();
	if (toh4eLobby !== lastSentTohLobby || tohRole !== lastSentTohRole || tohGameStartNames !== lastSentTohNames)
		sendGameState();
	if (activeLobbySettings !== lastSentActiveLobbySettings) sendActiveLobbySettings();
	if (hostId !== lastSentHostId) sendHostId();
}

export function startSettingsWindowBridge(): void {
	if (started) return;
	started = true;

	unsubscribeGameStore = gameStore.subscribe(onGameStoreChanged);
	unsubscribeVoice = voiceController.subscribe(onVoiceChanged);
	ipcRenderer.on(IpcSettingsMessages.REQUEST_INITVALUES, sendAll);
	sendAll();
}

export function stopSettingsWindowBridge(): void {
	if (!started) return;
	started = false;
	unsubscribeGameStore?.();
	unsubscribeGameStore = undefined;
	unsubscribeVoice?.();
	unsubscribeVoice = undefined;
	ipcRenderer.off(IpcSettingsMessages.REQUEST_INITVALUES, sendAll);
}
