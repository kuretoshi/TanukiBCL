import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';

const sourcePath = resolve('src/renderer/voice/spatialAudio.ts');
const baseline = process.env.TANUKI_ROKURO_POSITION_BASELINE;
const result = await build({
	stdin: {
		contents: `
export { calculateVoiceAudio } from './src/renderer/voice/spatialAudio';
export { defaultLobbySettings } from './src/common/defaultLobbySettings';
export { GameState } from './src/common/AmongUsState';
export { MapType, CameraLocation } from './src/common/AmongusMap';
export { poseCollide } from './src/common/ColliderMap';`,
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	plugins: baseline
		? [
				{
					name: 'baseline-spatial',
					setup(builder) {
						builder.onLoad({ filter: /[\\/]spatialAudio\.ts$/ }, async () => ({
							contents: await readFile(baseline, 'utf8'),
							loader: 'ts',
							resolveDir: dirname(sourcePath),
						}));
					},
				},
			]
		: [],
});
const { calculateVoiceAudio, defaultLobbySettings, GameState, MapType, CameraLocation, poseCollide } = await import(
	'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64')
);

const game = {
	mod: 'NoS',
	gameState: GameState.TASKS,
	map: MapType.UNKNOWN,
	currentCamera: CameraLocation.NONE,
	closedDoors: [],
};
const listener = { id: 0, clientId: 100, isLocal: true, x: 0, y: 0, isDead: false, isImpostor: false };
const speaker = { id: 1, clientId: 101, isLocal: false, x: 1, y: 0, isDead: false, isImpostor: false };
const role = { roleId: 1, roleName: 'rokurokubi', displayName: null, runtimeClass: 'Rokurokubi+Instance' };
const run = (overrides = {}) =>
	calculateVoiceAudio({
		state: game,
		me: listener,
		other: speaker,
		settings: { enableSpatialAudio: true, ghostVolumeAsImpostor: 40 },
		activeLobbySettings: defaultLobbySettings,
		maxDistance: 5,
		impostorRadioClientId: -1,
		...overrides,
	});
let checks = 0;
function equal(actual, expected, description) {
	assert.deepEqual(actual, expected, description);
	checks++;
}

// Official TBCLFields.GetLocalMicPosition follows CurrentCamTarget; Rokurokubi.LongNeckMode
// sets that target to HeadTracker. FixSpeakerPositionEvent publishes the remote head.
// Source: Dolly1016/Nebula-Public, NebulaPluginNova/Collab/TBCLFields.cs and Roles/Impostor/Rokurokubi.cs.
const extendedListener = { ...listener, nosRole: role };
const neckGame = { ...game, nosLocalMicPosition: { x: 20, y: 0 } };
const nearHead = { ...speaker, x: 21 };
equal(
	run({ state: neckGame, me: extendedListener, other: nearHead }).gain,
	1,
	'Rokuro hears near its current camera/head even with the general NoS position option off'
);
equal(
	run({ state: neckGame, me: extendedListener, other: nearHead }).panPosition,
	[1, 0],
	'local head position drives directional pan'
);
equal(
	run({ state: neckGame, me: extendedListener }).gain,
	0,
	'an extended listener no longer hears a player left near the body'
);
equal(
	run({ state: { ...neckGame, nosLocalMicPosition: { x: 0, y: 0 } }, me: extendedListener }).panPosition,
	[1, 0],
	'retraction follows the next published microphone position without a cached offset'
);
equal(
	run({ state: { ...neckGame, nosLocalMicPosition: { x: 18, y: -2 } }, me: extendedListener, other: nearHead })
		.panPosition,
	[3, 2],
	'neck angle changes use both published axes'
);

