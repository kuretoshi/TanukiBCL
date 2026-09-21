import electronUpdater from 'electron-updater';
import { readSnrRoles } from './snrRoleReader';
import { verifyDebugPassword } from './debugAuth';
import { setVoiceDebugEnabled } from './GameReader';
import { app, BrowserWindow, ipcMain, session, net, protocol, dialog } from 'electron';
import { copyFile } from 'node:fs/promises';
import windowStateKeeper from 'electron-window-state';
import { platform } from 'os';
import { join as joinPath } from 'path';
import { pathToFileURL } from 'url';
import './hook';
import overlayWindowModule from 'electron-overlay-window';
const { overlayWindow } = overlayWindowModule;
import { initializeIpcHandlers, initializeIpcListeners } from './ipc-handlers';
import { AutoUpdaterState, IpcRendererMessages, IpcHandlerMessages } from '../common/ipc-messages';
import { ProgressInfo, UpdateInfo } from 'builder-util-runtime';
import { initSettingsIpc } from './settingsStore';
const { autoUpdater } = electronUpdater;
import Store from 'electron-store';
import { ISettings } from '../common/ISettings';
import { getVariantStoreName } from '../common/appVariant';
import { gameReader } from './hook';
import { GenerateHat } from './avatarGenerator';
import { getAppArgs } from './args';
import {
	initializeDebugLogging,
	registerWindowLogging,
	isDebugLoggingEnabled,
	setDebugLoggingEnabled,
	readDebugLog,
	getLogFilePaths,
} from './logger';
const args = getAppArgs();
const debugLoggingAtStartup = !!isDebugLoggingEnabled();

const isDevelopment = !app.isPackaged;
const rawAppVersion: string = isDevelopment ? 'DEV' : autoUpdater.currentVersion.version;
const appVersion: string = rawAppVersion;
const displayAppVersion: string = rawAppVersion === '3.1.6-20' ? '3.1.6-2' : rawAppVersion;
const isLiteApp =
	process.env.BETTERCREWLINK_LITE === '1' || /lite/i.test(process.execPath) || /lite/i.test(app.getName());
const devTools = !isLiteApp && (isDevelopment || args.dev === 1);
const appDisplayName = isLiteApp ? 'タヌキのベタクルLite' : 'タヌキのベタクル';
const internalAppName = isLiteApp ? 'TanukiBCLLite' : 'TanukiBCL';
app.setName(appDisplayName);
app.setAppUserModelId(isLiteApp ? 'net.ottomated.crewlinkkai.lite' : 'net.ottomated.crewlinkkai.beta.local');
initializeDebugLogging();
if (isLiteApp) {
	autoUpdater.setFeedURL({
		provider: 'generic',
		url: 'https://github.com/kuretoshi/BetterCrewLink/releases/latest/download',
		channel: 'lite',
	});
}
const overlayTargetName = String(
	process.env.BETTERCREWLINK_TARGET_NAME ||
		args['target-name'] ||
		args.targetName ||
		args['target-window'] ||
		args.targetWindow ||
		'Among Us'
);
let overlayRequested = false;
let overlayTimer: ReturnType<typeof setTimeout> | undefined;
const allowMultiInstance =
	args['multi-instance'] === true ||
	args.multiInstance === true ||
	process.env.BETTERCREWLINK_ALLOW_MULTI_INSTANCE === '1' ||
	/multi[-_ ]?instance/i.test(process.execPath);
const voiceDebugEnabled =
	process.env.BETTERCREWLINK_DEBUG_OVERLAY === '1' ||
	args['debug-voice'] ||
	args.debugVoice ||
	/debug/i.test(process.execPath);
let latestAutoUpdaterState: AutoUpdaterState = { state: 'idle' };
let checkingForUpdates = false;
let acceptedUpdateInfo: UpdateInfo | null = null;
let updateInstallRequested = false;

