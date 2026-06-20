import { CameraLocation, MapType } from './AmongusMap';
import { ModsType } from './Mods';

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
	currentServer: string;
	maxPlayers: number;
	mod: ModsType;
	oldMeetingHud: boolean;
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
	};
}

export interface Player {
	ptr: number;
	id: number;
	clientId: number;
	name: string;
	nameHash: number;
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
	isImpostor: boolean;
	isThirdParty: boolean;
	isDead: boolean;
	taskPtr: number;
	objectPtr: number;
	isLocal: boolean;
	shiftedColor : number;
	bugged: boolean;
	x: number;
	y: number;
	inVent: boolean;
	isDummy: boolean;
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
	localTalking: boolean;
	localIsAlive: boolean;
	muted: boolean;
	deafened: boolean;
	mod: ModsType;
}
