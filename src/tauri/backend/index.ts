import { createInterface } from 'node:readline';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, handlers, makeEvent, WorkerWindow, control, writeFrame, setWindowOpen } from './electron';
import '../../main/hook';
import { gameReader, onGameStateChanged } from '../../main/hook';
import { initSettingsIpc } from '../../main/settingsStore';
import { initializeIpcHandlers, initializeIpcListeners, notifySettingsWindowPresence } from '../../main/ipc-handlers';
import { registerNosVoiceRoleBridge } from '../../main/nosVoiceRoleBridge';
import { GenerateHat } from '../../main/avatarGenerator';
import { findSnrCosmeticFile, type SnrCosmeticPart } from '../../main/snrCosmetics';
import { verifyRemoteDebugPassword } from '../../main/remoteDebugAuth';
import { setVoiceDebugEnabled } from '../../main/GameReader';
import { readDebugLog } from './logger';
import { checkPlayerBan, managePlayerBans } from '../../main/playerBans';
import { findSnrBundledCosmeticFile } from '../../main/snrBundleCosmeticsClient';
import releaseBase from '../../../src-tauri/release-base.json';

// Window objects only route messages to the Rust host.
global.mainWindow = new WorkerWindow('main') as never;
global.settingsWindow = new WorkerWindow('settings') as never;
global.lobbyBrowser = new WorkerWindow('lobbies') as never;
global.debugWindow = new WorkerWindow('debug') as never;
global.overlay = new WorkerWindow('overlay') as never;
global.playerHistoryWindow = new WorkerWindow('player-history') as never;
initializeIpcListeners();
initializeIpcHandlers();
initSettingsIpc();
const voiceRoleSender = registerNosVoiceRoleBridge(
	ipcMain as never,
	() => ({ pid: gameReader?.pid ?? 0, state: gameReader?.amongUs ? gameReader.lastState : undefined }),
	(id) => id === 1,
	onGameStateChanged
);

ipcMain.on('OPEN_SETTINGS', () => {
	control('open', 'settings');
	notifySettingsWindowPresence();
});
ipcMain.on('OPEN_LOBBYBROWSER', () => control('open', 'lobbies'));
ipcMain.on('setAlwaysOnTop', (_event, enabled) => control('alwaysOnTop', 'main', !!enabled));
ipcMain.on('enableOverlay', (_event, enabled) => control('overlay', 'overlay', !!enabled));
ipcMain.handle('tauri:ping', () => ({
	runtime: process.release.name,
	electron: !!process.versions.electron,
	version: app.getVersion(),
	pid: process.pid,
	baseVersion: releaseBase.baseVersion,
	baseTag: releaseBase.tag,
	baseCommit: releaseBase.commit,
}));
ipcMain.handle('tauri:snr-worker-probe', () =>
	findSnrBundledCosmeticFile(
		join(app.getPath('userData'), '__tauri_test_no_game__.exe'),
		'__tauri_test_no_cosmetic__',
		'visor',
		join(app.getPath('userData'), 'snr-cosmetics-cache')
	)
);
ipcMain.handle('tauri:attachments', async (_event, paths: unknown) => {
	if (!Array.isArray(paths) || paths.length > 10 || !paths.every((p) => typeof p === 'string'))
		throw new Error('Invalid selection');
	return Promise.all(
		paths.map(async (path: string) => {
			const info = await stat(path);
			if (!info.isFile()) throw new Error('Invalid file');
			return { path, name: basename(path), size: info.size };
		})
	);
});

// Electron update metadata must never be used to install over the Tauri beta.
const updaterState = {
	state: 'error',
	error: 'Tauriベータ版は手動更新です。Tauri版のインストーラーで更新してください。',
};
ipcMain.handle('updater:get-state', () => updaterState);
for (const channel of ['updater:check', 'update-app', 'RESTART_AND_UPDATE']) {
	ipcMain.on(channel, (event) => event.reply('AUTO_UPDATER_STATE', updaterState));
}

let debugAuthorized = false;
let nextDebugAttempt = 0;
ipcMain.handle('OPEN_DEBUG', async (event, password) => {
	if (event.sender.id !== 2 || Date.now() < nextDebugAttempt) return 'denied';
	nextDebugAttempt = Date.now() + 10000;
	const result = await verifyRemoteDebugPassword(password, process.env.TANUKI_DEBUG_AUTH_URL || '', fetch);
	if (result === 'authorized') {
		debugAuthorized = true;
		setVoiceDebugEnabled(true);
		control('open', 'debug');
		notifySettingsWindowPresence();
	}
	return result;
});
ipcMain.handle('debug:get-logs', (event) => (event.sender.id === 4 && debugAuthorized ? readDebugLog() : ''));
ipcMain.handle('player-bans:check', (event, ...args) =>
	event.sender.id === 1 ? checkPlayerBan(...(args as [unknown, unknown, unknown, unknown]), fetch) : 'unavailable'
);
ipcMain.handle('debug:player-bans', (event, payload) =>
	debugAuthorized && (event.sender.id === 4 || event.sender.id === 6)
		? managePlayerBans(payload, fetch)
		: { error: 'デバッグ画面から操作してください。' }
);
ipcMain.handle('OPEN_PLAYER_HISTORY', (event) => {
	if (event.sender.id === 4 && debugAuthorized) control('open', 'player-history');
});
ipcMain.handle('tauri:save-log', async (event, destination) => {
	if (event.sender.id !== 4 || !debugAuthorized || typeof destination !== 'string') throw new Error('Not authorized');
	await writeFile(destination, await readDebugLog(), 'utf8');
	return { status: 'saved' };
});

