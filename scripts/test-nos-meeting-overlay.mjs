import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import electron from 'electron';

const directory = resolve('.cache/nos-meeting-overlay-test');
await mkdir(directory, { recursive: true });
const viewports = [
	[1920, 1080],
	[1280, 720],
	[1024, 768],
	[1280, 800],
	[2560, 1080],
];
const label = process.env.TANUKI_MEETING_OVERLAY_BASELINE ? 'before' : 'after';
const measureOnly = process.argv.includes('--measure-only');
const sourcePath = resolve('src/renderer/views/Overlay.tsx');
const source = await readFile(process.env.TANUKI_MEETING_OVERLAY_BASELINE || sourcePath, 'utf8');
const withoutMount = source.replace(
	/^createRoot\(document\.getElementById\('app'\)!\)\.render\(<Overlay \/>\);\r?$/m,
	''
);
assert.notEqual(
	withoutMount,
	source,
	'The production Overlay module mount must be removed only in the isolated fixture'
);
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MeetingHud } from './src/renderer/views/Overlay';
import { GameState } from './src/common/AmongUsState';
import { DEFAULT_PLAYERCOLORS } from './src/common/playerColors';
const root = createRoot(document.getElementById('app'));
// Keep the synthetic late-death publications inside the production four-second meeting-start window.
Date.now = () => 100000;
const waitFrame = () => new Promise(resolve => setTimeout(resolve, 25));
const rect = node => {
  const r = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return { x: r.x, y: r.y, width: r.width, height: r.height,
    marginBottom: style.marginBottom, marginLeft: style.marginLeft, marginRight: style.marginRight,
    boxSizing: style.boxSizing, position: style.position, opacity: node.style.opacity, shadow: style.boxShadow };
};
let key = 0;
globalThis.renderMeeting = async ({ count, mod = 'NoS', oldHud = false, talking = 'all', reverse = false, dead = [], remount = true }) => {
  const players = Array.from({ length: count }, (_, id) => ({
    id, clientId: id + 100, colorId: id % DEFAULT_PLAYERCOLORS.length,
    name: 'Player ' + id, isLocal: id === 0, disconnected: false, isDead: dead.includes(id),
    nosPlayer: { colorR: id / 255, colorG: (50 + id) / 255, colorB: (100 + id) / 255 },
  }));
  const gameState = { gameState: GameState.DISCUSSION, mod, oldMeetingHud: oldHud, players: reverse ? [...players].reverse() : players };
  const voiceState = { localTalking: talking === 'all' || talking === 0,
    otherTalking: Object.fromEntries(players.map(player => [player.clientId, talking === 'all' || talking === player.id])) };
  if (remount) key++;
  flushSync(() => root.render(React.createElement(MeetingHud, { key, gameState, voiceState, playerColors: DEFAULT_PLAYERCOLORS })));
  await waitFrame();
  const frames = [...document.querySelectorAll('[style]')].filter(node => node.style.boxShadow);
  const tablet = frames[0]?.parentElement;
  const hud = tablet?.parentElement;
  return { viewport: { width: innerWidth, height: innerHeight }, count, mod, oldHud,
    frames: frames.map(rect), tablet: tablet ? rect(tablet) : null, hud: hud ? rect(hud) : null };
};
`;
const bundled = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'nos-meeting-overlay-harness.tsx', loader: 'tsx' },
	bundle: true,
	format: 'iife',
	write: false,
	outfile: resolve(directory, 'harness.js'),
	define: { 'process.env.NODE_ENV': '"development"' },
	plugins: [
		{
			name: 'isolated-meeting',
			setup(b) {
				b.onLoad({ filter: /[\\/]Overlay\.tsx$/ }, () => ({
					contents: withoutMount + '\nexport { MeetingHud };',
					loader: 'tsx',
					resolveDir: resolve(sourcePath, '..'),
				}));
				b.onResolve({ filter: /electron-bridge$/ }, () => ({ path: 'ipc', namespace: 'mock' }));
				b.onResolve({ filter: /[\\/]Avatar$/ }, () => ({ path: 'avatar', namespace: 'mock' }));
				b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
					contents:
						path === 'avatar'
							? 'export default function Avatar() { return null; }'
							: 'export const ipcRenderer = { on() {}, off() {}, send() {} };',
				}));
			},
		},
	],
});
for (const output of bundled.outputFiles) {
	await writeFile(output.path, output.contents);
	if (output.path.endsWith('.js')) await writeFile(resolve(directory, `harness-${label}.js`), output.contents);
}
const html = resolve(directory, 'index.html');
await writeFile(
	html,
	'<!doctype html><meta charset="utf-8"><title>Isolated NoS meeting overlay test</title><link rel="stylesheet" href="harness.css"><div id="app"></div>'
);
const runner = resolve(directory, 'runner.cjs');
await writeFile(
	runner,
	`const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const directory = ${JSON.stringify(directory)};
