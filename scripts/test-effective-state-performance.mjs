import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
	return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}

const { GameState } = await bundle('src/common/AmongUsState.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const impostor = await bundle('src/common/Impostor.ts');
const toh = await bundle('src/common/TohRole.ts');
const source = ts.createSourceFile(
	'VoiceController.ts',
	await readFile(process.env.TANUKI_EFFECTIVE_STATE_BASELINE ?? 'src/renderer/voice/VoiceController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const declaration = source.statements.find(
	(node) => ts.isClassDeclaration(node) && node.name.text === 'VoiceController'
);
const names = new Set([
	'activeLobbySettings',
	'getEffectiveGameState',
	'onGameState',
	'onPeerData',
	'syncNosPseudocide',
	'updatePeerAudio',
	'publishMobileAndObs',
	'patch',
]);
const members = declaration.members.filter((node) => names.has(node.name?.getText(source)));
assert.equal(members.length, names.size, 'execute all selected production methods');
const emptyPrev = source.statements
	.find((node) => ts.isFunctionDeclaration(node) && node.name.text === 'emptyPrev')
	.getText(source);
const code = ts.transpileModule(
	`${emptyPrev}\nclass Controller { ${members.map((node) => node.getText(source)).join('\n')} }\n({ Controller, emptyPrev });`,
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
let now = 20000;

function makeController(initialState) {
	let state = initialState;
	const distanceStates = [];
	const audioStates = [];
	const mobileStates = [];
	const sandbox = {
		...impostor,
		...toh,
		GameState,
		defaultLobbySettings,
		OVERLAY_VOICE_KEYS: [],
		SettingsStore: { store: { obsOverlay: false, enableOverlay: false, masterVolume: 100 } },
		gameStore: { getSnapshot: () => ({ gameState: state }) },
		Date: { now: () => now },
		voiceJammingFor: () => undefined,
		isToh4eHostName: () => false,
		voiceHearingDistance: (value) => {
			distanceStates.push(value);
			return 5.32;
		},
		packageJson: { version: 'fixture' },
	};
	const { Controller, emptyPrev: prev } = vm.runInNewContext(code, sandbox);
	const controller = new Controller();
	controller.snapshot = {
		toh4eLobby: false,
		tohRole: null,
		tohRoleCatalog: [],
		tohGameStartNames: {},
		otherTalking: {},
		impostorRadioClientIds: [],
		activeLobbySettings: { ...defaultLobbySettings },
	};
	controller.nosPseudocideReports = {};
	controller.nosPseudocideSession = `${state.lobbyCode}|${state.clientId}`;
	controller.nosPseudocideSentAt = 0;
	controller.tohRoleOverride = null;
	controller.tohRoleReceivedAt = now;
	controller.tohCatalogReceivedAt = now;
	controller.host = { isHost: true, parsedHostId: 1, serverHostId: 1 };
	controller.prev = prev();
	controller.prev.tohSession = `${state.lobbyCode}|${state.hostId}|${state.clientId}|0`;
	controller.versionSession = `${state.lobbyCode}|${state.clientId}`;
	controller.versionSentAt = now;
	controller.playerConfigs = {};
	controller.connection = {
		setContext() {},
		broadcast() {},
		sendControlToPeers() {},
		playerSocketIds: Object.fromEntries(state.players.map((player) => [player.clientId, String(player.clientId)])),
		isMobileRunning: false,
		getClient: (peerId) => ({ clientId: Number(peerId) }),
	};
	controller.audio = {
		updateGameState() {},
		setJammed() {},
		setMaxDistance() {},
		hasPeer: () => true,
		silencePeersExcept() {},
		applyVoiceAudio: (_peer, value) => {
			audioStates.push(value);
			return null;
		},
	};
	controller.canNosJackalRadioReach = () => false;
	controller.canNosImpostorRadioReach = () => false;
	controller.otherVAD = {};
	controller.emit = () => {};
	for (const name of [
		'claimLobbySettingsOwnership',
		'updateVersionWarning',
		'handleHostChange',
		'handleGameStateTransition',
		'refreshMeetingDeathDisplay',
		'handleLobbyConnection',
		'publishToh4eLobby',
		'publishToh4eRoster',
		'publishToh4eRole',
		'handlePlayerIdentity',
		'syncNosRadioReports',
		'handlePublicLobby',
		'cleanupImpostorRadio',
	])
		controller[name] = () => {};
	const publish = controller.publishMobileAndObs;
	controller.publishMobileAndObs = (value, player) => {
		mobileStates.push(value);
		return publish.call(controller, value, player);
	};
	return { controller, distanceStates, audioStates, mobileStates, setState: (value) => (state = value) };
}

function game(code = 'ABCDEF') {
	return {
		mod: 'NoS',
		gameState: GameState.TASKS,
		oldGameState: GameState.TASKS,
		lobbyCode: code,
		clientId: 1,
		hostId: 1,
		isHost: true,
		map: 0,
		players: Array.from({ length: 15 }, (_, id) => ({
			id,
			clientId: id + 1,
			isLocal: id === 0,
			name: `Player ${id}`,
			isDead: false,
			isImpostor: false,
			disconnected: false,
			x: id,
			y: 0,
		})),
	};
}

function copies(input, output) {
	return output.players.filter((player, index) => player !== input.players[index]).length;
}

const raw = game();
for (const player of raw.players) Object.freeze(player);
Object.freeze(raw.players);
Object.freeze(raw);
const { controller } = makeController(raw);
assert.equal(controller.getEffectiveGameState(raw), raw, 'ordinary NoS state is reused');
const localState = { ...raw, nosLocalIsPseudocide: false };
const local = controller.getEffectiveGameState(localState);
assert.equal(copies(localState, local), 1, 'only the changed local player is copied');
assert.equal(local.players[0].nosIsPseudocide, false);
assert.equal(controller.getEffectiveGameState(local), local, 'already resolved values do not allocate more players');
assert.equal(raw.players[0].nosIsPseudocide, undefined, 'raw players stay unchanged');

const report = (active, extra = {}) => ({
	type: 'nos-pseudocide',
	lobbyCode: raw.lobbyCode,
	playerId: 1,
	active,
	...extra,
});
controller.onPeerData('2', report(true));
const remote = controller.getEffectiveGameState(raw);
assert.equal(copies(raw, remote), 1, 'only the changed remote player is copied');
assert.equal(remote.players[1].nosIsPseudocide, true);
controller.onPeerData('2', report(false));
assert.equal(
	controller.getEffectiveGameState(raw).players[1].nosIsPseudocide,
	false,
	'same raw state sees a new report immediately'
);
assert.equal(
	controller.getEffectiveGameState(remote).players[1].nosIsPseudocide,
	false,
	'new reports also replace an already derived value'
);
controller.onPeerData('2', report(true));
const receivedAt = now;
now = receivedAt + 9999;
assert.equal(
	controller.getEffectiveGameState(raw).players[1].nosIsPseudocide,
	true,
	'report remains valid just before 10 seconds'
);
now = receivedAt + 10000;
assert.equal(controller.getEffectiveGameState(raw), raw, 'expiry is checked without a new game frame');
assert.equal(
	controller.getEffectiveGameState(remote).players[1].nosIsPseudocide,
	undefined,
	'expiry clears a previously derived active flag'
);
controller.nosPseudocideReports[1] = { clientId: 999, active: true, receivedAt: now };
assert.equal(
	controller.getEffectiveGameState(raw),
	raw,
	'reused player ID with another client cannot inherit a report'
);
controller.nosPseudocideReports = {};
controller.onPeerData('3', report(true));
controller.onPeerData('2', report(true, { lobbyCode: 'OTHER' }));
controller.onPeerData('2', report('true'));
assert.equal(
	controller.getEffectiveGameState(raw),
	raw,
	'forged sender, lobby and malformed reports do not change state'
);

const tick = makeController(raw);
const resolveEffective = tick.controller.getEffectiveGameState;
let resolutions = 0;
let playerCopies = 0;
const resolvedStates = [];
tick.controller.getEffectiveGameState = (state) => {
	resolutions++;
	const value = resolveEffective.call(tick.controller, state);
	playerCopies += copies(state, value);
	resolvedStates.push(value);
	return value;
};
for (let index = 0; index < 100; index++) {
	const frame = structuredClone(raw);
	tick.setState(frame);
	tick.controller.onGameState(frame);
}
assert.equal(resolutions, 100, '100 updates derive the effective state once each');
assert.equal(playerCopies, 0, '100 updates and 15 unchanged players allocate no player copies');
assert.equal(tick.distanceStates.length, 100);
assert.equal(tick.audioStates.length, 1400);
assert.equal(tick.mobileStates.length, 100);
for (let index = 0; index < 100; index++) {
	assert.equal(tick.distanceStates[index], resolvedStates[index], 'hearing distance uses the shared state');
	assert.equal(tick.mobileStates[index], resolvedStates[index], 'mobile/OBS uses the shared state');
	for (const value of tick.audioStates.slice(index * 14, (index + 1) * 14))
		assert.equal(value, resolvedStates[index], 'all audio peers use the shared state');
}

const frames = [];
const packets = [];
tick.controller.connection.isMobileRunning = true;
tick.controller.connection.signalTo = (target, packet) => packets.push({ target, packet });
tick.controller.mobileCosmetics = {
	frame(state) {
		frames.push(state);
		return { type: 'fixture-frame', players: state.players };
	},
};
for (let index = 0; index < 100; index++) {
	const frame = structuredClone(raw);
	tick.setState(frame);
	tick.controller.onGameState(frame);
}
assert.equal(resolutions, 200, 'another 100 updates still derive once each with mobile enabled');
assert.equal(playerCopies, 0, 'mobile publishing does not introduce extra player copies');
assert.equal(frames.length, 100);
assert.equal(packets.length, 100, 'every mobile frame is still sent');
for (let index = 0; index < frames.length; index++) {
	assert.equal(frames[index], resolvedStates[index + 100], 'mobile serializes the same resolved state as audio');
	assert.equal(packets[index].target, 'ABCDEF_mobile');
	assert.equal(packets[index].packet.activeLobbySettings, tick.controller.activeLobbySettings);
}

const nextLobby = game('NEXT');
tick.controller.nosPseudocideReports[1] = { clientId: 2, active: true, receivedAt: now };
tick.setState(nextLobby);
tick.controller.onGameState(nextLobby);
assert.equal(tick.controller.nosPseudocideSession, 'NEXT|1');
assert.equal(Object.keys(tick.controller.nosPseudocideReports).length, 0, 'new lobby clears reports');
assert.equal(
	tick.audioStates.at(-1).players[1].nosIsPseudocide,
	undefined,
	'old lobby data is cleared before audio resolves'
);
assert.equal(
	tick.distanceStates.at(-1).players[1].nosIsPseudocide,
	undefined,
	'old lobby data is cleared before distance resolves'
);
assert.equal(
	tick.mobileStates.at(-1).players[1].nosIsPseudocide,
	undefined,
	'old lobby data is cleared before publishing'
);

const tohState = { ...game(), mod: 'NONE', clientId: 2, isHost: false };
const tohController = makeController(tohState).controller;
tohController.host = { isHost: false, parsedHostId: 1, serverHostId: 1 };
tohController.snapshot.toh4eLobby = true;
const role = {
	roleId: 42,
	roleName: 'Impostor',
	customRoleType: 'Impostor',
	isKiller: true,
	isNeutralKiller: false,
};
// Local player id remains zero, while client id matches the TOH packet target.
tohState.players[0] = { ...tohState.players[0], clientId: 2, isImpostor: true };
tohState.players[1] = { ...tohState.players[1], clientId: 1, isImpostor: true };
const rolePacket = {
	type: 'toh4e-role',
	lobbyCode: tohState.lobbyCode,
	targetClientId: 2,
	targetPlayerId: 0,
	role,
	impostors: [{ playerId: 1, clientId: 1, isImpostor: true }],
};
tohController.onPeerData('1', rolePacket);
assert.equal(
	tohController.getEffectiveGameState(tohState).players[0].tohRole.roleId,
	42,
	'host role is applied immediately'
);
const roleReceivedAt = now;
now = roleReceivedAt + 5000;
assert.equal(
	tohController.getEffectiveGameState(tohState).players[0].tohRole.roleId,
	42,
	'TOH role is valid at the 5-second boundary'
);
assert.equal(tohController.getEffectiveGameState(tohState).players[1].isImpostor, true);
now++;
assert.equal(
	tohController.getEffectiveGameState(tohState).players[0].tohRole,
	undefined,
	'TOH role expires without a new frame'
);
assert.equal(
	tohController.getEffectiveGameState(tohState).players[1].isImpostor,
	false,
	'expired faction grants no impostor permission'
);
tohController.onPeerData('1', {
	...rolePacket,
	role: { ...role, roleId: 43, roleName: 'Crewmate', customRoleType: 'Crewmate' },
});
assert.equal(
	tohController.getEffectiveGameState(tohState).players[0].tohRole.roleId,
	43,
	'same raw frame sees a refreshed TOH role immediately'
);
assert.equal(tohState.players[0].tohRole, undefined, 'TOH derivation leaves raw state unchanged');

console.log(
	'PASS effective state: 100 updates / 15 players -> 100 derivations, zero unchanged player copies; shared distance/audio/mobile state, lobby reset, immediate reports, NoS 10s and TOH 5s expiry'
);
