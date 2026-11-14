import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

async function bundle(entry) {
	const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const lite = process.argv.includes('--lite');
if (lite) process.env.BETTERCREWLINK_LITE = '1';
const { isLiteRuntime } = await bundle('src/common/appVariant.ts');
if (lite) assert.equal(isLiteRuntime(), true, 'Lite verification must select the Lite runtime');

const { GameState } = await bundle('src/common/AmongUsState.ts');
const { nosColorHex } = await bundle('src/common/NosSnapshot.ts');
const { DEFAULT_PLAYERCOLORS } = await bundle('src/common/playerColors.ts');
const { obsAppearance } = await bundle('src/renderer/voice/ObsSkinAssets.ts');
const source = ts.createSourceFile(
	'VoiceController.ts',
	await readFile('src/renderer/voice/VoiceController.ts', 'utf8'),
	ts.ScriptTarget.Latest,
	true
);
const controller = source.statements.find(
	(node) => ts.isClassDeclaration(node) && node.name.text === 'VoiceController'
);
const publisher = controller.members.find((node) => node.name?.getText(source) === 'publishMobileAndObs');
const settings = { obsOverlay: true, obsSecret: 'OBSSECRET' };
let playerColors = DEFAULT_PLAYERCOLORS;
const publishMobileAndObs = vm.runInNewContext(
	ts.transpileModule(`({ ${publisher.getText(source)} })`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022 },
	}).outputText,
	{
		GameState,
		nosColorHex,
		DEFAULT_PLAYERCOLORS,
		obsAppearance,
		SettingsStore: {
			get store() {
				return settings;
			},
		},
		gameStore: { getSnapshot: () => ({ playerColors }) },
	}
).publishMobileAndObs;

const signals = [];
const subject = {
	prev: { obsPayload: '' },
	obsSkinAssets: { setActive() {} },
	snapshot: { socketClients: {}, playerSocketIds: {}, otherTalking: {}, otherDead: {}, talking: false },
	connection: { isMobileRunning: false, signalTo: (target, data) => signals.push({ target, data }) },
	getEffectiveGameState: (state) => state,
	getVisibleRadioClientIds: () => [],
};
const player = {
	id: 0,
	clientId: 100,
	name: 'Local',
	isLocal: true,
	colorId: 1,
	hatId: '',
	skinId: '',
	visorId: '',
	appearanceHatId: '',
	appearanceSkinId: '',
	appearanceVisorId: '',
	currentOutfit: 0,
	petId: 0,
	inVent: false,
	isDead: false,
	disconnected: false,
	bugged: false,
	shiftedColor: -1,
};
function publish(players, gameState = GameState.LOBBY, mod = 'NoS', oldGameState = GameState.TASKS) {
	const state = { players, gameState, oldGameState, mod, oldMeetingHud: false, lobbyCode: 'ABCDEF' };
	publishMobileAndObs.call(
		subject,
		state,
		players?.find((value) => value.isLocal)
	);
	return signals.at(-1)?.data;
}
function assertPalette(frame, expected) {
	// Check the serialized payload: OBS indexes both colors while rendering each avatar.
	const received = JSON.parse(JSON.stringify(frame));
	for (const value of received.overlayState.players) {
		assert.equal(value.realColor?.length, 2, 'OBS needs a body and shadow color even while NoS data resets');
		assert.ok(value.realColor.every((color) => /^#[a-f\d]{6}$/i.test(color)));
	}
	if (expected) assert.deepEqual(received.overlayState.players[0].realColor, expected);
	return received;
}

assertPalette(publish([player]), DEFAULT_PLAYERCOLORS[1]);
assert.equal(signals.at(-1).target, settings.obsSecret);

// A live NoS round loses its published snapshot before the lobby palette is available.
const livePlayer = { ...player, nosPlayer: { colorR: 0.2, colorG: 0.8, colorB: 0.4 } };
let frame = assertPalette(publish([livePlayer], GameState.TASKS), DEFAULT_PLAYERCOLORS[1]);
assert.equal(frame.overlayState.players[0].nosColor, '#33cc66');
frame = assertPalette(publish([player], GameState.LOBBY), DEFAULT_PLAYERCOLORS[1]);
assert.equal(frame.overlayState.gameState, GameState.LOBBY);
frame = assertPalette(publish([{ ...player, nosLobbyColor: '#50ef39' }]), DEFAULT_PLAYERCOLORS[1]);
assert.equal(frame.overlayState.players[0].nosColor, '#50ef39');
frame = assertPalette(publish([livePlayer], GameState.TASKS), DEFAULT_PLAYERCOLORS[1]);
assert.equal(frame.overlayState.players[0].nosColor, '#33cc66', 'the next match receives the new NoS color');

for (const mod of ['NoS', 'NONE', 'SUPER_NEW_ROLES', 'TOH4E']) {
	frame = assertPalette(publish([{ ...player, colorId: -1 }], GameState.LOBBY, mod), DEFAULT_PLAYERCOLORS[0]);
	assertPalette(publish([{ ...player, colorId: 999 }], GameState.TASKS, mod), DEFAULT_PLAYERCOLORS[0]);
	assertPalette(publish([{ ...player, colorId: undefined }], GameState.DISCUSSION, mod), DEFAULT_PLAYERCOLORS[0]);
	if (mod !== 'NoS') assert.equal(frame.overlayState.players[0].nosColor, undefined);
}

playerColors = [['#123456', '#102030']];
assertPalette(publish([{ ...player, colorId: 0 }], GameState.LOBBY, 'NONE'), playerColors[0]);
playerColors = [];
assertPalette(publish([player], GameState.LOBBY, 'NONE'), DEFAULT_PLAYERCOLORS[0]);

const count = signals.length;
publish([player], GameState.LOBBY, 'NONE');
assert.equal(signals.length, count, 'unchanged frames remain deduplicated');
settings.obsOverlay = false;
publish([livePlayer], GameState.TASKS);
assert.equal(signals.length, count, 'disabled OBS does not send frames');
settings.obsOverlay = true;
settings.obsSecret = 'short';
publish([livePlayer], GameState.TASKS);
assert.equal(signals.length, count, 'invalid OBS secrets do not send frames');
settings.obsSecret = 'OBSSECRET';
publish(undefined);
assert.equal(signals.length, count, 'unavailable player lists do not send frames');
frame = publish([], GameState.MENU, 'NONE', GameState.TASKS);
assert.equal(frame.overlayState.gameState, GameState.MENU, 'leaving the game still clears OBS');

console.log(
	`PASS OBS${lite ? ' Lite' : ''}: NoS match/lobby/next match, missing colors, mod palettes, deduplication and settings`
);
