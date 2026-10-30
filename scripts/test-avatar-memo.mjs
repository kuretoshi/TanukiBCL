import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/avatar-memo-test');
await mkdir(directory, { recursive: true });
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Avatar from './src/renderer/components/Avatar';

globalThis.__avatarProbe = { renders: 0, masks: [], lite: false, liteRenders: 0 };
const probe = globalThis.__avatarProbe;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const asset = (name) => image + '#' + name;
const require = (value, message) => { if (!value) throw new Error(message); };
const players = Array.from({ length: 15 }, (_, id) => ({
  id, clientId: id + 10, name: 'Player ' + id, colorId: 0, currentOutfit: 0,
  hatId: '', skinId: '', visorId: '', appearanceHatId: '', appearanceSkinId: '', appearanceVisorId: '',
  appearanceName: '', appearanceColorId: -1, nosLobbyColor: '#112233',
  nosCosmetics: Object.fromEntries(['skin', 'hat', 'hatBack', 'visor', 'bodyMask'].map(key => [key, asset(key)])),
}));
const root = createRoot(document.getElementById('app'));
const render = (frames = players, overrides = {}) => flushSync(() => root.render(
  React.createElement('main', null, frames.map(player => React.createElement('section', { key: player.id },
    React.createElement(Avatar, {
      player, size: 80, talking: false, borderColor: '#2ecc71', isAlive: true,
      socketConfig: { volume: 1, isMuted: false }, onConfigChange: () => {},
      mod: 'NoS', ...overrides,
    })
  )))
));
const first = () => document.querySelector('section');
const hasImage = (url) => [...first().querySelectorAll('img')].some(node => node.getAttribute('src') === url);
const hasMask = (url) => [...first().querySelectorAll('[style]')].some(node => node.style.maskImage.includes(url));
const copy = (frame) => players.map(player => ({ ...player, x: frame, y: -frame, nosCosmetics: { ...player.nosCosmetics } }));

render();
require(probe.renders === 15, 'All 15 canvases must mount');
for (let frame = 1; frame <= 100; frame++) render(copy(frame));
require(probe.renders === 15, 'Position-only snapshots must reuse all 15 costume canvases; actual=' + probe.renders);
const initialRenders = probe.renders;
let expectedRenders = probe.renders;
for (const key of ['skin', 'hat', 'hatBack', 'visor', 'bodyMask']) {
  players[0].nosCosmetics[key] = asset(key + '-changed');
  render(copy(101));
  require(probe.renders === ++expectedRenders, key + ' URL change must redraw exactly one canvas');
  require(key === 'bodyMask' ? hasMask(players[0].nosCosmetics[key]) : hasImage(players[0].nosCosmetics[key]), key + ' must reach the rendered costume');
}
for (const [key, layer] of [['skin', '7'], ['hat', '30'], ['hatBack', '4'], ['visor', '40']]) {
  const node = [...first().querySelectorAll('img')].find(node => node.getAttribute('src') === players[0].nosCosmetics[key]);
  require(node?.style.zIndex === layer, key + ' layer must remain ' + layer);
}

render(copy(102), { showHat: false });
require(hasImage(players[0].nosCosmetics.skin), 'Hide hats must retain the NoS skin');
for (const key of ['hat', 'hatBack', 'visor']) require(!hasImage(players[0].nosCosmetics[key]), 'Hide hats must hide ' + key);
require(!hasMask(players[0].nosCosmetics.bodyMask), 'Hide hats must retain the existing unmasked-body behavior');
render(copy(103));
require(hasMask(players[0].nosCosmetics.bodyMask), 'Restoring hats must restore the body mask');

