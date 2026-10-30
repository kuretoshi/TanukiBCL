import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

const file = 'src/renderer/voice/VoiceController.ts';
const source = await readFile(process.env.TANUKI_VERSION_WARNING_BASELINE ?? file, 'utf8');
const gitMarker = resolve('.git');
const gitDirectory = (await stat(gitMarker)).isDirectory()
	? gitMarker
	: resolve((await readFile(gitMarker, 'utf8')).trim().replace(/^gitdir:\s*/, ''));
const baseline = execFileSync('git', [`--git-dir=${gitDirectory}`, 'show', `HEAD:${file}`], { encoding: 'utf8' });
const bundled = await build({
	entryPoints: ['src/common/appVersion.ts'],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
});
const versions = await import(
	'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].contents).toString('base64')
);

function extract(text) {
	const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const controller = parsed.statements.find(
		(node) => ts.isClassDeclaration(node) && node.name.text === 'VoiceController'
	);
	const names = ['updateVersionWarning', 'patch', 'teardown'];
	const methods = controller.members.filter((node) => names.includes(node.name?.getText(parsed)));
	assert.equal(methods.length, names.length);
	const factories = parsed.statements.filter(
		(node) => ts.isFunctionDeclaration(node) && ['emptyPrev', 'emptyHost'].includes(node.name?.text)
	);
	assert.equal(factories.length, 2);
	const snapshot = parsed.statements.find(
		(node) =>
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'EMPTY_SNAPSHOT')
	);
	assert.ok(snapshot);
	let reset;
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(parsed) === 'this.connection.on' &&
			node.arguments[0]?.text === 'lobbyReset'
		)
			reset = node.arguments[1].getText(parsed);
		ts.forEachChild(node, visit);
	}
	visit(controller);
	assert.ok(reset, 'exercise the actual lobby-reset callback');
	return ts.transpileModule(
		`${snapshot.getText(parsed)}\n${factories.map((node) => node.getText(parsed)).join('\n')}\nclass Controller { ${methods.map((node) => node.getText(parsed)).join('\n')}\nlobbyReset() { (${reset})(); } }\n({ Controller, emptyPrev, emptyHost, EMPTY_SNAPSHOT });`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }
	).outputText;
}

function actor(text) {
	const state = {
		players: Array.from({ length: 15 }, (_, index) => ({
			clientId: index + 1,
			name: `Player ${index + 1}`,
			disconnected: false,
		})),
	};
	const clients = new Map(state.players.slice(1).map((player) => [`peer${player.clientId}`, player.clientId]));
	const count = { required: 0, mismatches: 0 };
	const derived = vm.runInNewContext(extract(text), {
		gameStore: { getSnapshot: () => ({ gameState: state }) },
		packageJson: { version: '3.2.10' },
		requiredAppVersion: (...args) => {
			count.required++;
			return versions.requiredAppVersion(...args);
		},
		mismatchedAppVersions: (...args) => {
			count.mismatches++;
			return versions.mismatchedAppVersions(...args);
		},
		OVERLAY_VOICE_KEYS: [],
		GameState: { UNKNOWN: -1 },
		MapType: { UNKNOWN: -1 },
	});
	const controller = new derived.Controller();
	controller.prev = derived.emptyPrev();
	controller.snapshot = { ...derived.EMPTY_SNAPSHOT };
	controller.host = { ...derived.emptyHost(), isHost: true, parsedHostId: 1 };
	controller.peerVersions = Object.fromEntries(
		[...clients.keys()].map((peerId) => [peerId, peerId === 'peer2' ? '3.2.11' : '3.2.10'])
	);
	controller.connection = {
		getClient: (peerId) => (clients.has(peerId) ? { clientId: clients.get(peerId) } : undefined),
		stop() {},
	};
	controller.audio = { stop() {}, setLocalRadioPending() {} };
	controller.mobileCosmetics = { reset() {} };
	controller.obsSkinAssets = { reset() {} };
	controller.heldNosRadio = { clear() {} };
	controller.unsubscribers = [];
	controller.disableRemoteVoice = () => {};
	controller.unwireConnection = () => {};
	controller.unwireAudio = () => {};
	controller.emit = () => {};
	return { controller, state, clients, count };
}