const extendedSpeaker = {
	...speaker,
	x: 40,
	nosRole: role,
	nosPlayer: { speakerPositionX: 2, speakerPositionY: 1 },
};
equal(
	run({ other: extendedSpeaker }).panPosition,
	[2, 1],
	'a remote Rokuro speaks from the published head with optional body fields absent'
);
equal(
	run({ other: { ...extendedSpeaker, nosPlayer: { speakerPositionX: 30, speakerPositionY: 0 } } }).gain,
	0,
	'remote head distance is enforced'
);
equal(
	run({ other: { ...extendedSpeaker, x: 1, nosPlayer: { speakerPositionX: 1, speakerPositionY: 0 } } }).panPosition,
	[1, 0],
	'remote retraction uses the new publication'
);
equal(
	run({
		state: neckGame,
		me: extendedListener,
		other: { ...extendedSpeaker, nosPlayer: { speakerPositionX: 21, speakerPositionY: -1 } },
	}).panPosition,
	[1, -1],
	'local and remote Rokuro endpoints are independent'
);
equal(
	run({ state: neckGame, me: { ...listener, nosPlayer: { bodyType: 3 } }, other: nearHead }).gain,
	1,
	'published long-body state works while managed role metadata is unavailable'
);
equal(
	run({
		other: {
			...extendedSpeaker,
			nosRole: undefined,
			nosPlayer: {
				bodyType: 3,
				speakerPositionX: 2,
				speakerPositionY: 0,
			},
		},
	}).panPosition,
	[2, 0],
	'long-body remote fallback follows the head'
);

