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
const { tohGhostRoleGroups, setTohGhostRole, setTohGhostRoleGroup, canTohHearGhosts } = await bundle('src/common/TohGhostRoles.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { isPlayerImpostor, withImpostorClassification } = await bundle('src/common/Impostor.ts');
const { default: RoleSettings } = await bundle('src/renderer/settings/sections/TohGhostRoleSettings.tsx');
const catalog = [
	{ roleId: 10, roleName: 'Jackal', displayName: 'ジャッカル', customRoleType: 'Neutral', isKiller: true },
	{ roleId: 11, roleName: 'Coyote', displayName: 'コヨーテ', customRoleType: 'Animals', isKiller: true },
	{ roleId: 12, roleName: 'FutureNeutral', displayName: '新しい第三陣営', customRoleType: 'Neutral', isKiller: true },
	{ roleId: 13, roleName: 'FutureAnimal', displayName: '新しいアニマル', customRoleType: 'Animals', isKiller: true },
	{ roleId: 14, roleName: 'Sheriff', displayName: 'シェリフ', customRoleType: 'Crewmate', isKiller: true },
	{ roleId: 15, roleName: 'MadSheriff', displayName: 'マッドシェリフ', customRoleType: 'Madmate', isKiller: true },
	{ roleId: 16, roleName: 'Impostor', displayName: 'インポスター', customRoleType: 'Impostor', isKiller: true },
	{ roleId: 17, roleName: 'Vampire', displayName: 'ヴァンパイア', customRoleType: 'Impostor', isKiller: true },
	{ roleId: 18, roleName: 'FutureImpostor', displayName: '新しいインポスター', customRoleType: 'Impostor', isKiller: true },
	{ roleId: 19, roleName: 'NonKiller', displayName: '非キル役職', customRoleType: 'Neutral', isKiller: false },
	{ roleId: 20, roleName: 'Unverified', displayName: '能力未取得', customRoleType: 'Animals', isKiller: null },
];
const names = tohGhostRoleGroups(catalog).flatMap((g) => g.roles.map((role) => role.roleName));
assert.deepEqual(names, ['Jackal', 'FutureNeutral', 'Coyote', 'FutureAnimal']);
assert.ok(!names.includes('Impostor'));
const role = (name) => ({ roleId: 123, roleName: name, isKiller: true, isNeutralKiller: null, ...catalog.find(role => role.roleName === name) });
for (const name of [...names, 'Sheriff', 'MadSheriff', 'Unknown', 'NotAssigned']) {
	assert.equal(isPlayerImpostor('TOH4E', { isImpostor: true, tohRole: role(name) }), false, name);
}
for (const vanilla of [false, true]) {
	const player = { isImpostor: vanilla, tohRole: role('FutureImpostor') };
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
const changed = { ...base, ...setTohGhostRole(base, 'Jackal', false, catalog) };
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
assert.equal(canTohHearGhosts(base, role('Sheriff')), false, 'Legacy enabled switch cannot grant crewmates ghost audio');
assert.equal(isPlayerImpostor('TOH4E', { isImpostor: true, tohRole: { ...role('Impostor'), customRoleType: 'Animals' } }), false, 'Faction overrides a recognized name');
assert.equal(isPlayerImpostor('TOH4E', { isImpostor: true, tohRole: { ...role('Vampire'), customRoleType: undefined } }), false, 'Old packets without faction fail closed');
assert.deepEqual(setTohGhostRole(base, 'Sheriff', true, catalog), {});
for (const team of ['Neutral', 'Animals']) {
	for (const enabled of [false, true]) {
		const original = { ...base, tohGhostRoles: { Jackal: false, Coyote: true, FutureNeutral: true, FutureAnimal: false, SavedOtherVersionRole: true } };
		const result = { ...original, ...setTohGhostRoleGroup(original, team, enabled, catalog) };
		for (const definition of catalog.filter(role => names.includes(role.roleName))) {
			assert.equal(result.tohGhostRoles[definition.roleName], definition.customRoleType === team ? enabled : original.tohGhostRoles[definition.roleName], `${team} bulk ${enabled} preserves other faction`);
		}
		assert.equal(result.tohGhostRoles.SavedOtherVersionRole, true);
		assert.equal(result.haunting, true);
		assert.deepEqual(original.tohGhostRoles, { Jackal: false, Coyote: true, FutureNeutral: true, FutureAnimal: false, SavedOtherVersionRole: true });
	}
}
const migratedGroup = setTohGhostRoleGroup(base, 'Neutral', false, catalog);
assert.equal(migratedGroup.tohGhostRoles.Jackal, false);
assert.equal(migratedGroup.tohGhostRoles.Coyote, true, 'Bulk first edit snapshots other legacy faction');
assert.deepEqual(setTohGhostRoleGroup(base, 'Animals', true, []), {});
assert.equal(setTohGhostRole({ ...changed, tohGhostRoles: { SavedOtherVersionRole: true } }, 'FutureAnimal', true, catalog).tohGhostRoles.SavedOtherVersionRole, true, 'Preserve settings for other DLL versions');

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
			catalog,
			values: changed,
			disabled,
			update() {},
			onBack() {},
		})
	);
	assert.ok(html.includes('MOD設定に戻る'));
	assert.equal((html.match(/type="checkbox"/g) || []).length, names.length + 2);
	assert.equal((html.match(/<input[^>]*disabled=""/g) || []).length, disabled ? names.length + 2 : 0);
	assert.ok(html.includes('第三陣営を一括設定') && html.includes('アニマルズを一括設定'));
	assert.ok(html.includes('第三陣営') && html.includes('アニマルズ'));
	assert.ok(html.includes('新しい第三陣営') && html.includes('新しいアニマル'));
	assert.ok(!html.includes('非キル役職') && !html.includes('能力未取得'));
}
const waiting = renderToStaticMarkup(React.createElement(RoleSettings, { catalog: [], values: changed, disabled: false, update() {}, onBack() {} }));
assert.ok(waiting.includes('役職一覧の取得待ち'));
assert.equal((waiting.match(/type="checkbox"/g) || []).length, 2);
assert.equal((waiting.match(/<input[^>]*disabled=""/g) || []).length, 2, 'Empty groups cannot be edited');
console.log(
	'PASS TOH DLL catalogue: new roles, faction-based audio, legacy migration, unknown metadata, version preservation and read-only role screen'
);
