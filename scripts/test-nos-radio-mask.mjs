import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';
import { build } from 'esbuild';

async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node' });
	return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
}
const nos = await bundle('src/common/NosSnapshot.ts');
const policy = await bundle('src/common/nosRadio.ts');
const impostor = await bundle('src/common/Impostor.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { defaultLobbySettings } = await bundle('src/renderer/voice/types.ts');
const radios = (mask, kind = nos.NOS_IMPOSTOR_RADIO_KIND) => [{ kind, hearableMask: mask, nameLength: 0, name: '' }];
assert.equal(nos.NOS_IMPOSTOR_RADIO_KIND, 0);
assert.equal(nos.NOS_JACKAL_RADIO_KIND, 1);
assert.equal(nos.canHearNosImpostorRadio(radios(1 << 2), 2), true);
assert.equal(nos.canHearNosImpostorRadio(radios(1 << 2), 5), false);
assert.equal(nos.canHearNosImpostorRadio(radios(1 << 31), 31), true);
for (const id of [-1, 32, 1.5]) assert.equal(nos.canHearNosImpostorRadio(radios(-1), id), false);
assert.equal(nos.canHearNosImpostorRadio(undefined, 2), false);
assert.equal(nos.canHearNosImpostorRadio(radios(0), 2), false);
assert.equal(nos.canHearNosImpostorRadio(radios(1 << 2, 1), 2), false);
assert.equal(nos.canHearNosJackalRadio(radios(1 << 2, 1), 2), true);

const source = ts.createSourceFile(
	'VoiceController.ts',
	await readFile('src/renderer/voice/VoiceController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const names = [
	'getEffectiveGameState',
	'getNosRadios',
	'senderNosRadioKind',
	'setImpostorRadio',
	'stopAllRadio',
	'applyImpostorRadio',
	'sendRadioStatus',
	'canNosJackalRadioReach',
	'canNosImpostorRadioReach',
	'canNosRadioReach',
	'canUseRadio',
	'areRadioPartners',
	'areRadioTeammates',
	'isJackalRadioPlayer',
	'getVisibleRadioClientIds',
	'onPeerData',
	'setRadioClientActive',
	'cleanupImpostorRadio',
];
const methods = [];
function visit(node) {
	if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.push(node.getText(source));
	ts.forEachChild(node, visit);
}
visit(source);
assert.equal(methods.length, names.length);
const controller = vm.runInNewContext(
	ts.transpileModule('({' + methods.join(',') + '})', { compilerOptions: { target: ts.ScriptTarget.ES2020 } })
		.outputText,
	{
		...nos,
		...policy,
		...impostor,
		radioOnAudio: { play: () => Promise.resolve() },
		GameState,
		gameStore: { getSnapshot: () => ({ gameState: state }) },
	}
);
controller.heldNosRadio = new policy.HeldNosRadio();
controller.nosRadioKinds = {};
controller.activeLobbySettings = { ...defaultLobbySettings, impostorRadioEnabled: true, jackalRadioEnabled: true };
const local = { id: 2, clientId: 20, isLocal: true, isImpostor: false, isDead: false, x: 0, y: 0 };
const remote = { id: 5, clientId: 50, isLocal: false, isImpostor: true, isDead: false, x: 50, y: 0 };
controller.snapshot = {
	nosRadiosByPlayer: { 5: { clientId: 50, radios: radios(1 << 2) } },
	impostorRadioClientIds: [20, 50],
};
const state = { mod: 'NoS', gameState: GameState.TASKS, players: [local, remote], nosRadios: radios(1 << 5) };
assert.equal(
	controller.canUseRadio(state, local),
	true,
	'available NoS channel grants transmission without a self bit or impostor role'
);
assert.equal(controller.canUseRadio(state, remote), true);
assert.equal(controller.canNosImpostorRadioReach(state, local, remote), true);
assert.equal(controller.canNosImpostorRadioReach(state, remote, local), true);
assert.equal(controller.areRadioPartners(state, local, remote), true);
assert.deepEqual([...controller.getVisibleRadioClientIds(state)], [20, 50]);
state.nosRadios = [];
assert.equal(controller.canUseRadio(state, local), false);
assert.equal(
	controller.areRadioPartners(state, local, remote),
	true,
	'reception uses the sender mask, never the local outgoing mask'
);
assert.deepEqual(
	[...controller.getVisibleRadioClientIds(state)],
	[50],
	'receiver without its own transmit channel can still see authorized remote radio'
);
controller.snapshot.nosRadiosByPlayer[5].radios = radios(1 << 5);
assert.equal(controller.areRadioPartners(state, local, remote), false, 'sender self bit does not authorize receiver');
assert.deepEqual([...controller.getVisibleRadioClientIds(state)], []);
local.isImpostor = true;
assert.equal(controller.canUseRadio(state, local), false, 'NoS role-only fallback is disabled');
delete controller.snapshot.nosRadiosByPlayer[5];
assert.equal(controller.canUseRadio(state, remote), false, 'missing channel report cannot grant transmission');
assert.equal(controller.areRadioPartners(state, local, remote), false, 'missing sender report cannot grant reception');
controller.host = { parsedHostId: 20 };
controller.connection = { getClient: () => ({ clientId: remote.clientId }) };
controller.radioStatusVersions = {};
controller.impostorRadioPressed = false;
controller.patch = (update) => {
	controller.snapshot = { ...controller.snapshot, ...update };
};
controller.snapshot.impostorRadioClientIds = [];
controller.onPeerData('remote', { impostorRadio: true, impostorRadioVersion: 1 });
assert.deepEqual(
	[...controller.snapshot.impostorRadioClientIds],
	[50],
	'radio status arriving before its mask must still suppress ordinary proximity audio'
);
controller.cleanupImpostorRadio(state, local);
assert.deepEqual(
	[...controller.snapshot.impostorRadioClientIds],
	[50],
	'mask expiry must not drop active transmission state and leak nearby audio'
);
controller.snapshot.nosRadiosByPlayer[5] = { clientId: 999, radios: radios(-1) };
assert.equal(
	controller.areRadioPartners(state, local, remote),
	false,
	'reused player ID cannot authorize a different client'
);
controller.snapshot.nosRadiosByPlayer[5] = { clientId: 50, radios: radios(1 << 2) };
controller.activeLobbySettings.impostorRadioEnabled = false;
assert.equal(controller.areRadioPartners(state, local, remote), false, 'disabled channel stays disabled');
controller.activeLobbySettings.impostorRadioOnlyMode = true;
assert.equal(
	controller.areRadioPartners(state, local, remote),
	true,
	'impostor-only mode enables the impostor channel'
);
controller.snapshot.nosRadiosByPlayer[5].radios = radios(1 << 2, 1);
assert.equal(controller.areRadioPartners(state, local, remote), false, 'impostor-only mode does not enable Jackal');

// Dual membership must never merge the two channel masks.
controller.activeLobbySettings = { ...defaultLobbySettings, impostorRadioEnabled: true, jackalRadioEnabled: true };
controller.snapshot.nosRadiosByPlayer[5].radios = [...radios(1 << 2, 0), ...radios(1 << 7, 1)];
assert.equal(controller.areRadioPartners(state, local, remote), false, 'legacy dual channel report is ambiguous');
controller.onPeerData('remote', { impostorRadio: true, impostorRadioVersion: 2, nosRadioKind: 1 });
assert.equal(
	controller.canNosImpostorRadioReach(state, remote, local),
	false,
	'Jackal transmission never uses impostor mask'
);
assert.equal(controller.areRadioPartners(state, local, remote), false);
controller.onPeerData('remote', { impostorRadio: true, impostorRadioVersion: 3, nosRadioKind: 0 });
assert.equal(controller.areRadioPartners(state, local, remote), true);
assert.equal(controller.canNosJackalRadioReach(state, remote, local), false);
controller.onPeerData('remote', { impostorRadio: true, impostorRadioVersion: 999, nosRadioKind: 2 });
assert.equal(controller.radioStatusVersions[50], 3, 'invalid kind does not poison version');
controller.onPeerData('remote', { impostorRadio: true, impostorRadioVersion: 2, nosRadioKind: 1 });
assert.equal(controller.nosRadioKinds[50], 0, 'stale packet cannot change channel');
const packets = [];
controller.connection.playerSocketIds = { 50: 'remote' };
controller.connection.sendControlToPeers = (_targets, payload) => packets.push(JSON.parse(payload));
state.nosRadios = [...radios(0, 0), ...radios(0, 1)];
controller.radioStatusVersion = 0;
controller.setImpostorRadio(true, 0);
controller.setImpostorRadio(true, 1);
controller.setImpostorRadio(true, 0); // Key repeat must not steal priority.
assert.equal(controller.heldNosRadio.kind, 1);
controller.setImpostorRadio(false, 1);
assert.equal(controller.heldNosRadio.kind, 0);
controller.setImpostorRadio(false, 0);
assert.deepEqual(
	packets.map((packet) => [packet.impostorRadio, packet.nosRadioKind]),
	[
		[true, 0],
		[true, 1],
		[true, 0],
		[false, undefined],
	]
);
controller.setImpostorRadio(true, 1);
controller.activeLobbySettings.jackalRadioEnabled = false;
controller.cleanupImpostorRadio(state, local);
assert.equal(
	controller.impostorRadioPressed,
	false,
	'disabled selected channel stops instead of switching to impostor'
);
assert.equal(controller.heldNosRadio.kind, undefined);
controller.activeLobbySettings.jackalRadioEnabled = true;
controller.setImpostorRadio(true, 0);
local.isDead = true;
controller.cleanupImpostorRadio(state, local);
assert.equal(controller.heldNosRadio.kind, undefined, 'death releases both channel keys');
local.isDead = false;
controller.setImpostorRadio(true, 1);
state.mod = 'NONE';
controller.cleanupImpostorRadio(state, local);
assert.equal(controller.impostorRadioPressed, false, 'changing mod clears the held NoS channel');
state.mod = 'NoS';

const choices = {
	senderX: [1, 50],
	gameState: [GameState.TASKS, GameState.DISCUSSION],
	dead: [false, true],
	listenerImpostor: [false, true],
	senderImpostor: [false, true],
	hearable: [false, true],
	onlyMode: [false, true],
};
const audioScenarios = Object.entries(choices).reduce(
	(scenarios, [key, values]) => scenarios.flatMap((scenario) => values.map((value) => ({ ...scenario, [key]: value }))),
	[{}]
);
assert.equal(audioScenarios.length, 128);
audioScenarios.forEach(({ senderX, gameState, dead, listenerImpostor, senderImpostor, hearable, onlyMode }) => {
	const result = calculateVoiceAudio({
		state: { ...state, gameState, map: 0, currentCamera: -1, closedDoors: [] },
		settings: { ghostVolumeAsImpostor: 100 },
		activeLobbySettings: {
			...defaultLobbySettings,
			impostorRadioEnabled: true,
			impostorRadioOnlyMode: onlyMode,
		},
		me: { ...local, isDead: dead, isImpostor: listenerImpostor },
		other: { ...remote, isImpostor: senderImpostor, x: senderX },
		maxDistance: 5.32,
		impostorRadioClientId: 50,
		nosImpostorRadioHearable: hearable,
	});
	assert.equal(
		result.gain,
		hearable ? 1 : 0,
		`phase=${gameState} dead=${dead} listenerImp=${listenerImpostor} senderImp=${senderImpostor} bit=${hearable} only=${onlyMode}`
	);
	assert.equal(result.radioEcho, hearable);
});
const audioCases = audioScenarios.length;
console.log(
	`PASS NoS radio masks: sender-owned direction, self bit absent, missing/stale reports, channel settings, receiver-only UI, bit 31 and ${audioCases} audio cases`
);