equal(
	run({ state: neckGame, other: nearHead }).gain,
	0,
	'ordinary local players retain body positions when the general option is off'
);
equal(
	run({ other: { ...extendedSpeaker, nosRole: undefined } }).gain,
	0,
	'ordinary remote players retain body positions when the general option is off'
);
equal(
	run({ state: neckGame, other: nearHead, activeLobbySettings: { ...defaultLobbySettings, nosVoicePositions: true } })
		.gain,
	1,
	'the existing all-NoS position option still applies to ordinary players'
);
equal(
	run({
		other: { ...extendedSpeaker, nosRole: undefined },
		activeLobbySettings: { ...defaultLobbySettings, nosVoicePositions: true },
	}).panPosition,
	[2, 1],
	'the all-NoS option still applies to remote speaker positions'
);
for (const mod of ['NONE', 'SUPER_NEW_ROLES', 'TOH4E']) {
	equal(
		run({ state: { ...neckGame, mod }, me: extendedListener, other: nearHead }).gain,
		0,
		`NoS metadata does not change ${mod} local positioning`
	);
	equal(
		run({ state: { ...game, mod }, other: extendedSpeaker }).gain,
		0,
		`NoS metadata does not change ${mod} remote positioning`
	);
}
for (const value of [undefined, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
	equal(
		run({ state: { ...game, nosLocalMicPosition: value }, me: extendedListener }).panPosition,
		[1, 0],
		'missing or nonfinite local coordinates fall back to the body'
	);
}
for (const value of [
	undefined,
	{ speakerPositionX: NaN, speakerPositionY: 0 },
	{ speakerPositionX: 0, speakerPositionY: Infinity },
]) {
	equal(
		run({ other: { ...speaker, nosRole: role, nosPlayer: value } }).panPosition,
		[1, 0],
		'missing or nonfinite remote coordinates fall back to the body'
	);
}
equal(
	run({ state: neckGame, me: { ...extendedListener, isDead: true } }).panPosition,
	[1, 0],
	'a dead Rokuro does not retain the living neck listener override'
);
equal(
	run({
		other: { ...speaker, nosRole: role, isDead: true, nosPlayer: { speakerPositionX: 40, speakerPositionY: 0 } },
		me: { ...listener, isDead: true },
	}).panPosition,
	[1, 0],
	'a dead remote Rokuro returns to ordinary ghost positioning'
);
equal(run({ other: { ...extendedSpeaker, disconnected: true } }).gain, 0, 'disconnect still blocks speech');
equal(run({ other: { ...extendedSpeaker, isDummy: true } }).gain, 0, 'dummy voice remains blocked');
equal(
	run({ state: { ...neckGame, gameState: GameState.DISCUSSION }, me: extendedListener, other: extendedSpeaker })
		.panPosition,
	[0, 0],
	'meeting voice stays centered'
);
for (const gameState of [GameState.MENU, GameState.UNKNOWN]) {
	equal(
		run({ state: { ...neckGame, gameState }, me: extendedListener, other: extendedSpeaker }).gain,
		0,
		'out-of-game speech stays blocked'
	);
}
for (const policy of [{ deadOnly: true }, { meetingGhostOnly: true }, { impostorRadioOnlyMode: true }]) {
	equal(
		run({
			state: neckGame,
			me: extendedListener,
			other: nearHead,
			activeLobbySettings: { ...defaultLobbySettings, ...policy },
		}).gain,
		0,
		'head positioning does not bypass lobby speech restrictions'
	);
}
equal(
	run({
		state: { ...neckGame, comsSabotaged: true },
		me: extendedListener,
		other: nearHead,
		activeLobbySettings: { ...defaultLobbySettings, commsSabotage: true },
	}).gain,
	0,
	'head positioning does not bypass communications sabotage'
);
equal(
	run({ state: neckGame, me: extendedListener, other: nearHead, settings: { enableSpatialAudio: false } }).panPosition,
	[0, 0],
	'disabling directional audio still centers the audible head'
);
equal(
	run({ state: neckGame, me: extendedListener, other: nearHead, settings: { enableSpatialAudio: false } }).gain,
	1,
	'directional-audio preference does not undo head hearing distance'
);

// Real Skeld storage/admin door geometry: the moved endpoint must reach the wall checker.
const behindDoor = { x: 0, y: -9 };
const acrossDoor = { ...speaker, x: 0, y: -7.5 };
equal(
	poseCollide({ ...behindDoor }, { x: 0, y: -7.5 }, MapType.THE_SKELD, []),
	false,
	'fixture endpoints have no permanent wall between them'
);
equal(
	poseCollide({ ...behindDoor }, { x: 0, y: -7.5 }, MapType.THE_SKELD, [7]),
	true,
	'fixture crosses the real closed Skeld storage/admin door'
);
const doorGame = { ...game, map: MapType.THE_SKELD, closedDoors: [7], nosLocalMicPosition: behindDoor };
const atDoor = { ...extendedListener, x: 0, y: -7.5 };
equal(
	run({
		state: doorGame,
		me: atDoor,
		other: acrossDoor,
		activeLobbySettings: { ...defaultLobbySettings, wallsBlockAudio: true },
	}).gain,
	0,
	'wall blocking uses the moved microphone endpoint, not the body across the door'
);
equal(
	run({
		state: { ...doorGame, closedDoors: [] },
		me: atDoor,
		other: acrossDoor,
		activeLobbySettings: { ...defaultLobbySettings, wallsBlockAudio: true },
	}).gain,
	1,
	'opening the door restores nearby head hearing'
);
equal(
	run({ state: doorGame, me: atDoor, other: acrossDoor }).gain,
	1,
	'wall settings remain respected rather than changed by the role'
);
const source = { ...extendedSpeaker, x: 0, y: -7.5, nosPlayer: { speakerPositionX: 0, speakerPositionY: -9 } };
equal(
	run({
		state: { ...doorGame, nosLocalMicPosition: undefined },
		me: { ...listener, x: 0, y: -7.5 },
		other: source,
		activeLobbySettings: { ...defaultLobbySettings, wallsBlockAudio: true },
	}).gain,
	0,
	'wall blocking also uses the remote head endpoint'
);

const untouched = { state: neckGame, me: extendedListener, other: extendedSpeaker };
const before = JSON.stringify(untouched);
run(untouched);
equal(JSON.stringify(untouched), before, 'position substitution never mutates input snapshots');
console.log(
	`PASS NoS Rokuro position: ${checks} actual-module checks covering head/retraction, legacy metadata, gates, real doors, fallback and unchanged ordinary players`
);
