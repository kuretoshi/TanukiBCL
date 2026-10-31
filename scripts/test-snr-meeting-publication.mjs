import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function extract(file, name) {
	const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
	let found;
	function visit(node) {
		if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(source) === name)
			found = node.getText(source);
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.ok(found, name);
	return found;
}
const signatureCode = ts.transpileModule(
	await extract('src/renderer/state/overlayBridge.ts', 'overlaySignature'),
	{}
).outputText;
const context = vm.createContext({});
vm.runInContext(signatureCode, context);
const state = {
	gameState: 2,
	mod: 'SUPER_NEW_ROLES',
	players: [],
	snrMeeting: { enabled: true, currentPage: 1, playerIds: [0, 1, 2] },
};
const first = context.overlaySignature(state);
state.snrMeeting.currentPage = 2;
assert.notEqual(first, context.overlaySignature(state), 'Page-only changes must reach the local overlay');
state.snrMeeting.currentPage = 1;
state.snrMeeting.playerIds.reverse();
assert.notEqual(first, context.overlaySignature(state), 'HUD order changes must reach the local overlay');

const method = await extract('src/renderer/voice/VoiceController.ts', 'publishMobileAndObs');
const sent = [];
const fixture = {
	prev: { obsPayload: '', obsSentAt: 0 },
	snapshot: { socketClients: {}, playerSocketIds: {}, otherTalking: {}, otherDead: {}, talking: false },
	obsSkinAssets: { setActive() {} },
	connection: {
		signalTo(secret, data) {
			sent.push(structuredClone(data));
		},
	},
};
const settings = { store: { obsSecret: '123456789', enableObsOverlay: true, obsOverlay: true } };
const code = ts.transpileModule(
	'class Fixture {' + method + '}\n globalThis.publish=Fixture.prototype.publishMobileAndObs;',
	{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
const runtime = vm.createContext({
	SettingsStore: settings,
	gameStore: { getSnapshot: () => ({ playerColors: [] }) },
	GameState: { UNKNOWN: 4, MENU: 3 },
	obsAppearance: () => ({}),
	nosColorHex: () => undefined,
	console,
});
vm.runInContext(code, runtime);
const publish = () => runtime.publish.call(fixture, state, undefined);
publish();
assert.equal(sent.length, 1, 'OBS payload must be published');
assert.equal(sent[0].snrMeeting.currentPage, 1);
publish();
assert.equal(sent.length, 1, 'Unchanged page retains payload deduplication');
state.snrMeeting.currentPage = 2;
publish();
assert.equal(sent.length, 2, 'Page-only changes must bypass unchanged-payload suppression immediately');
assert.equal(sent[1].snrMeeting.currentPage, 2);
state.snrMeeting = undefined;
publish();
assert.equal(sent.length, 3);
assert.equal(sent[2].snrMeeting, undefined);
console.log(
	'PASS SNR local overlay signature and actual OBS publisher: page/order changes, deduplication and stale-page clearing'
);