const label = ${JSON.stringify(label)};
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const outcomes = [];
    for (const [width, height] of ${JSON.stringify(viewports)}) {
      const window = new BrowserWindow({ show: false, frame: false, width, height, useContentSize: true,
        webPreferences: { backgroundThrottling: false } });
      window.setContentSize(width, height);
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
      await window.loadFile(${JSON.stringify(html)});
      await window.webContents.executeJavaScript(fs.readFileSync(path.join(directory, 'harness.js'), 'utf8'));
      for (const count of [15, 16, 18, 19, 24]) {
        const outcome = await window.webContents.executeJavaScript('renderMeeting(' + JSON.stringify({ count }) + ')');
        outcomes.push(outcome);
        if (width === 1920 || (width === 1024 && count === 19)) {
          await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
          fs.writeFileSync(path.join(directory, label + '-nos-' + count + (width === 1920 ? '' : '-1024x768') + '.png'), (await window.capturePage()).toPNG());
        }
      }
      for (const [count, mod, oldHud] of [[15, 'NONE', false], [16, 'NONE', false], [16, 'NoS', true], [16, 'NONE', true]])
        outcomes.push(await window.webContents.executeJavaScript('renderMeeting(' + JSON.stringify({ count, mod, oldHud }) + ')'));
      for (const scenario of [
        { count: 16, talking: 15, reverse: true, dead: [2, 15] },
        { count: 16, talking: 2, reverse: true, dead: [2, 15], remount: false },
        { count: 16, talking: 3, reverse: true, dead: [1, 2, 15], remount: false },
      ]) {
        const outcome = await window.webContents.executeJavaScript('renderMeeting(' + JSON.stringify(scenario) + ')');
        outcomes.push({ ...outcome, scenario });
      }
      window.destroy();
    }
    fs.writeFileSync(path.join(directory, 'measurements-' + label + '.json'), JSON.stringify(outcomes, null, 2));
    console.log('RESULT:' + outcomes.length);
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
const line = result.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT:'));
assert.ok(line, result.stdout + result.stderr);
const measurements = JSON.parse(await readFile(resolve(directory, `measurements-${label}.json`), 'utf8'));
assert.equal(measurements.length, viewports.length * 12);
if (measureOnly) {
	console.log(
		`Measured ${measurements.length} actual React/MUI meeting scenarios: ${resolve(directory, `measurements-${label}.json`)}`
	);
	process.exit(0);
}

function near(actual, expected, description) {
	assert.ok(Math.abs(actual - expected) < 0.3, `${description}: actual ${actual}, expected ${expected}`);
}

function legacyGeometry(width, height, oldHud) {
	const difference = Math.abs(width / height - 1.7);
	const hudWidth = oldHud
		? width / (height * 0.96) > 854 / 579
			? (width * 0.96 * 854) / 579
			: width
		: width / (difference < 0.25 ? 1.192 : difference < 0.5 ? 1.146 : 1.591);
	const hudHeight = oldHud ? hudWidth : hudWidth / 1.72;
	const containerWidth = hudWidth * (oldHud ? 0.8845 : 1);
	const cardWidth = containerWidth * (oldHud ? 0.4641 : 0.3);
	const cardHeight = hudHeight * 0.105 * (oldHud ? 1 : 1.09);
	return {
		columns: oldHud ? 2 : 3,
		cardWidth,
		cardHeight,
		x: (width - hudWidth) / 2 + hudWidth * (oldHud ? 0.047 : 0.004) + containerWidth * (oldHud ? 0 : 0.024),
		y: (height - hudHeight) / 2 + hudHeight * (oldHud ? 0.184703 : 0.15),
		stepX: cardWidth + containerWidth * (oldHud ? 0.0234 : 0.0263),
		stepY: cardHeight + containerWidth * (oldHud ? 0.02 : 0.019),
	};
}

