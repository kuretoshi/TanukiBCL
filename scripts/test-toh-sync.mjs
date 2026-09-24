import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';

// Execute the production controller methods with in-memory peer channels and a deterministic clock.
const cache = resolve('.cache/toh-sync-tests');
await mkdir(cache, { recursive: true });
async function bundle(file) {
	const output = resolve(cache, file.split('/').at(-1).replace('.ts', '.mjs'));
	const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	await writeFile(output, result.outputFiles[0].contents);
	return import(pathToFileURL(output));
}
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { isToh4eHostName } = await bundle('src/common/Mods.ts');
const { isTohRole } = await bundle('src/common/TohRole.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const source = ts.createSourceFile(
	'VoiceController.ts',
	await readFile('src/renderer/voice/VoiceController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const controller = source.statements.find((n) => ts.isClassDeclaration(n) && n.name.text === 'VoiceController');
const names = [
	'onGameState',
	'onPeerData',
	'publishToh4eLobby',
	'publishToh4eRoster',
	'publishToh4eRole',
	'getEffectiveGameState',
	'patch',
	'handleGameStateTransition',
	'wireConnection',
	'claimLobbySettingsOwnership',
	'activeLobbySettings',
];
const methods = controller.members
	.filter((n) => names.includes(n.name?.getText(source)))
	.map((n) => n.getText(source).replace(/^private /, ''))
	.join('\n');
const emptyPrev = source.statements
	.find((n) => ts.isFunctionDeclaration(n) && n.name.text === 'emptyPrev')
	.getText(source);
const connectionSource = ts.createSourceFile(
	'ConnectionController.ts',
	await readFile('src/renderer/voice/ConnectionController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const connectionClass = connectionSource.statements.find((n) => ts.isClassDeclaration(n));
const sends = connectionClass.members
	.filter((n) => ['sendToPeers', 'broadcast'].includes(n.name?.getText(connectionSource)))
	.map((n) => n.getText(connectionSource))
	.join('\n');
let now = 10000;
const actors = [];
const packets = [];
function actor(clientId) {
	let state;
	const sandbox = {
		GameState,
		isToh4eHostName,
		isTohRole,
		defaultLobbySettings,
		OVERLAY_VOICE_KEYS: [],
		Date: { now: () => now },
		console,
		gameStore: { getSnapshot: () => ({ gameState: state }) },
		SettingsStore: { store: { myLobbySettings: { ...defaultLobbySettings, tohNeutralKillerHaunting: true } } },
	};
	const code = ts.transpileModule(
		`${emptyPrev}\nclass Controller { ${methods} }\nclass Connection { ${sends} }\n({ Controller, Connection, emptyPrev });`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2020 } }
	).outputText;
	const { Controller, Connection, emptyPrev: prev } = vm.runInNewContext(code, sandbox);
	const c = new Controller();
	c.snapshot = { toh4eLobby: false, tohRole: null, tohGameStartNames: {}, otherDead: {}, activeLobbySettings: null };
	c.prev = prev();
	c.host = { parsedHostId: 100, serverHostId: 100 };
	c.tohRoleOverride = null;
	c.tohRoleReceivedAt = 0;
	c.tohLobbyNames = {};
	c.connectionUnsubscribers = [];
	c.connection = new Connection();
	c.connection.peers = new Map();
	c.connection.playerSocketIds = {};
	c.connection.getClient = (peer) => ({ clientId: Number(peer) });
	const events = new EventEmitter();
	c.connection.on = (name, fn) => {
		events.on(name, fn);
		return () => events.off(name, fn);
	};
	c.connection.setContext = () => {};
	c.connection.setMobileRunning = () => {};
	c.connection.joinLobby = () => events.emit('lobbyReset');
	c.connection.leaveLobby = () => events.emit('lobbyReset');
	c.audio = { setMaxDistance() {}, removePeer() {} };
	c.emit = () => {};
	for (const name of [
		'unwireConnection',
		'handleHostChange',
		'handleLobbyConnection',
		'handlePlayerIdentity',
		'handlePublicLobby',
		'cleanupImpostorRadio',
		'updatePeerAudio',
		'publishMobileAndObs',
	])
		c[name] = () => {};
	c.wireConnection();
	const a = {
		c,
		events,
		clientId,
		setState(next) {
			state = next;
			c.onGameState(state);
		},
		get state() {
			return state;
		},
	};
	actors.push(a);
	return a;
}
const host = actor(100),
	clients = [actor(101), actor(102), actor(103)];
const roles = [true, false, true].map((isKiller, i) => ({
	roleId: 900 + i,
	roleName: ['Sheriff', 'Crewmate', 'Opportunist'][i],
	isKiller,
	isNeutralKiller: false,
}));
function game(a, phase = GameState.TASKS, code = 'ABCDEF', hostId = 100) {
	return {
		mod: a === host ? 'TOH4E' : 'NONE',
		lobbyCode: code,
		hostId,
		clientId: a.clientId,
		isHost: a.clientId === hostId,
		gameState: phase,
		lightRadius: 5,
		map: 0,
		players: actors.map((p, i) => ({
			id: i,
			clientId: p.clientId,
			isLocal: p === a,
			name: i === 0 ? 'ホスト\u00a0Town Of Host For E EM v6180.383' : `Player ${i}`,
			x: i,
			y: 0,
			...(a === host && i > 0 ? { tohRole: roles[i - 1] } : {}),
		})),
	};
}
for (const a of actors)
	for (const b of actors)
		if (a !== b) {
			a.c.connection.playerSocketIds[b.clientId] = String(b.clientId);
			a.c.connection.peers.set(String(b.clientId), {
				writable: false,
				send(payload) {
					const data = JSON.parse(payload);
					packets.push({ from: a.clientId, to: b.clientId, data });
					b.c.onPeerData(String(a.clientId), data);
				},
			});
		}
for (const a of actors) a.setState(game(a, GameState.LOBBY));
for (const a of clients) a.setState(game(a));
host.setState(game(host));
assert.equal(packets.length, 0, 'Closed data channels must not be recorded as successful sends');
for (const a of clients) assert.equal(a.c.snapshot.toh4eLobby, true, 'Vanilla client detects host suffix');
for (const a of actors) for (const channel of a.c.connection.peers.values()) channel.writable = true;
host.events.emit('peerReady', '101');
for (let i = 0; i < clients.length; i++) {
	assert.deepEqual(clients[i].c.snapshot.tohRole, roles[i], 'Each client receives only its own role');
	const effective = clients[i].c.getEffectiveGameState(clients[i].state);
	assert.equal(effective.mod, 'TOH4E');
	assert.deepEqual(
		effective.players.map((p) => p.name),
		['ホスト Town Of Host For E EM v6180.383', 'Player 1', 'Player 2', 'Player 3']
	);
	assert.equal(effective.players.filter((p) => p.tohRole).length, 1);
	const me = effective.players.find((p) => p.isLocal);
	const result = calculateVoiceAudio({
		state: { ...effective, closedDoors: [], currentCamera: 0 },
		me,
		other: { id: 9, x: me.x + 1, y: 0, isDead: true },
		settings: { spatialAudio: true, ghostVolumeAsImpostor: 40 },
		activeLobbySettings: { ...defaultLobbySettings, tohNeutralKillerHaunting: true },
		maxDistance: 5,
		impostorRadioClientId: -1,
	});
	assert.equal(result.gain, roles[i].isKiller ? 0.4 : 0, 'Host role drives vanilla client ghost audio');
}
assert.equal(packets.filter((p) => p.data.type === 'toh4e-role').length, 3);
assert.ok(packets.some((p) => p.data.type === 'toh4e-roster'));
for (const a of clients) {
	const changed = game(a);
	changed.players.forEach((p, i) => {
		p.name = `Changed ${i}`;
		p.appearanceName = `Changed appearance ${i}`;
	});
	a.setState(changed);
	const fixed = a.c.getEffectiveGameState(changed);
	assert.equal(fixed.players[2].name, 'Player 2', 'Host roster freezes names at game start');
	assert.equal(fixed.players[2].appearanceName, 'Player 2');
}
host.setState(game(host));
assert.equal(packets.filter((p) => p.data.type === 'toh4e-role').length, 3, 'Unchanged roles are throttled');

const first = clients[0];
const rolePacket = { type: 'toh4e-role', lobbyCode: 'ABCDEF', targetClientId: 101, targetPlayerId: 1, role: roles[1] };
first.c.onPeerData('102', rolePacket);
assert.equal(first.c.snapshot.tohRole.isKiller, true, 'Non-host role packet rejected even in detected TOH lobby');
first.c.onPeerData('100', { ...rolePacket, lobbyCode: 'OTHER' });
first.c.onPeerData('100', { ...rolePacket, targetPlayerId: 2 });
first.c.onPeerData('100', { ...rolePacket, role: { isKiller: true } });
assert.equal(first.c.snapshot.tohRole.isKiller, true, 'Wrong lobby/player and malformed packet rejected');
first.c.onPeerData('102', { type: 'toh4e-lobby', lobbyCode: 'ABCDEF', enabled: false });
assert.equal(first.c.snapshot.toh4eLobby, true);

const unavailable = game(host);
delete unavailable.players[1].tohRole;
host.setState(unavailable);
assert.equal(first.c.snapshot.tohRole, null, 'Read failure revokes previous role');
host.setState(game(host));
assert.equal(first.c.snapshot.tohRole.isKiller, true);
first.events.emit('peerClosed', '100');
assert.equal(first.c.snapshot.tohRole, null);
host.events.emit('peerReady', '101');
assert.equal(first.c.snapshot.tohRole.isKiller, true, 'Same socket reconnect resends unchanged role');
now += 6000;
first.setState(game(first));
assert.equal(first.c.snapshot.tohRole, null, 'Expired host role cannot keep enabling ghost audio');
host.setState(game(host));
assert.equal(first.c.snapshot.tohRole.isKiller, true, 'Periodic refresh recovers missed role');

first.setState(game(first, GameState.DISCUSSION));
host.setState(game(host, GameState.DISCUSSION));
assert.equal(first.c.snapshot.tohRole.isKiller, true);
first.setState(game(first, GameState.LOBBY));
assert.equal(first.c.snapshot.tohRole, null, 'Round end clears role');
assert.equal(first.c.snapshot.toh4eLobby, true, 'MOD detection survives round end');
first.setState(game(first, GameState.TASKS));
host.setState(game(host, GameState.LOBBY));
host.setState(game(host));
assert.equal(first.c.snapshot.tohRole.isKiller, true, 'Identical role in next round is resent');

const moved = game(first, GameState.LOBBY, 'ABCDEF', 102);
moved.players[0].name = 'Former host';
first.setState(moved);
assert.equal(first.c.snapshot.toh4eLobby, false, 'Host migration clears old detection');
first.c.onPeerData('100', rolePacket);
assert.equal(first.c.snapshot.tohRole, null, 'Former host no longer trusted');
first.setState({ ...moved, lobbyCode: 'NEXT', gameState: GameState.MENU });
assert.equal(first.c.snapshot.toh4eLobby, false);
for (const name of [
	'Name Town Of Host For E EM v6180.383',
	'Name\u00a0Town\u00a0Of Host For E v1',
	'<color=red>Town</color> Of Host For E EM',
	'Town\u200b Of Host For E',
])
	assert.equal(isToh4eHostName(name), true);
for (const name of ['Town Of Host', 'Town Of Host For Else', undefined]) assert.equal(isToh4eHostName(name), false);
console.log(
	'PASS TOH4E host + 3 clients: detection, channel readiness/reconnect, per-player role delivery, ghost audio, sender validation, role loss, timeout, rounds and host migration'
);