const current = actor(source);
const reference = actor(baseline);
function update(label) {
	current.controller.updateVersionWarning();
	reference.controller.updateVersionWarning();
	assert.equal(
		current.controller.snapshot.versionWarning,
		reference.controller.snapshot.versionWarning,
		`${label}: exact existing warning text is retained`
	);
	return current.controller.snapshot.versionWarning;
}
function mutate(callback, label) {
	callback(current);
	callback(reference);
	return update(label);
}

for (let index = 0; index < 100; index++) update(`unchanged tick ${index}`);
assert.equal(current.count.required, 1, '100 unchanged updates derive required version once');
assert.equal(current.count.mismatches, 1, '100 unchanged updates derive mismatched versions once');
assert.match(current.controller.snapshot.versionWarning, /Player 2（v3\.2\.11）/);
assert.match(current.controller.snapshot.versionWarning, /参加者はv3\.2\.11/);

assert.match(
	mutate(({ state }) => {
		state.players[1].name = 'Renamed | "Host"';
	}, 'rename'),
	/Renamed \| "Host"/
);
assert.equal(
	mutate(({ state }) => {
		state.players[1].disconnected = true;
	}, 'disconnect'),
	''
);
assert.match(
	mutate(({ state }) => {
		state.players[1].disconnected = false;
	}, 'reconnect'),
	/Renamed/
);
assert.equal(
	mutate(({ controller }) => {
		delete controller.peerVersions.peer2;
	}, 'version report removed'),
	''
);
assert.match(
	mutate(({ controller }) => {
		controller.peerVersions.peer2 = '3.2.9';
	}, 'new older version report'),
	/v3\.2\.9/
);
assert.equal(
	mutate(({ controller }) => {
		controller.peerVersions.peer2 = '3.2.10';
	}, 'same version report'),
	''
);
assert.match(
	mutate(({ controller }) => {
		controller.peerVersions.peer2 = '3.3.0';
	}, 'newer version report'),
	/参加者はv3\.3\.0/
);
assert.match(
	mutate(({ controller }) => {
		controller.host.isHost = false;
		controller.host.parsedHostId = 2;
	}, 'become guest'),
	/ホストはv3\.3\.0/
);
const migrated = mutate(({ controller }) => {
	controller.host.parsedHostId = 3;
}, 'host migration');
assert.ok(!migrated.includes('アップデートしてください'), 'same-version host does not force guest to update');
assert.match(migrated, /v3\.3\.0/);
assert.ok(
	!mutate(({ clients }) => {
		clients.delete('peer2');
	}, 'transport disconnected').includes('v3.3.0')
);
assert.match(
	mutate(({ clients }) => {
		clients.set('peer2', 2);
	}, 'transport reconnected'),
	/v3\.3\.0/
);
assert.ok(
	!mutate(({ controller }) => {
		controller.peerVersions.peer2 = 'malformed';
	}, 'malformed version').includes('malformed')
);
mutate(({ controller }) => {
	controller.peerVersions.peer2 = '3.3.0';
	controller.host.parsedHostId = 2;
}, 'restore mismatch');

// A reset can be followed by identical reports before the next game update.
const beforeReset = current.count.required;
const warning = current.controller.snapshot.versionWarning;
for (const subject of [current, reference]) {
	const reports = { ...subject.controller.peerVersions };
	subject.controller.lobbyReset();
	assert.equal(subject.controller.snapshot.versionWarning, '');
	subject.controller.peerVersions = reports;
}
assert.equal(update('same reports immediately after lobby reset'), warning);
assert.equal(current.count.required, beforeReset + 1, 'lobby reset invalidates the input signature');

const beforeTeardown = current.count.required;
for (const subject of [current, reference]) {
	const reports = { ...subject.controller.peerVersions };
	const host = { ...subject.controller.host };
	subject.controller.snapshot.error = 'preserved startup error';
	subject.controller.teardown(true);
	assert.equal(subject.controller.snapshot.versionWarning, '');
	assert.equal(subject.controller.snapshot.error, 'preserved startup error');
	subject.controller.peerVersions = reports;
	subject.controller.host = host;
}
assert.equal(update('same reports after teardown/restart'), warning);
assert.equal(current.count.required, beforeTeardown + 1, 'teardown/restart cannot suppress an identical warning');
update('unchanged warning after restart');
assert.equal(current.count.required, beforeTeardown + 1);

console.log(
	'PASS version warnings: 100 unchanged updates -> 1 derivation; exact HEAD warning parity across rename, transport/player disconnect/reconnect, report changes, host migration, lobby reset and teardown/restart'
);