declare global {
	var mainWindow: BrowserWindow | null;
	var overlay: BrowserWindow | null;
	var lobbyBrowser: BrowserWindow | null;
	var settingsWindow: BrowserWindow | null;
	var inquiryWindow: BrowserWindow | null;
	var debugWindow: BrowserWindow | null;
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: 'static',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
	{
		scheme: 'generate',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
	{
		scheme: 'app',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
]);

// global reference to mainWindow (necessary to prevent window from being garbage collected)
global.mainWindow = null;
global.overlay = null;
global.settingsWindow = null;
global.lobbyBrowser = null;
global.inquiryWindow = null;
global.debugWindow = null;
const store = new Store<ISettings>({ name: getVariantStoreName() });
let isQuitting = false;
app.commandLine.appendSwitch('disable-pinch');

if (isLiteApp || platform() === 'linux' || !store.get('hardware_acceleration', true)) {
	app.disableHardwareAcceleration();
}

if (platform() === 'linux') {
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

function closeAppWindows() {
	overlayRequested = false;
	clearTimeout(overlayTimer);
	try {
		overlayWindow.stop();
	} catch {
		/* empty */
	}

	const windows = [
		global.debugWindow,
		global.inquiryWindow,
		global.settingsWindow,
		global.lobbyBrowser,
		global.overlay,
		global.mainWindow,
	];
	global.debugWindow = null;
	global.inquiryWindow = null;
	global.settingsWindow = null;
	global.lobbyBrowser = null;
	global.overlay = null;
	global.mainWindow = null;

	for (const window of windows) {
		try {
			if (window && !window.isDestroyed()) {
				window.removeAllListeners('closed');
				window.destroy();
			}
		} catch {
			/* empty */
		}
	}
}

function sendAutoUpdaterState(state: AutoUpdaterState) {
	latestAutoUpdaterState = {
		...state,
		info:
			state.info ??
			(['downloading', 'downloaded'].includes(state.state) ? (acceptedUpdateInfo ?? undefined) : undefined),
	};
	for (const window of [global.mainWindow, global.settingsWindow]) {
		if (window && !window.isDestroyed())
			window.webContents.send(IpcRendererMessages.AUTO_UPDATER_STATE, latestAutoUpdaterState);
	}
}

function sendAutoUpdaterError(err: Error | unknown) {
	acceptedUpdateInfo = null;
	updateInstallRequested = false;
	sendAutoUpdaterState({ state: 'error', error: err instanceof Error ? err.message : String(err) });
}

function parseVersion(version: string): number[] {
	const normalized = version.replace(/^v/i, '').trim();
	const [main, prerelease = ''] = normalized.split('-', 2);
	const parts = main.split('.').map((part) => Number(part.replace(/\D/g, '')) || 0);
	while (parts.length < 3) {
		parts.push(0);
	}
	const numericPrerelease = prerelease.match(/\d+/);
	parts.push(numericPrerelease ? Number(numericPrerelease[0]) : 0);
	return parts;
}

function compareVersions(a: string, b: string): number {
	const aParts = parseVersion(a);
	const bParts = parseVersion(b);
	const length = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < length; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function isRemoteVersionNewer(info: UpdateInfo): boolean {
	return compareVersions(info.version, rawAppVersion) > 0;
}

async function checkForUpdates() {
	if (checkingForUpdates || updateInstallRequested) return;
	if (isDevelopment) {
		sendAutoUpdaterError(new Error('開発モードではアップデートを確認できません。配布版で確認してください。'));
		return;
	}
	checkingForUpdates = true;
	acceptedUpdateInfo = null;
	sendAutoUpdaterState({ state: 'checking' });
	try {
		const result = await autoUpdater.checkForUpdates();
		if (!result) sendAutoUpdaterError(new Error('アップデートを確認できませんでした。'));
	} catch (error) {
		sendAutoUpdaterError(error);
	} finally {
		checkingForUpdates = false;
	}
}

const preload = () => joinPath(import.meta.dirname, '../preload/index.mjs');
function loadView(window: BrowserWindow, view: string) {
	const query = new URLSearchParams({
		view,
		version: displayAppVersion,
		lite: isLiteApp ? '1' : '0',
		debugVoice: voiceDebugEnabled ? '1' : '0',
	});
	const base =
		isDevelopment && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : 'app://bundle/index.html';
	void window.loadURL(base + '?' + query.toString());
}
function createMainWindow() {
	const mainWindowState = windowStateKeeper({});

	const window = new BrowserWindow({
		title: appDisplayName,
		width: 280,
		height: 390,
		minWidth: 280,
		minHeight: 390,
		x: mainWindowState.x,
		y: mainWindowState.y,
		resizable: true,
		frame: false,
		fullscreenable: false,
		maximizable: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
	});
	mainWindowState.manage(window);
	registerWindowLogging(window, 'main');

	if (devTools) {
		//Force devtools into detached mode otherwise they are unusable
		window.on('ready-to-show', () => {
			window.webContents.openDevTools({
				mode: 'detach',
			});
		});
	}

	loadView(window, 'app');
	//window.webContents.userAgent = `CrewLink/${crewlinkVersion} (${process.platform})`;
	window.webContents.userAgent = `${internalAppName}/${appVersion} (${process.platform})`;
	window.webContents.once('did-finish-load', () => {
		if (latestAutoUpdaterState.state !== 'unavailable') {
			sendAutoUpdaterState(latestAutoUpdaterState);
		}
	});

	window.on('close', () => {
		if (!isQuitting) {
			isQuitting = true;
			setImmediate(() => app.quit());
		}
	});

	window.on('closed', () => {
		closeAppWindows();
	});

	window.webContents.on('devtools-opened', () => {
		window.focus();
		setImmediate(() => {
			window.focus();
		});
	});
	console.log('Opened app version: ', appVersion);
	return window;
}

function createLobbyBrowser() {
	const window = new BrowserWindow({
		title: `${appDisplayName} Browser`,
		width: 900,
		height: 500,
		minWidth: 250,
		minHeight: 350,
		resizable: true,
		frame: false,
		fullscreenable: false,
		closable: true,
		maximizable: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
	});

	window.on('closed', () => {
		global.lobbyBrowser = null;
	});
	registerWindowLogging(window, 'lobbies');
	// if (devTools) {
	// 	// Force devtools into detached mode otherwise they are unusable
	// 	window.webContents.openDevTools({
	// 		mode: 'detach',
	// 	});
	// }
	loadView(window, 'lobbies');
	window.webContents.userAgent = `${internalAppName}/${appVersion} (${process.platform})`;
	console.log('Opened app version: ', appVersion);
	return window;
}

function createSettingsWindow() {
	const settingsWindowState = windowStateKeeper({
		file: 'settings-window-state.json',
		defaultWidth: 750,
		defaultHeight: 630,
	});

	const window = new BrowserWindow({
		title: isLiteApp ? 'TanukiBCL Lite Settings' : 'TanukiBCL Settings',
		width: settingsWindowState.width,
		height: settingsWindowState.height,
		x: settingsWindowState.x,
		y: settingsWindowState.y,
		minWidth: 620,
		minHeight: 440,
		backgroundColor: '#25232a',
		resizable: true,
		frame: false,
		fullscreenable: false,
		closable: true,
		maximizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
	});
	settingsWindowState.manage(window);

	if (devTools) {
		window.webContents.openDevTools({ mode: 'detach' });
	}

	window.once('ready-to-show', () => window.show());
	window.on('closed', () => {
		global.settingsWindow = null;
	});

	loadView(window, 'settings');
	return window;
}

function createDebugWindow() {
	setVoiceDebugEnabled(true);
	setDebugLoggingEnabled(true);
	const debugWindowState = windowStateKeeper({
		file: 'debug-window-state.json',
		defaultWidth: 900,
		defaultHeight: 680,
	});

	const window = new BrowserWindow({
		title: isLiteApp ? 'TanukiBCL Lite Debug' : 'TanukiBCL Debug',
		width: debugWindowState.width,
		height: debugWindowState.height,
		x: debugWindowState.x,
		y: debugWindowState.y,
		minWidth: 620,
		minHeight: 440,
		backgroundColor: '#25232a',
		resizable: true,
		frame: false,
		fullscreenable: false,
		closable: true,
		maximizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
	});
	debugWindowState.manage(window);
	registerWindowLogging(window, 'debug');

	window.once('ready-to-show', () => window.show());
	window.on('closed', () => {
		global.debugWindow = null;
		setVoiceDebugEnabled(!!voiceDebugEnabled);
		setDebugLoggingEnabled(debugLoggingAtStartup || !!voiceDebugEnabled);
	});

	loadView(window, 'debug');
	return window;
}

function createInquiryWindow() {
	const inquiryWindowState = windowStateKeeper({
		file: 'inquiry-window-state.json',
		defaultWidth: 620,
		defaultHeight: 640,
	});

	const window = new BrowserWindow({
		title: isLiteApp ? 'TanukiBCL Lite Inquiry' : 'TanukiBCL Inquiry',
		width: inquiryWindowState.width,
		height: inquiryWindowState.height,
		x: inquiryWindowState.x,
		y: inquiryWindowState.y,
		minWidth: 460,
		minHeight: 480,
		backgroundColor: '#25232a',
		resizable: true,
		frame: false,
		fullscreenable: false,
		closable: true,
		maximizable: true,
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
	});
	inquiryWindowState.manage(window);

	if (devTools) {
		window.webContents.openDevTools({ mode: 'detach' });
	}

	window.once('ready-to-show', () => window.show());
	window.on('close', (event) => {
		if (!isQuitting) {
			event.preventDefault();
			window.hide();
		}
	});
	window.on('closed', () => {
		global.inquiryWindow = null;
	});

	loadView(window, 'inquiry');
	return window;
}

function createOverlay() {
	const overlay = new BrowserWindow({
		title: `${appDisplayName} Overlay`,
		width: 400,
		height: 300,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			preload: preload(),
		},
		fullscreenable: true,
		skipTaskbar: true,
		frame: false,
		show: false,
		transparent: true,
		resizable: true,
		focusable: false,

		//	...overlayWindow.WINDOW_OPTS,
	});
	registerWindowLogging(overlay, 'overlay');

	if (devTools) {
		overlay.webContents.openDevTools({
			mode: 'detach',
		});
	}

	loadView(overlay, 'overlay');
	overlay.setIgnoreMouseEvents(true);
	overlayWindow.attachTo(overlay, overlayTargetName);
	overlay.setBackgroundColor('#00000000');
	return overlay;
}

function showOverlayWithRetry(attempt = 0) {
	if (!overlayRequested || isQuitting) return;
	try {
		if (!global.overlay || global.overlay.isDestroyed()) {
			global.overlay = createOverlay();
		}
		overlayWindow.show();
	} catch (exception) {
		console.log('Overlay show failed:', exception);
		if (attempt < 8) {
			overlayTimer = setTimeout(() => showOverlayWithRetry(attempt + 1), 750);
			return;
		}
		hideOverlay();
	}
}

function hideOverlay() {
	clearTimeout(overlayTimer);
	overlayTimer = undefined;
	try {
		overlayWindow.hide();
	} catch (exception) {
		console.log('Overlay hide failed:', exception);
	}
	try {
		overlayWindow.stop();
	} catch (exception) {
		console.log('Overlay stop failed:', exception);
	}
	try {
		if (global.overlay && !global.overlay.isDestroyed()) global.overlay.destroy();
	} finally {
		global.overlay = null;
	}
}

function setOverlayEnabled(enable: boolean) {
	overlayRequested = enable;
	clearTimeout(overlayTimer);
	if (enable) {
		overlayTimer = setTimeout(() => showOverlayWithRetry(), 1000);
	} else {
		hideOverlay();
	}
}

const gotTheLock = allowMultiInstance || app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	if (isLiteApp) {
		autoUpdater.channel = 'lite';
	}
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.allowDowngrade = false;
	autoUpdater.allowPrerelease = true;
	autoUpdater.on('update-available', (info: UpdateInfo) => {
		if (!isRemoteVersionNewer(info)) {
			acceptedUpdateInfo = null;
			sendAutoUpdaterState({
				state: 'unavailable',
			});
			return;
		}
		acceptedUpdateInfo = info;
		updateInstallRequested = false;
		sendAutoUpdaterState({
			state: 'available',
			info: info,
		});
	});
	autoUpdater.on('update-not-available', () => {
		acceptedUpdateInfo = null;
		updateInstallRequested = false;
		sendAutoUpdaterState({
			state: 'unavailable',
		});
	});
	autoUpdater.on('error', (err: Error) => {
		sendAutoUpdaterError(err);
	});
	autoUpdater.on('download-progress', (progress: ProgressInfo) => {
		sendAutoUpdaterState({
			state: 'downloading',
			progress,
		});
	});
	autoUpdater.on('update-downloaded', () => {
		if (!acceptedUpdateInfo || !isRemoteVersionNewer(acceptedUpdateInfo)) {
			sendAutoUpdaterState({
				state: 'unavailable',
			});
			return;
		}
		sendAutoUpdaterState({
			state: 'downloaded',
		});
		if (updateInstallRequested) {
			autoUpdater.quitAndInstall();
		}
	});

	app.on('before-quit', () => {
		isQuitting = true;
		closeAppWindows();
	});

	// quit application when all windows are closed
	app.on('window-all-closed', () => {
		// on macOS it is common for applications to stay open until the user explicitly quits
		closeAppWindows();
		app.quit();
	});

	app.on('activate', () => {
		console.log('ACTIVATE???');
		// on macOS it is common to re-create a window even after all windows have been closed
		if (global.mainWindow === null) {
			global.mainWindow = createMainWindow();
			if (isDevelopment && !global.debugWindow && (voiceDebugEnabled || isDebugLoggingEnabled()))
				global.debugWindow = createDebugWindow();
		}

		session.fromPartition('default').setPermissionRequestHandler((webContents, permission, callback) => {
			const allowedPermissions = ['audioCapture']; // Full list here: https://developer.chrome.com/extensions/declare_permissions#manifest
			console.log('permission requested ', permission);
			if (allowedPermissions.includes(permission)) {
				callback(true); // Approve permission request
			} else {
				console.error(
					`The application tried to request permission for '${permission}'. This permission was not whitelisted and has been blocked.`
				);

				callback(false); // Deny
			}
		});
	});

	// create main BrowserWindow when electron is ready
	app.whenReady().then(async () => {
		protocol.handle('static', (request) => {
			const url = new URL(request.url);
			const filePath = app.getPath('userData') + '/static/' + decodeURIComponent(url.host + url.pathname);
			return net.fetch(pathToFileURL(filePath).toString());
		});

		protocol.handle('generate', async (request) => {
			const requestUrl = new URL(request.url);
			const imagePath = new URL(requestUrl.searchParams.get('url')!);
			const filePath = await GenerateHat(
				imagePath,
				gameReader.playercolors,
				Number(requestUrl.searchParams.get('color'))
			);
			return net.fetch(pathToFileURL(filePath).toString());
		});

		protocol.handle('app', (request) => {
			const { pathname } = new URL(request.url);
			const filePath = joinPath(import.meta.dirname, '../renderer', decodeURIComponent(pathname));
			return net.fetch(pathToFileURL(filePath).toString());
		});

		initializeIpcListeners();
		initializeIpcHandlers();
		initSettingsIpc();
		global.mainWindow = createMainWindow();
		if (isDevelopment && (voiceDebugEnabled || isDebugLoggingEnabled())) global.debugWindow = createDebugWindow();

		if (isDevelopment && !isLiteApp) {
			const { installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
			installExtension(REACT_DEVELOPER_TOOLS)
				.then((name) => console.log(`Added Extension:  ${name}`))
				.catch((err: string) => console.log('An error occurred: ', err));
		}
	});

	app.on('second-instance', () => {
		// Someone tried to run a second instance, we should focus our window.
		if (global.mainWindow) {
			if (global.mainWindow.isMinimized()) global.mainWindow.restore();
			global.mainWindow.focus();
		}
	});

	ipcMain.handle('updater:get-state', () => latestAutoUpdaterState);
	ipcMain.on('updater:check', () => {
		void checkForUpdates();
	});
	ipcMain.on('update-app', () => {
		if (
			checkingForUpdates ||
			updateInstallRequested ||
			!['available', 'downloaded'].includes(latestAutoUpdaterState.state)
		)
			return;
		if (!acceptedUpdateInfo || !isRemoteVersionNewer(acceptedUpdateInfo)) {
			sendAutoUpdaterState({
				state: 'unavailable',
			});
			return;
		}
		updateInstallRequested = true;
		if (latestAutoUpdaterState.state === 'downloaded') {
			autoUpdater.quitAndInstall();
			return;
		}
		sendAutoUpdaterState({ state: 'downloading' });
		autoUpdater.downloadUpdate().catch(sendAutoUpdaterError);
	});

	ipcMain.handle('debug:get-logs', (event) => {
		if (event.sender !== global.debugWindow?.webContents) return '';
		return readDebugLog();
	});
	let readingSnrRoles = false;
	ipcMain.handle('debug:snr-roles', async (event) => {
		if (event.sender !== global.debugWindow?.webContents) return { status: 'error', message: '開発者認証が必要です。' };
		if (readingSnrRoles) return { status: 'error', message: '取得中です。' };
		if (!gameReader.amongUs || gameReader.loadedMod.id !== 'SUPER_NEW_ROLES')
			return { status: 'error', message: 'SuperNewRolesの起動を確認してください。' };
		const pid = gameReader.pid;
		readingSnrRoles = true;
		try {
			const result = await readSnrRoles(pid);
			if (!gameReader.amongUs || gameReader.pid !== pid)
				return { status: 'error', message: '取得中にゲームが終了または切り替わりました。' };
			console.log('[SNR roles]', JSON.stringify({ pid, result }));
			gameReader.acceptSnrRoles(pid, result);
			if ((result as { status?: string }).status === 'error')
				console.warn('[SNR roles] 取得失敗', JSON.stringify({ pid, result }));
			return result;
		} finally {
			readingSnrRoles = false;
		}
	});
	let savingDebugLog = false;
	ipcMain.handle('debug:save-log', async (event) => {
		const window = global.debugWindow;
		if (!window || event.sender !== window.webContents || savingDebugLog) return { status: 'cancelled' };
		savingDebugLog = true;
		try {
			const { canceled, filePath } = await dialog.showSaveDialog(window, {
				title: 'デバッグログを保存',
				defaultPath: joinPath(
					app.getPath('documents'),
					`TanukiBCL-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
				),
				filters: [{ name: 'ログファイル', extensions: ['log'] }],
			});
			if (canceled || !filePath) return { status: 'cancelled' };
			await copyFile(getLogFilePaths()[0], filePath);
			return { status: 'saved' };
		} catch {
			return { status: 'error' };
		} finally {
			savingDebugLog = false;
		}
	});
	let nextDebugAttempt = 0;
	ipcMain.handle('OPEN_DEBUG', (event, password: unknown) => {
		if (event.sender !== global.settingsWindow?.webContents || Date.now() < nextDebugAttempt) return false;
		nextDebugAttempt = Date.now() + 1000;
		if (!verifyDebugPassword(password)) return false;
		if (!global.debugWindow) global.debugWindow = createDebugWindow();
		else {
			if (global.debugWindow.isMinimized()) global.debugWindow.restore();
			global.debugWindow.show();
			global.debugWindow.focus();
		}
		return true;
	});
	ipcMain.on('OPEN_INQUIRY', () => {
		if (!global.inquiryWindow) global.inquiryWindow = createInquiryWindow();
		else {
			if (global.inquiryWindow.isMinimized()) global.inquiryWindow.restore();
			global.inquiryWindow.show();
			global.inquiryWindow.focus();
		}
	});
	ipcMain.on(IpcHandlerMessages.OPEN_SETTINGS, () => {
		if (!global.settingsWindow) {
			global.settingsWindow = createSettingsWindow();
		} else {
			if (global.settingsWindow.isMinimized()) global.settingsWindow.restore();
			global.settingsWindow.show();
			global.settingsWindow.focus();
		}
	});

	ipcMain.on(IpcHandlerMessages.OPEN_LOBBYBROWSER, () => {
		if (isLiteApp) {
			return;
		}
		if (!global.lobbyBrowser) {
			global.lobbyBrowser = createLobbyBrowser();
		} else {
			global.lobbyBrowser.show();
			global.lobbyBrowser.moveTop();
		}
	});

	ipcMain.on('enableOverlay', (_event, enable: boolean) => {
		setOverlayEnabled(enable);
	});

	ipcMain.on('setAlwaysOnTop', async (_event, enable) => {
		console.log('SETALWAYSONTOP?');
		if (global.mainWindow) {
			console.log('SETALWAYSONTOP?1');
			global.mainWindow.setAlwaysOnTop(enable, 'screen-saver');
		}
	});
}