async function asset(scheme: string, rawPath: string, query: string): Promise<string> {
	const path = rawPath.replace(/^\/+/, '');
	const params = new URLSearchParams(query);
	let bytes: Buffer;
	switch (scheme) {
		case 'static': {
			const root = resolve(app.getPath('userData'), 'static', 'generated');
			const file = resolve(app.getPath('userData'), 'static', decodeURIComponent(path));
			const rel = relative(root, file);
			if (!rel || rel.startsWith('..') || /^[A-Za-z]:/.test(rel) || !/\.png$/i.test(file))
				throw new Error('Invalid asset');
			bytes = await readFile(file);
			break;
		}
		case 'nos-cosmetic': {
			if (!gameReader || gameReader.loadedMod.id !== 'NoS' || !path.startsWith('image/'))
				throw new Error('No NoS asset');
			gameReader.nosContents.update(join(gameReader.gamePath, '..'));
			const image = await gameReader.nosContents.image(path.slice(6), params.get('color') ?? '');
			if (!image) throw new Error('Missing asset');
			bytes = Buffer.from(image);
			break;
		}
		case 'snr-cosmetic': {
			const slash = path.indexOf('/');
			const part = path.slice(0, slash) as SnrCosmeticPart;
			if (
				!gameReader ||
				gameReader.loadedMod.id !== 'SUPER_NEW_ROLES' ||
				!['hat-front', 'hat-back', 'visor', 'skin'].includes(part)
			)
				throw new Error('Invalid cosmetic');
			let file = findSnrCosmeticFile(gameReader.gamePath, decodeURIComponent(path.slice(slash + 1)), part);
			if (!file)
				file = await findSnrBundledCosmeticFile(
					gameReader.gamePath,
					decodeURIComponent(path.slice(slash + 1)),
					part,
					join(app.getPath('userData'), 'snr-cosmetics-cache')
				);
			if (!file) throw new Error('Missing cosmetic');
			if (params.get('adaptive') === '1')
				file = await GenerateHat(pathToFileURL(file), gameReader.playercolors, Number(params.get('color')));
			if (!file) throw new Error('Missing generated cosmetic');
			bytes = await readFile(file);
			break;
		}
		case 'generate': {
			const url = new URL(params.get('url') || '');
			const allowedCollection =
				(url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/gh/OhMyGuus/BetterCrewLink-Hats@master/')) ||
				(url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/OhMyGuus/BetterCrewLink-Hats/'));
			if (url.protocol !== 'https:' || !allowedCollection || url.username || url.password)
				throw new Error('Invalid hat collection');
			if (!gameReader) throw new Error('No game');
			const file = await GenerateHat(url, gameReader.playercolors, Number(params.get('color')));
			if (!file) throw new Error('Missing generated hat');
			bytes = await readFile(file);
			break;
		}
		default:
			throw new Error('Unknown asset scheme');
	}
	if (bytes.length > 8 * 1024 * 1024) throw new Error('Asset too large');
	return bytes.toString('base64');
}

async function request(message: {
	id: number;
	target: string;
	channel: string;
	args: unknown[];
	mode: string;
}): Promise<unknown> {
	if (message.channel === '__asset') return asset(...(message.args as [string, string, string]));
	if (message.channel === '__window_state') {
		setWindowOpen(message.target, message.args[0] === true);
		notifySettingsWindowPresence();
		return null;
	}
	const event = makeEvent(message.target);
	if (message.mode === 'invoke') {
		const handler = handlers.get(message.channel);
		if (!handler) throw new Error(`Unsupported request: ${message.channel}`);
		return handler(event, ...message.args);
	}
	if (ipcMain.listenerCount(message.channel) === 0) throw new Error(`Unsupported message: ${message.channel}`);
	ipcMain.emit(message.channel, event, ...message.args);
	return event.returnValue;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
	let message: Parameters<typeof request>[0];
	try {
		message = JSON.parse(line);
		if (!Number.isSafeInteger(message.id) || !Array.isArray(message.args)) throw new Error('Invalid request');
	} catch {
		return;
	}
	void request(message).then(
		(value) => writeFrame({ type: 'response', id: message.id, value: value ?? null }),
		(error) =>
			writeFrame({ type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) })
	);
});
input.on('close', () => {
	voiceRoleSender?.close();
	process.exit(0);
});
writeFrame({ type: 'ready', version: app.getVersion() });
