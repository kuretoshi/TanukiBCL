import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cache = resolve('.cache/toh-ghost-role-tests');
await mkdir(cache, { recursive: true });
async function bundle(entry) {
	const file = resolve(
		cache,
		entry
			.split('/')
			.at(-1)
			.replace(/\.tsx?$/, '.mjs')
	);
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		packages: 'external',
		platform: 'node',
		format: 'esm',
		write: false,
	});
	await writeFile(file, result.outputFiles[0].contents);
	return import(pathToFileURL(file));
}
const { tohGhostRoleGroups, setTohGhostRole, canTohHearGhosts } = await bundle('src/common/TohGhostRoles.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { isPlayerImpostor, withImpostorClassification } = await bundle('src/common/Impostor.ts');
const { default: RoleSettings } = await bundle('src/renderer/settings/sections/TohGhostRoleSettings.tsx');
const names = tohGhostRoleGroups.flatMap((g) => g.roles.map(([name]) => name));
assert.equal(new Set(names).size, 22);
assert.ok(!names.includes('Impostor'));
const role = (name) => ({ roleId: 123, roleName: name, isKiller: true, isNeutralKiller: null });
for (const name of [...names, 'Sheriff', 'MadSheriff', 'Unknown', 'NotAssigned']) {
	assert.equal(isPlayerImpostor('TOH4E', { isImpostor: true, tohRole: role(name) }), false, name);
}
for (const vanilla of [false, true]) {
	const player = { isImpostor: vanilla, tohRole: role('Vampire') };
	assert.equal(isPlayerImpostor('TOH4E', player), vanilla);
	assert.equal(withImpostorClassification('TOH4E', withImpostorClassification('TOH4E', player)).isImpostor, vanilla);
}
for (const mod of ['NONE', 'SUPER_NEW_ROLES', 'NoS']) {
	const player = { isImpostor: true, tohRole: role('Jackal') };
	assert.equal(isPlayerImpostor(mod, player), true);
	assert.equal(withImpostorClassification(mod, player), player, `${mod} is unchanged`);
}
assert.equal(isPlayerImpostor('TOH4E', { isImpostor: true }), false);
assert.equal(isPlayerImpostor('TOH4E', { isImpostor: false, tohImpostor: true }), false);
const base = { ...defaultLobbySettings, haunting: true, tohNeutralKillerHaunting: true };
const changed = { ...base, ...setTohGhostRole(base, 'Jackal', false) };
assert.equal(changed.tohGhostRoles.Jackal, false);
assert.equal(changed.tohGhostRoles.Coyote, true, 'First edit keeps other legacy toggles');
assert.equal(changed.haunting, true, 'Existing impostor setting is independent');
assert.equal(base.tohGhostRoles, undefined, 'Editing does not mutate defaults');
assert.equal(canTohHearGhosts(changed, role('Jackal')), false);
assert.equal(canTohHearGhosts(changed, role('Coyote')), true);
assert.equal(canTohHearGhosts(changed, role('Sheriff')), false);
assert.equal(canTohHearGhosts(changed, role('MadSheriff')), false);
assert.equal(canTohHearGhosts(changed, role('Unknown')), false);
assert.equal(canTohHearGhosts(changed, undefined), false);
assert.equal(canTohHearGhosts(changed, { ...role('Coyote'), isKiller: null }), false);
assert.equal(canTohHearGhosts(changed, role('Vampire'), true), true);
assert.equal(canTohHearGhosts({ ...changed, haunting: false }, role('Vampire'), true), false);
assert.equal(canTohHearGhosts(changed, role('Vampire'), false), false);
assert.equal(canTohHearGhosts(base, role('Jackal')), true, 'Older host settings remain supported');

function ghostGain(name, lobby, extras = {}) {
	const me = { id: 1, x: 0, y: 0, isDead: false, isImpostor: true, tohRole: role(name), ...extras };
	return calculateVoiceAudio({
		state: { mod: 'TOH4E', gameState: GameState.TASKS, map: 0, closedDoors: [], currentCamera: 0 },
		me,
		other: { id: 2, x: 1, y: 0, isDead: true },
		settings: { spatialAudio: true, ghostVolumeAsImpostor: 40 },
		activeLobbySettings: lobby,
		maxDistance: 5,
		impostorRadioClientId: -1,
	}).gain;
}
for (const name of names) {
	const enabled = { ...defaultLobbySettings, haunting: true, tohGhostRoles: { [name]: true } };
	assert.equal(ghostGain(name, enabled), 0.4, `${name} hears ghosts when enabled`);
	assert.equal(
		ghostGain(name, { ...enabled, tohGhostRoles: { [name]: false } }),
		0,
		`${name} cannot inherit haunting from its vanilla impostor substitute`
	);
	assert.equal(ghostGain(name, enabled, { tohRole: undefined }), 0, 'Missing role cannot grant ghost audio');
}
for (const disabled of [false, true]) {
	const html = renderToStaticMarkup(
		React.createElement(RoleSettings, {
			values: changed,
			disabled,
			update() {},
			onBack() {},
		})
	);
	assert.ok(html.includes('MOD設定に戻る'));
	assert.equal((html.match(/type="checkbox"/g) || []).length, 22);
	assert.equal((html.match(/<input[^>]*disabled=""/g) || []).length, disabled ? 22 : 0);
	assert.ok(html.includes('第三陣営') && html.includes('アニマルズ'));
}
console.log(
	'PASS TOH ghost roles: 22 individual audio permissions, legacy migration, impostor independence and read-only role screen'
);