const onePlayer = [players[0]];
render(onePlayer);
for (const overrides of [
  { talking: true },
  { isUsingRadio: true },
  { isAlive: false },
  { size: 100 },
  { mod: 'NONE' },
]) {
  const before = probe.renders;
  render(onePlayer, overrides);
  require(probe.renders === before + 1, JSON.stringify(overrides) + ' must still redraw');
  if (overrides.isAlive === false) require(!hasMask(players[0].nosCosmetics.bodyMask), 'Ghosts must not use the living body mask');
  if (overrides.mod === 'NONE') {
    for (const key of ['skin', 'hat', 'hatBack', 'visor']) require(!hasImage(players[0].nosCosmetics[key]), 'Vanilla must not render NoS ' + key);
    require(!hasMask(players[0].nosCosmetics.bodyMask), 'Vanilla must not use a NoS body mask');
  }
}
render(onePlayer);
const beforeColor = probe.renders;
players[0].nosLobbyColor = '#445566';
render(copy(104).slice(0, 1));
require(probe.renders === beforeColor + 1, 'NoS body color change must redraw');
players[0].currentOutfit = 1;
players[0].appearanceColorId = 1;
render(copy(105).slice(0, 1), { hideWhenAppearanceChanged: true });
require([...first().querySelectorAll('[style]')].some(node => node.style.visibility === 'hidden'), 'Changed appearances must still be hidden');
render(copy(106).slice(0, 1), { hideWhenAppearanceChanged: false });
require(![...first().querySelectorAll('[style]')].some(node => node.style.visibility === 'hidden'), 'Appearance visibility must restore');
probe.lite = true;
const beforeLite = probe.renders;
render(copy(107).slice(0, 1));
require(probe.renders === beforeLite && probe.liteRenders === 1, 'Lite must retain its own avatar path');
flushSync(() => root.unmount());
globalThis.__avatarMemoResult = { players: 15, frames: 100, canvasRenders: initialRenders, changedUrls: 5 };
`;
const mocks = {
	'../lib/cosmetics': `
    export const cosmeticType = { base: 'base', hat: 'hat', hat_back: 'hat_back', skin: 'skin', visor: 'visor' };
    export const redAlive = '';
    export const useHatsLoaded = () => true;
    export const getCosmetic = (_color, _alive, type) => type === 'base' ? 'data:,' : '';
    export const getHatDementions = () => ({ top: '0', width: '0', left: '0' });
  `,
	'../lib/nosAvatar': `export function useNosAvatar() { globalThis.__avatarProbe.renders++; return undefined; }`,
	'../lib/nosCosmetics': `export function useNosBodyMask(url) { globalThis.__avatarProbe.masks.push(url); return url; }`,
	'../LiteAvatar': `export default function LiteAvatar() { globalThis.__avatarProbe.liteRenders++; return null; }`,
	'../../common/appVariant': `export const isLiteRuntime = () => globalThis.__avatarProbe.lite;`,
};
const output = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'avatar-memo-harness.tsx', loader: 'tsx' },
	bundle: true,
	format: 'iife',
	write: false,
	define: { 'process.env.NODE_ENV': '"development"' },
	loader: { '.svg': 'dataurl' },
	plugins: [
		{
			name: 'avatar-dependencies',
			setup(b) {
				b.onResolve({ filter: /.*/ }, (args) => {
					if (mocks[args.path]) return { path: args.path, namespace: 'mock' };
					if (args.path.startsWith('@mui/')) return { path: args.path, namespace: 'mui' };
				});
				b.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({ contents: mocks[args.path] }));
				b.onLoad({ filter: /.*/, namespace: 'mui' }, () => ({
					contents: `import React from 'react';
            export function Tooltip({ children }) { return children; }
            export default function Component({ component = 'div', sx, style, children, ...props }) {
              return React.createElement(component, { ...props, style: { ...sx, ...style } }, children);
            }`,
					resolveDir: process.cwd(),
				}));
				if (process.env.TANUKI_AVATAR_BASELINE)
					b.onLoad({ filter: /[\\/]Avatar\.tsx$/ }, async (args) => ({
						contents: await readFile(process.env.TANUKI_AVATAR_BASELINE, 'utf8'),
						loader: 'tsx',
						resolveDir: resolve(args.path, '..'),
					}));
			},
		},
	],
});
const bundle = resolve(directory, 'harness.js');
await writeFile(bundle, output.outputFiles[0].contents);
const html = resolve(directory, 'index.html');
await writeFile(html, '<!doctype html><title>Avatar memo test</title><div id="app"></div>');
const runner = resolve(directory, 'runner.cjs');
await writeFile(
	runner,
	`const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadFile(${JSON.stringify(html)});
    const source = require('fs').readFileSync(${JSON.stringify(bundle)}, 'utf8');
    const error = await window.webContents.executeJavaScript('try { eval(' + JSON.stringify(source) + '); null; } catch (error) { String(error.stack || error); }');
    if (error) throw new Error(error);
    console.log('RESULT:' + JSON.stringify(await window.webContents.executeJavaScript('globalThis.__avatarMemoResult')));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});`
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [runner], {
	env,
	windowsHide: true,
	encoding: 'utf8',
	timeout: 60000,
	maxBuffer: 4 * 1024 * 1024,
});
assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
const outputLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT:'));
assert.ok(outputLine, result.stdout + result.stderr);
const measured = JSON.parse(outputLine.slice(7));
assert.deepEqual(measured, { players: 15, frames: 100, canvasRenders: 15, changedUrls: 5 });
console.log(
	'PASS actual React Avatar memo: 15 canvases across 100 fresh snapshots; URL changes, layers, mask visibility, voice state, color and Lite path'
);