// Independent NoS source: https://github.com/Dolly1016/Nebula-Public/blob/990f542a2180b3ea0967fbe756d902dcb1e8c364/NebulaPluginNova/Patches/Old/MeetingPatch.cs#L20-L34
function geometryFor(measurement) {
	const { width, height } = measurement.viewport;
	if (measurement.mod !== 'NoS' || measurement.oldHud || measurement.count <= 15)
		return legacyGeometry(width, height, measurement.oldHud);
	const compact = measurement.count <= 18;
	const scale = compact ? 0.95 : 0.76;
	// The shipped camera is orthographic size 3. MeetingHub's AspectSize fits the
	// PhoneUI Background's serialized width 8.54 times local X scale 1.2 into the viewport.
	const aspectScale = Math.min(1, (6 * width) / height / (8.54 * 1.2));
	const pixelsPerUnit = (height / 6) * aspectScale;
	// Serialized MeetingHud: VoteOrigin (-3.1,1.5), ButtonStuff parent (+.25,0),
	// VoteButtonOffsets (2.9,-.76), centered Background sliced size (2.7,.63).
	const cardWidth = 2.7 * scale * pixelsPerUnit;
	const cardHeight = 0.63 * scale * pixelsPerUnit;
	return {
		columns: compact ? 3 : 4,
		x: width / 2 + (-3.1 + 0.25 + (compact ? 0.1 : -0.355)) * pixelsPerUnit - cardWidth / 2,
		y: height / 2 - (1.5 + (compact ? 0.145 : 0)) * pixelsPerUnit - cardHeight / 2,
		cardWidth,
		cardHeight,
		stepX: 2.9 * scale * (compact ? 1 : 0.974) * pixelsPerUnit,
		stepY: 0.76 * scale * (compact ? 0.89 : 1) * pixelsPerUnit,
	};
}

for (const measurement of measurements) {
	const expected = geometryFor(measurement);
	const { viewport, frames, count, mod, oldHud } = measurement;
	assert.ok(viewports.some(([width, height]) => viewport.width === width && viewport.height === height));
	assert.equal(frames.length, count);
	const description = `${viewport.width}x${viewport.height} ${mod} ${count} oldHud=${oldHud}`;
	for (const [index, frame] of frames.entries()) {
		near(frame.width, expected.cardWidth, `${description} frame ${index} width`);
		near(frame.height, expected.cardHeight, `${description} frame ${index} height`);
		near(frame.x - frames[0].x, (index % expected.columns) * expected.stepX, `${description} frame ${index} column`);
		near(
			frame.y - frames[0].y,
			Math.floor(index / expected.columns) * expected.stepY,
			`${description} frame ${index} row`
		);
	}
	near(frames[0].x, expected.x, `${description} first x`);
	near(frames[0].y, expected.y, `${description} first y`);
	if (mod === 'NoS' && !oldHud && count > 15) {
		const outside = frames.find(
			(frame) =>
				frame.x < 0 || frame.y < 0 || frame.x + frame.width > viewport.width || frame.y + frame.height > viewport.height
		);
		assert.ok(!outside, `${description} card must remain inside the viewport: ${JSON.stringify(outside)}`);
	}
	if (measurement.scenario) {
		const { talking, dead } = measurement.scenario;
		const order = Array.from({ length: count }, (_, id) => id).sort(
			(a, b) => Number(dead.includes(a)) - Number(dead.includes(b)) || a - b
		);
		assert.equal(frames.filter((frame) => frame.opacity === '1').length, 1);
		assert.equal(
			frames.findIndex((frame) => frame.opacity === '1'),
			order.indexOf(talking),
			`${description} voice identity must follow meeting order`
		);
	}
}
console.log(
	`PASS actual React/MUI NoS meeting overlays: ${measurements.length} viewport/count/legacy/voice-order scenarios; 16/19-player layout boundaries follow NoS geometry and camera aspect scaling`
);
