import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const directory = resolve('.cache/player-ban-ui-test');
await mkdir(directory, { recursive: true });
const shared = `
globalThis.__banUi = {
  calls: [], legacy: false, noHistory: false, duplicateKeys: [],
  history: [
    { uid_digest: 'a'.repeat(64), display_name: 'Target', friend_code: 'FRIEND#1', public_ip: '203.0.113.44', uid_banned: 0, ip_banned: 0, is_banned: 0 },
    { uid_digest: 'b'.repeat(64), display_name: 'Unknown IP', friend_code: '', public_ip: '', uid_banned: 0, ip_banned: 0, is_banned: 0 },
    { uid_digest: 'c'.repeat(64), display_name: 'UID Only', friend_code: '', public_ip: '2001:db8::10', uid_banned: 1, ip_banned: 0, is_banned: 1 },
    { uid_digest: 'd'.repeat(64), display_name: 'IP Only', friend_code: '', public_ip: '203.0.113.88', uid_banned: 0, ip_banned: 1, is_banned: 1 },
  ].map(row => ({ ...row, first_seen_at: 1000, last_seen_at: 2000 })),
  bans: [
    { ban_type: 'uid', uid_digest: 'a'.repeat(64), player_uid: 'live-user', display_name: 'UID Ban', public_ip: '203.0.113.44' },
    { ban_type: 'ip', uid_digest: 'a'.repeat(64), player_uid: 'live-user', display_name: 'IP Ban', public_ip: '203.0.113.44' },
  ].map(row => ({ ...row, friend_code: '', reason: 'reviewed', created_at: 1000 })),
};
const probe = globalThis.__banUi;
const originalError = console.error;
console.error = (...args) => {
  if (args.map(String).join(' ').includes('same key')) probe.duplicateKeys.push(args.map(String).join(' '));
  originalError(...args);
};
globalThis.fetch = () => { throw new Error('The UI test must not make network requests'); };
const require = (value, message) => { if (!value) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const waitFor = async (check, message) => {
  const deadline = performance.now() + 3000;
  while (!check()) { if (performance.now() > deadline) throw new Error(message); await pause(); }
};
const text = element => element?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
const button = (label, scope = document) => [...scope.querySelectorAll('button')].find(node => text(node) === label);
const field = label => {
  const node = [...document.querySelectorAll('label')].find(node => text(node) === label);
  require(node, 'Missing field: ' + label);
  return document.getElementById(node.htmlFor);
};
const input = async (label, value) => {
  const node = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
};
const click = async node => { require(node, 'Missing button'); node.click(); await pause(); };
const choose = async mode => {
  await click(button(mode === 'ip' ? 'IPアドレス' : 'ユーザー識別子（UID）'));
  require(button(mode === 'ip' ? 'IPアドレス' : 'ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'Mode must change to ' + mode);
};
const lastCall = () => probe.calls.at(-1)?.payload;
const rowText = name => [...document.querySelectorAll('p')].find(node => text(node).startsWith(name + ' ／') || text(node).startsWith(name + '（'));
const lobbyRow = name => { const node = rowText(name); require(node, 'Missing lobby/ban row: ' + name); return node.parentElement; };
const historyRow = name => { const node = rowText(name); require(node, 'Missing history row: ' + name); return node.closest('.MuiPaper-root'); };
const confirmBan = async (row, mode) => {
  const before = probe.calls.length;
  await click(button((mode === 'ip' ? 'IP' : 'UID') + 'でBAN登録', row));
  require(probe.calls.length === before, 'First registration click must only confirm');
  await click(button((mode === 'ip' ? 'IP' : 'UID') + ' BANを確定', row));
  require(probe.calls.length === before + 1, 'Second registration click must make one request');
};
`;
const panel = `
const root = createRoot(document.getElementById('app'));
flushSync(() => root.render(React.createElement(PlayerBanPanel, { players: [
  { id: 1, playerUid: 'live-user', name: 'Lobby User', friendCode: 'LIVE#1', isLocal: false },
  { id: 2, playerUid: 'unknown-user', name: 'Unknown Lobby', friendCode: '', isLocal: false },
] })));
globalThis.__banUiDone = (async () => {
  require(button('IPアドレス')?.disabled, 'IP mode must be disabled before a capable list response');
  require(button('ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'Default mode must be UID');
  await input('BAN管理者パスワード', 'test-admin-password');
  await input('登録理由（任意）', 'review reason');
  await click(button('一覧を読み込む'));
  require(lastCall().action === 'list' && lastCall().historyAll === true, 'Panel must retain full history loading');
  require(!button('IPアドレス').disabled, 'Capable response must enable IP mode');
  require(document.body.textContent.includes('203.0.113.44') && document.body.textContent.includes('未取得'), 'History must display known and missing IPs');
  require(text(lobbyRow('UID Ban')).includes('UID BAN') && text(lobbyRow('IP Ban')).includes('IP BAN'), 'Registered rows must distinguish UID/IP bans');
  require(probe.duplicateKeys.length === 0, 'UID and IP bans for the same UID must not share React keys');

  const beforeConfirm = probe.calls.length;
  await click(button('UIDでBAN登録', lobbyRow('Lobby User')));
  await choose('ip');
  require(button('IPでBAN登録', lobbyRow('Lobby User')), 'Changing mode must clear UID confirmation');
  await click(button('IPでBAN登録', lobbyRow('Lobby User')));
  await choose('uid');
  require(button('UIDでBAN登録', lobbyRow('Lobby User')), 'Changing back must clear IP confirmation');
  require(probe.calls.length === beforeConfirm, 'Changing modes must not submit either ban');
  await confirmBan(lobbyRow('Lobby User'), 'uid');
  require(lastCall().action === 'add' && lastCall().playerUid === 'live-user', 'UID mode must retain the legacy add action');
  require(lastCall().reason === 'review reason' && lastCall().friendCode === 'LIVE#1', 'UID registration details must remain intact');
  await choose('ip');
  await confirmBan(lobbyRow('Lobby User'), 'ip');
  require(lastCall().action === 'add-ip' && lastCall().playerUid === 'live-user', 'IP mode must request server-side UID-to-IP lookup');
  require(!('publicIp' in lastCall()), 'Current lobby must not invent or upload an IP');

  await confirmBan(lobbyRow('Unknown Lobby'), 'ip');
  require(lastCall().action === 'add-ip' && lastCall().playerUid === 'unknown-user', 'Unknown lobby IP must still use only the explicit IP action');
  require(document.querySelector('[role="status"]').textContent.includes('未取得'), 'Server unknown-IP error must be shown');
  await input('UID待ちのプレイヤー名（完全一致）', 'Pending Target');
  await click(button('名前で登録'));
  await click(button('名前登録を確定'));
  require(lastCall().action === 'add-name' && lastCall().playerName === 'Pending Target', 'Pending name bans must remain UID-only in IP mode');

  await click(button('解除', lobbyRow('UID Ban')));
  require(lastCall().action === 'remove' && lastCall().uidDigest === 'a'.repeat(64), 'UID removal must retain its digest action');
  await click(button('解除', lobbyRow('IP Ban')));
  require(lastCall().action === 'remove-ip' && lastCall().publicIp === '203.0.113.44', 'IP removal must target the exact stored address');
  require(!('uidDigest' in lastCall()), 'IP removal must not silently remove a UID ban');

  probe.legacy = true;
  await click(button('一覧を読み込む'));
  require(button('IPアドレス').disabled, 'Old server must disable IP registration');
  require(button('ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'Old response must restore UID mode');
  require(document.body.textContent.includes('サーバーに未反映'), 'Old server capability must be explained');
  await click(button('IPアドレス'));
  await confirmBan(lobbyRow('Lobby User'), 'uid');
  require(lastCall().action === 'add', 'Old server must keep using UID actions');
  require(probe.duplicateKeys.length === 0, 'Ban rows must retain distinct keys');
  flushSync(() => root.unmount());
  return { view: 'panel', checks: 'UID/IP actions, capability, unknown IP, confirmation reset, name bans, removal and distinct keys' };
})().then(result => ({ result }), error => ({ error: String(error.stack || error) }));
`;
const history = `
globalThis.__banUiDone = (async () => {
  await waitFor(() => button('検索'), 'History window must mount');
  require(button('IPアドレス')?.disabled, 'History IP mode must be disabled before a capable response');
  require(button('ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'History default must be UID');
  await input('BAN管理者パスワード', 'test-admin-password');
  await input('登録理由（任意）', 'history review');
  await input('名前で検索', 'review');
  await input('最終確認日（開始）', '2026-10-01');
  await input('最終確認日（終了）', '2026-10-30');
  await click(button('検索'));
  require(lastCall().action === 'list' && lastCall().historyName === 'review' && lastCall().historyOffset === 0, 'History search payload must remain intact');
  const from = lastCall().historyFrom, to = lastCall().historyTo;
  require(from === new Date('2026-10-01T00:00:00').getTime() / 1000 && to === new Date('2026-10-31T00:00:00').getTime() / 1000, 'Date range must retain local inclusive-end behavior');
  require(!button('IPアドレス').disabled, 'Capable history response must enable IP mode');
  require(text(historyRow('Target')).includes('203.0.113.44') && text(historyRow('Unknown IP')).includes('未取得'), 'History must show IP acquisition state');
  require(button('UIDでBAN登録', historyRow('IP Only')), 'An existing IP ban must not prevent a separate UID ban');
  require(!button('UIDでBAN登録', historyRow('UID Only')), 'UID-banned row must retain its existing status');

  await click(button('UIDでBAN登録', historyRow('Target')));
  const beforeMode = probe.calls.length;
  await choose('ip');
  require(button('IPでBAN登録', historyRow('Target')), 'History mode change must clear confirmation');
  require(button('IPでBAN登録', historyRow('Unknown IP')).disabled, 'IP-unavailable row must not be IP-banned');
  require(button('IPでBAN登録', historyRow('UID Only')) && !button('IPでBAN登録', historyRow('UID Only')).disabled, 'An existing UID ban must not prevent an IP ban');
  require(!button('IPでBAN登録', historyRow('IP Only')), 'IP-banned row must display its separate status');
  await click(button('IPでBAN登録', historyRow('Unknown IP')));
  require(probe.calls.length === beforeMode, 'Disabled unknown-IP registration must make no request');
  await click(button('IPでBAN登録', historyRow('Target')));
  await choose('uid');
  require(button('UIDでBAN登録', historyRow('Target')), 'Switching back must not retain an IP confirmation');
  await confirmBan(historyRow('Target'), 'uid');
  require(lastCall().action === 'add-history' && lastCall().uidDigest === 'a'.repeat(64), 'UID history ban must retain its old action');
  await choose('ip');
  await confirmBan(historyRow('Target'), 'ip');
  require(lastCall().action === 'add-history-ip' && lastCall().uidDigest === 'a'.repeat(64), 'IP history ban must use its explicit action');
  require(lastCall().historyName === 'review' && lastCall().historyFrom === from && lastCall().historyTo === to && lastCall().historyOffset === 0, 'Registration must preserve history filters');

  await click(button('次へ'));
  require(lastCall().action === 'list' && lastCall().historyOffset === 50 && lastCall().historyName === 'review', 'Next page must preserve filters');
  await confirmBan(historyRow('Target'), 'ip');
  require(lastCall().action === 'add-history-ip' && lastCall().historyOffset === 50, 'Page-two IP registration must retain pagination');
  await click(button('前へ'));
  require(lastCall().historyOffset === 0 && lastCall().historyFrom === from && lastCall().historyTo === to, 'Previous page must preserve date filters');

  probe.legacy = true;
  probe.noHistory = true;
  await click(button('検索'));
  require(button('IPアドレス').disabled, 'A server without history support must also disable stale IP capability');
  require(button('ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'A server without history must clear IP mode');
  require(document.querySelector('[role="status"]').textContent.includes('履歴機能はサーバーに未反映'), 'Missing history support must be explained');
  probe.noHistory = false;
  await click(button('検索'));
  require(button('IPアドレス').disabled, 'Old history response must disable IP mode');
  require(button('ユーザー識別子（UID）').getAttribute('aria-pressed') === 'true', 'Old history response must restore UID mode');
  require(!button('UIDでBAN登録', historyRow('UID Only')), 'Legacy is_banned must retain existing UID state');
  await confirmBan(historyRow('Target'), 'uid');
  require(lastCall().action === 'add-history', 'Old history server must still support UID registration');
  return { view: 'history', checks: 'UID/IP actions, independent status, unknown IP, old server, confirmation reset, filters and paging' };
})().then(result => ({ result }), error => ({ error: String(error.stack || error) }));
`;
const ipcMock = `
export const ipcRenderer = { async invoke(channel, payload) {
  const p = globalThis.__banUi;
  p.calls.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? {})) });
  if (channel === 'OPEN_PLAYER_HISTORY') return;
  if (channel !== 'debug:player-bans') throw new Error('Unexpected IPC: ' + channel);
  if (payload.action === 'add-ip' && payload.playerUid === 'unknown-user') return { error: '本人のグローバルIPが未取得です。' };
  let history = p.history, bans = p.bans;
  if (p.legacy) {
    history = history.map(({ public_ip, uid_banned, ip_banned, ...row }) => ({ ...row, is_banned: uid_banned }));
    bans = bans.filter(row => row.ban_type === 'uid').map(({ ban_type, public_ip, ...row }) => row);
  }
  return JSON.parse(JSON.stringify({ bans, pending: [], history, historyTotal: 75, historyAvailable: !p.noHistory, ...(p.legacy ? {} : { ipBansAvailable: true }) }));
} };
`;
for (const view of ['panel', 'history']) {
	const imports =
		view === 'panel'
			? `import React from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'; import PlayerBanPanel from './src/renderer/views/PlayerBanPanel';`
			: `import './src/renderer/views/PlayerHistoryWindow';`;
	const bundle = await build({
		stdin: {
			contents: imports + shared + (view === 'panel' ? panel : history),
			resolveDir: process.cwd(),
			sourcefile: `ban-ui-${view}.tsx`,
			loader: 'tsx',
		},
		bundle: true,
		format: 'iife',
		write: false,
		loader: { '.css': 'empty' },
		define: { 'process.env.NODE_ENV': '"development"' },
		plugins: [
			{
				name: 'mock-ban-ipc',
				setup(b) {
					b.onResolve({ filter: /electron-bridge$/ }, () => ({ path: 'ipc', namespace: 'mock' }));
					b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: ipcMock }));
				},
			},
		],
	});
	await writeFile(resolve(directory, `${view}.js`), bundle.outputFiles[0].contents);
}
const html = resolve(directory, 'index.html');
await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Player BAN UI test</title><div id="app"></div>');
const runner = resolve(directory, 'runner.cjs');
await writeFile(
	runner,
	`const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const outcomes = [];
    for (const view of ['panel', 'history']) {
      const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
      await window.loadFile(${JSON.stringify(html)});
      await window.webContents.executeJavaScript(require('fs').readFileSync(require('path').join(${JSON.stringify(directory)}, view + '.js'), 'utf8'));
      const outcome = await window.webContents.executeJavaScript('globalThis.__banUiDone');
      if (outcome.error) throw new Error(view + ': ' + outcome.error);
      outcomes.push(outcome.result);
      window.destroy();
    }
    console.log('RESULT:' + JSON.stringify(outcomes));
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
assert.deepEqual(
	JSON.parse(output.slice(7)).map((row) => row.view),
	['panel', 'history']
);
console.log(
	'PASS real React/MUI player BAN UI: UID/IP actions, IP acquisition and capability guards, independent states, confirmation reset, correct removals, old server compatibility, filters and paging'
);
