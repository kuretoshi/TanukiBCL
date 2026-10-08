import { CameraLocation, MapType } from './AmongusMap';
import { ModsType } from './Mods';
import type { SnrLiveRole } from './SnrRole';
import type { NosPlayerData, NosRadioData } from './NosSnapshot';
import type { TohRole } from './TohRole';

export interface AmongUsState {
	gameState: GameState;
	oldGameState: GameState;
	lobbyCodeInt: number;
	lobbyCode: string;
	players: Player[];
	isHost: boolean;
	clientId: number;
	hostId: number;
	comsSabotaged: boolean;
	mixupSabotaged: boolean;
	camouflaged: boolean;
	currentCamera: CameraLocation;
	map: MapType;
	lightRadius: number;
	lightRadiusChanged: boolean;
	closedDoors: number[];
	maxPlayers: number;
	mod: ModsType;
	oldMeetingHud: boolean;
	airshipMeetingByOutfit: boolean;
	nosReadStatus?: { failed: boolean; message: string; schemaVersion?: number };
	nosLoadedContents?: { path: string; status: string; data?: unknown };
	nosLocalMicPosition?: { x: number; y: number };
	nosRadios?: NosRadioData[];
	debug?: {
		rawGameState: number;
		meetingHud: number;
		meetingHudCachePtr: number;
		meetingHudState: number;
		onlineScene: number;
		mainMenuScene: number;
		localTaskPtr: number;
		localObjectFlags: string;
		initPatternDebug: string;
		airshipMeetingByOutfit: boolean;
		currentOutfits: string;
		localObjectDiffs: string;
		localPlayerDiffs: string;
		innerNetDiffs: string;
		localRoleTeam: number;
		localRoleLabel: string;
		localRolePtr: number;
		localRoleDiffs: string;
		localRoleSnapshot: string;
		colorDebug: string;
		sizeDebug: string;
		snrRoleStatus?: string;
		nosSnapshotStatus?: string;
		tohRoleStatus?: string;
	};
}

export interface Player {
	ptr: number;
	id: number;
	clientId: number;
	name: string;
	nameHash: number;
	playerConfigId: number;
	friendCode: string;
	playerUid: string;
	playerIdentifier: string;
	colorId: number;
	hatId: string;
	petId: number;
	skinId: string;
	visorId: string;
	currentOutfit: number;
	appearanceName: string;
	appearanceColorId: number;
	appearanceHatId: string;
	appearanceSkinId: string;
	appearanceVisorId: string;
	appearanceId: string;
	disconnected: boolean;
	rolePtr: number;
	roleTeam: number;
	roleName: string;
	snrRole?: SnrLiveRole;
	snrHat2Id?: string;
	snrVisor2Id?: string;
	nosPlayer?: NosPlayerData;
	nosCosmetics?: Partial<Record<'skin' | 'hat' | 'hatBack' | 'visor' | 'bodyMask', string>>;
	tohRole?: TohRole;
	vanillaIsImpostor?: boolean;
	/** Host-confirmed TOH faction flag; never a substitute role name. */
	tohImpostor?: boolean;
	nosLobbyColor?: string;
	isImpostor: boolean;
	isThirdParty: boolean;
	isDead: boolean;
	taskPtr: number;
	objectPtr: number;
	isLocal: boolean;
	shiftedColor: number;
	bugged: boolean;
	x: number;
	y: number;
	inVent: boolean;
	isDummy: boolean;
}

export function hasVisibleAppearanceChanged(player: Player): boolean {
	const normalizeHatId = (hatId: string | undefined) => (hatId === 'hat_NoHat' ? '' : hatId || '');
	const normalizeSkinId = (skinId: string | undefined) => (skinId === 'skin_None' ? '' : skinId || '');
	const normalizeVisorId = (visorId: string | undefined) => (visorId === 'visor_EmptyVisor' ? '' : visorId || '');

	if (player.currentOutfit <= 0 || player.currentOutfit > 10) {
		return false;
	}

	const originalAppearance = [
		player.colorId,
		normalizeHatId(player.hatId),
		normalizeSkinId(player.skinId),
		normalizeVisorId(player.visorId),
	].join('|');
	const visibleAppearance = [
		player.appearanceColorId,
		normalizeHatId(player.appearanceHatId),
		normalizeSkinId(player.appearanceSkinId),
		normalizeVisorId(player.appearanceVisorId),
	].join('|');

	return visibleAppearance !== originalAppearance;
}

export enum GameState {
	LOBBY,
	TASKS,
	DISCUSSION,
	MENU,
	UNKNOWN,
}

export interface Client {
	playerId: number;
	clientId: number;
}
export interface SocketClientMap {
	[socketId: string]: Client;
}
export interface ClientBoolMap {
	[clientId: number]: boolean; // isTalking
}

export interface AudioConnected {
	[peer: string]: boolean; // isConnected
}

export interface numberStringMap {
	[index: number]: string;
}

export interface VoiceState {
	otherTalking: ClientBoolMap;
	playerSocketIds: numberStringMap;
	otherDead: ClientBoolMap;
	socketClients: SocketClientMap;
	audioConnected: AudioConnected;
	impostorRadioClientId: number;
	impostorRadioClientIds?: number[];
	localTalking: boolean;
	localIsAlive: boolean;
	muted: boolean;
	deafened: boolean;
	mod: ModsType;
}
