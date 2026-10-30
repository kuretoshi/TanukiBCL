import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/connection-indicator-memo-test');
await mkdir(directory, { recursive: true });
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ConnectionIndicator from './src/renderer/components/ConnectionIndicator';

globalThis.__indicatorMemoProbe = { renders: 0 };
globalThis.__indicatorMemoDone = (async () => {
  const probe = globalThis.__indicatorMemoProbe;
  const require = (value, message) => { if (!value) throw new Error(message); };
  const waitFor = async (check, message) => {
    const deadline = performance.now() + 3000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const theme = createTheme({ typography: { fontFamily: 'serif' } });
  const nextTheme = createTheme({ typography: { fontFamily: 'monospace' } });
  const root = createRoot(document.getElementById('app'));
  const quality = { rttMs: 80, jitterMs: 4, lossPercent: 0.5, direct: true };
  const render = (props, currentTheme = theme) => flushSync(() => root.render(
    React.createElement(ThemeProvider, { theme: currentTheme }, React.createElement(ConnectionIndicator, props))
  ));
  const target = () => document.querySelector('[role="img"]');
  const label = () => target()?.getAttribute('aria-label') ?? '';
  const tooltip = () => document.querySelector('[role="tooltip"]');
  const tooltipFont = () => getComputedStyle(tooltip().querySelector('.MuiTooltip-tooltip') ?? tooltip()).fontFamily;
  const hover = () => target().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

  render({ connected: true, quality });
  require(probe.renders === 1, 'Initial connected indicator must render once');
  require(label().includes('良好') && label().includes('80 ms'), 'Accessible label must retain quality and latency');
  require(target().tabIndex === 0, 'Indicator must remain keyboard accessible');
  require(getComputedStyle(target()).right === '-2px', 'Default edgeInset must remain -2');
  for (let frame = 0; frame < 100; frame++) render({ connected: true, quality });
  require(probe.renders === 1, '100 equal-prop parent updates must reuse the indicator; actual=' + probe.renders);
  const unchangedRenders = probe.renders;

  hover();
  await waitFor(() => tooltip()?.textContent.includes('受信ロス：0.5%'), 'Real MUI tooltip must open on hover');
  require(tooltip().textContent.includes('受信の揺らぎ：4 ms'), 'Tooltip must retain jitter');

  const changedQuality = { ...quality, rttMs: 220, jitterMs: 42, lossPercent: 1.25 };
  render({ connected: true, quality: changedQuality });
  require(probe.renders === 2, 'Changed quality must render immediately');
  require(label().includes('普通') && label().includes('220 ms'), 'Changed quality must update the accessible label');
  await waitFor(() => tooltip()?.textContent.includes('受信ロス：1.3%'), 'Open tooltip must immediately reflect new quality');
  require(tooltip().textContent.includes('受信の揺らぎ：42 ms'), 'Open tooltip must update jitter');

  render({ connected: false, quality: changedQuality });
  require(label().includes('未接続') && !label().includes('220 ms'), 'Disconnect must update immediately');
  await waitFor(() => tooltip()?.textContent.includes('未接続'), 'Disconnect must update an open tooltip');
  require(!tooltip().textContent.includes('受信ロス'), 'Disconnected tooltip must hide receive statistics');
  const beforeReconnect = probe.renders;
  render({ connected: true, quality: changedQuality });
  require(probe.renders === beforeReconnect + 1 && label().includes('220 ms'), 'Reconnect must update immediately');

  render({ connected: true });
  require(label().includes('未計測') && !label().includes('220 ms'), 'Missing quality must restore the unmeasured state');
  const props = { connected: true, quality: changedQuality, edgeInset: 8 };
  const beforeInset = probe.renders;
  render(props);
  require(probe.renders === beforeInset + 1, 'Changed edgeInset must render');
  require(getComputedStyle(target()).right === '8px' && getComputedStyle(target()).bottom === '8px', 'Changed edgeInset must reach real MUI styles');
  render({ ...props });
  require(probe.renders === beforeInset + 1, 'Equal explicit edgeInset must still reuse the indicator');

  await waitFor(() => tooltip() && tooltipFont().includes('serif'), 'First MUI theme must reach the tooltip');
  const beforeTheme = probe.renders;
  render(props, nextTheme);
  await waitFor(() => tooltip() && tooltipFont().includes('monospace'), 'Theme context must still update memoized descendants');
  require(probe.renders === beforeTheme, 'Theme changes should update MUI descendants without rerendering the wrapper');
  target().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  await waitFor(() => !tooltip(), 'Real MUI tooltip must close after mouse leave');
  hover();
  await waitFor(() => tooltip()?.textContent.includes('220 ms'), 'Tooltip interaction must keep working after theme updates');
  flushSync(() => root.unmount());
  require(!tooltip(), 'Unmount must remove the tooltip portal');
  return { parentUpdates: 100, unchangedRenders, realMuiTooltip: true, themeUpdated: true };
})().then(result => ({ result }), error => ({ error: String(error.stack || error) }));
`;
const bundle = await build({
	stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'connection-indicator-memo.tsx', loader: 'tsx' },
	bundle: true,
	format: 'iife',
	write: false,
	define: { 'process.env.NODE_ENV': '"development"' },
	plugins: [
		{
			name: 'indicator-render-counter',
			setup(b) {
				// Count the production render's quality calculation; retain its real implementation and all MUI components.
				b.onResolve({ filter: /^\.\.\/voice\/connectionQuality$/ }, () => ({
					path: 'quality-counter',
					namespace: 'counter',
				}));
				b.onLoad({ filter: /.*/, namespace: 'counter' }, () => ({
					contents: `import { qualityBars as actualQualityBars } from './src/renderer/voice/connectionQuality.ts';
          export function qualityBars(quality) { globalThis.__indicatorMemoProbe.renders++; return actualQualityBars(quality); }`,
					resolveDir: process.cwd(),
				}));
				if (process.env.TANUKI_CONNECTION_INDICATOR_BASELINE)
					b.onLoad({ filter: /[\\/]ConnectionIndicator\.tsx$/ }, async (args) => ({
						contents: await readFile(process.env.TANUKI_CONNECTION_INDICATOR_BASELINE, 'utf8'),
						loader: 'tsx',
						resolveDir: resolve(args.path, '..'),
					}));
			},
		},
	],
});
const script = resolve(directory, 'harness.js');
await writeFile(script, bundle.outputFiles[0].contents);
const html = resolve(directory, 'index.html');
await writeFile(html, '<!doctype html><title>Connection indicator memo test</title><div id="app"></div>');
const runner = resolve(directory, 'runner.cjs');
await writeFile(
	runner,
	`const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await window.loadFile(${JSON.stringify(html)});
    await window.webContents.executeJavaScript(require('fs').readFileSync(${JSON.stringify(script)}, 'utf8'));
    const outcome = await window.webContents.executeJavaScript('globalThis.__indicatorMemoDone');
    if (outcome.error) throw new Error(outcome.error);
    console.log('RESULT:' + JSON.stringify(outcome.result));
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
const output = result.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT:'));
assert.ok(output, result.stdout + result.stderr);
assert.deepEqual(JSON.parse(output.slice(7)), {
	parentUpdates: 100,
	unchangedRenders: 1,
	realMuiTooltip: true,
	themeUpdated: true,
});
console.log(
	'PASS real React/MUI ConnectionIndicator memo: 100 equal-prop updates => 1 render; quality, disconnect/reconnect, edgeInset, accessible labels, tooltip interaction and theme context'
);
