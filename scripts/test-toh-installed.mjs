import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import memoryjs from 'memoryjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const pid = Number(process.argv[2]);
assert.ok(Number.isInteger(pid) && pid > 0, 'Pass the running Among Us PID');
const arch = process.argv.includes('--x86') ? 'x86' : 'x64';
const cache = resolve('.cache/toh-installed-tests');
await mkdir(cache, { recursive: true });
async function bundle(entry) {
	const file = resolve(cache, entry.split('/').at(-1).replace(/\.tsx?$/, '.mjs'));
	const result = await build({ entryPoints: [entry], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
	await writeFile(file, result.outputFiles[0].contents);
	return import(pathToFileURL(file));
}
const { isTohLayout, readTohRoles } = await bundle('src/main/tohLiveMemory.ts');
const { isPlayerImpostor } = await bundle('src/common/Impostor.ts');
const { tohGhostRoleGroups } = await bundle('src/common/TohGhostRoles.ts');
const { calculateVoiceAudio } = await bundle('src/renderer/voice/spatialAudio.ts');
const { defaultLobbySettings } = await bundle('src/common/defaultLobbySettings.ts');
const { GameState } = await bundle('src/common/AmongUsState.ts');
const { default: RoleSettings } = await bundle('src/renderer/settings/sections/TohGhostRoleSettings.tsx');
const reader = resolve(arch === 'x64' ? 'out/debug-reader/x64/SnrRoleReader.exe' : 'out/debug-reader/SnrRoleReader.exe');
const result = JSON.parse(execFileSync(reader, [String(pid), '--toh'], { windowsHide: true, timeout: 45000, encoding: 'utf8' }));
assert.equal(result.status, 'ok');
assert.ok(isTohLayout(result.layout, pid));
const layout = result.layout;
assert.equal(layout.pointerSize, arch === 'x64' ? 8 : 4);
assert.ok(layout.roleCatalog.length > 0, 'Read an initialized DLL catalogue');
await writeFile(resolve(cache, 'layout.json'), JSON.stringify(result, null, 2));
const handle = memoryjs.openProcess(pid);
try {
	const roles = readTohRoles(layout, (address, size) => memoryjs.readBuffer(handle.handle, address, size));
	for (const role of roles.values()) {
		const definition = layout.roleCatalog.find(item => item.roleId === role.roleId);
		assert.equal(role.customRoleType, definition?.customRoleType ?? null);
	}
	console.log(`PASS installed ${arch} DLL: ${layout.roleCatalog.length} definitions, ${roles.size} live players, validated live-memory layout`);
} finally { memoryjs.closeProcess(handle.handle); }
const displayed = tohGhostRoleGroups(layout.roleCatalog).flatMap(group => group.roles);
assert.ok(displayed.length > 0);
for (const definition of layout.roleCatalog) {
	const role = { ...definition, isNeutralKiller: null };
	const eligible = ['Neutral', 'Animals'].includes(definition.customRoleType) && definition.isKiller === true;
	for (const vanilla of [false, true]) {
		assert.equal(isPlayerImpostor('TOH4E', { isImpostor: vanilla, tohRole: role }), vanilla && definition.customRoleType === 'Impostor', definition.roleName);
	}
	for (const enabled of [false, true]) {
		const audio = calculateVoiceAudio({
			state: { mod: 'TOH4E', gameState: GameState.TASKS, map: 0, closedDoors: [], currentCamera: 0 },
			me: { id: 1, x: 0, y: 0, isDead: false, isImpostor: true, tohRole: role },
			other: { id: 2, x: 1, y: 0, isDead: true },
			settings: { spatialAudio: true, ghostVolumeAsImpostor: 40 },
			activeLobbySettings: { ...defaultLobbySettings, haunting: false, tohGhostRoles: { [definition.roleName]: enabled } },
			maxDistance: 5, impostorRadioClientId: -1,
		});
		assert.equal(audio.gain, eligible && enabled ? 0.4 : 0, `${definition.roleName}: ghost toggle ${enabled}`);
	}
}
for (const disabled of [false, true]) {
	const html = renderToStaticMarkup(React.createElement(RoleSettings, {
		catalog: layout.roleCatalog, values: defaultLobbySettings, disabled, update() {}, onBack() {},
	}));
	assert.equal((html.match(/type="checkbox"/g) || []).length, displayed.length + 2);
	assert.equal((html.match(/<input[^>]*disabled=""/g) || []).length, disabled ? displayed.length + 2 : 0);
	for (const role of displayed) assert.ok(html.includes(role.displayName), role.roleName);
}
console.log(`PASS installed DLL: all ${layout.roleCatalog.length} roles' impostor/audio predicates; ${displayed.length} editable/read-only UI switches`);
