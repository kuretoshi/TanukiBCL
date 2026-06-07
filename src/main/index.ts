'use strict'; // eslint-disable-line

import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { platform } from 'os';
import { join as joinPath } from 'path';
import { format as formatUrl } from 'url';
import './hook';
import { overlayWindow } from 'electron-overlay-window';
import { initializeIpcHandlers, initializeIpcListeners } from './ipc-handlers';
import { AutoUpdaterState, IpcRendererMessages, IpcHandlerMessages } from '../common/ipc-messages';
import { ProgressInfo, UpdateInfo } from 'builder-util-runtime';
import { protocol } from 'electron';
import Store from 'electron-store';
import { ISettings } from '../common/ISettings';
import { getVariantStoreName } from '../common/appVariant';
import { gameReader } from './hook';
import { GenerateHat } from './avatarGenerator';
const args = require('minimist')(process.argv); // eslint-disable-line
const isDevelopment = process.env.NODE_ENV !== 'production';
const rawAppVersion: string = isDevelopment ? 'DEV' : autoUpdater.currentVersion.version;
const appVersion: string = rawAppVersion;
const shouldCheckForUpdates = !isDevelopment;
const isLiteApp =
	process.env.BETTERCREWLINK_LITE === '1' ||
	/lite/i.test(process.execPath) ||
	/lite/i.test(app.getName());
const devTools = !isLiteApp && (isDevelopment || args.dev === 1);
const appDisplayName = isLiteApp ? 'タヌキのベタクルLite' : 'タヌキのベタクル';
const internalAppName = isLiteApp ? 'TanukiBCLLite' : 'TanukiBCL';
app.setName(appDisplayName);
app.setAppUserModelId(isLiteApp ? 'io.kuretoshi.tanukibcl.lite' : 'io.kuretoshi.tanukibcl');
if (isLiteApp) {
	autoUpdater.setFeedURL({
		provider: 'generic',
		url: 'https://github.com/kuretoshi/BetterCrewLink/releases/latest/download',
		channel: 'lite',
	});
}
const overlayTargetName = String(args['target-name'] || args.targetName || args['target-window'] || args.targetWindow || 'Among Us');
const allowMultiInstance =
	args['multi-instance'] === true ||
	args.multiInstance === true ||
	process.env.BETTERCREWLINK_ALLOW_MULTI_INSTANCE === '1' ||
	/multi[-_ ]?instance/i.test(process.execPath);
let latestAutoUpdaterState: AutoUpdaterState = { state: 'unavailable' };
let hasCheckedForUpdates = false;
let acceptedUpdateInfo: UpdateInfo | null = null;

declare global {
	var mainWindow: BrowserWindow | null;
	var overlay: BrowserWindow | null;
	var lobbyBrowser: BrowserWindow | null;
}
// global reference to mainWindow (necessary to prevent window from being garbage collected)
global.mainWindow = null;
global.overlay = null;
const store = new Store<ISettings>({ name: getVariantStoreName() });
let isQuitting = false;
app.commandLine.appendSwitch('disable-pinch');

if (isLiteApp || platform() === 'linux' || !store.get('hardware_acceleration', true)) {
	app.disableHardwareAcceleration();

}

if(platform() === 'linux'){
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

function closeAppWindows() {
	try {
		overlayWindow.stop();
	} catch {
		/* empty */
	}

	const windows = [global.lobbyBrowser, global.overlay, global.mainWindow];
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
	latestAutoUpdaterState = { ...latestAutoUpdaterState, ...state };
	try {
		global.mainWindow?.webContents.send(IpcRendererMessages.AUTO_UPDATER_STATE, latestAutoUpdaterState);
	} catch {
		/* empty */
	}
}

function isMissingUpdateMetadataError(err: Error | unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.includes('404') && (message.includes('latest.yml') || message.includes('lite.yml'));
}

function sendAutoUpdaterError(err: Error | unknown) {
	if (isMissingUpdateMetadataError(err)) {
		sendAutoUpdaterState({
			state: 'unavailable',
		});
		return;
	}

	sendAutoUpdaterState({
		state: 'error',
		error: err instanceof Error ? err.message : String(err),
	});
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

function checkForUpdates() {
	if (!shouldCheckForUpdates || hasCheckedForUpdates) {
		return;
	}

	hasCheckedForUpdates = true;
	autoUpdater.checkForUpdates().catch(sendAutoUpdaterError);
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
			nodeIntegration: true,
			contextIsolation: false
		},
	});
	mainWindowState.manage(window);

	if (devTools) {
		//Force devtools into detached mode otherwise they are unusable
		window.on('ready-to-show', () => {
			window.webContents.openDevTools({
				mode: 'detach',
			});
		})
	}

	if (isDevelopment) {
		window.loadURL(
			`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=DEV&view=app&lite=${isLiteApp ? '1' : '0'}`
		);
	} else {
		window.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'app',
					lite: isLiteApp ? '1' : '0',
				},
				slashes: true,
			})
		);
	}
	//window.webContents.userAgent = `CrewLink/${crewlinkVersion} (${process.platform})`;
	window.webContents.userAgent = `${internalAppName}/${appVersion} (${process.platform})`;
	window.webContents.once('did-finish-load', () => {
		if (latestAutoUpdaterState.state !== 'unavailable') {
			sendAutoUpdaterState(latestAutoUpdaterState);
		}
		checkForUpdates();
	});

	window.on('close', () => {
		if (!isQuitting) {
			isQuitting = true;
			setImmediate(() => app.quit());
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
			nodeIntegration: true,
			contextIsolation: false,
		},
	});

	window.on('closed', () => {
		global.lobbyBrowser = null;
	});
	// if (devTools) {
	// 	// Force devtools into detached mode otherwise they are unusable
	// 	window.webContents.openDevTools({
	// 		mode: 'detach',
	// 	});
	// }
	if (isDevelopment) {
		window.loadURL(
			`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=DEV&view=lobbies&lite=${isLiteApp ? '1' : '0'}`
		);
	} else {
		window.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'lobbies',
					lite: isLiteApp ? '1' : '0',
				},
				slashes: true,
			})
		);
	}
	window.webContents.userAgent = `${internalAppName}/${appVersion} (${process.platform})`;
	console.log('Opened app version: ', appVersion);
	return window;
}

function createOverlay() {
	const overlay = new BrowserWindow({
		title: `${appDisplayName} Overlay`,
		width: 400,
		height: 300,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
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

	if (devTools) {
		overlay.webContents.openDevTools({
			mode: 'detach',
		});
	}

	if (isDevelopment) {
		overlay.loadURL(
			`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=${appVersion}&view=overlay&lite=${isLiteApp ? '1' : '0'}`
		);
	} else {
		overlay.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'overlay',
					lite: isLiteApp ? '1' : '0',
				},
				slashes: true,
			})
		);
	}
	overlay.setIgnoreMouseEvents(true);
	overlayWindow.attachTo(overlay, overlayTargetName);
	overlay.setBackgroundColor('#00000000');
	return overlay;
}

const gotTheLock = allowMultiInstance || app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	if (isLiteApp) {
		autoUpdater.channel = 'lite';
	}
	autoUpdater.autoDownload = false;
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
		sendAutoUpdaterState({
			state: 'available',
			info: info,
		});
		if (isLiteApp) {
			autoUpdater.downloadUpdate().catch(sendAutoUpdaterError);
		}
	});
	autoUpdater.on('update-not-available', () => {
		acceptedUpdateInfo = null;
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
		autoUpdater.quitAndInstall();
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
		console.log("ACTIVATE???")
		// on macOS it is common to re-create a window even after all windows have been closed
		if (global.mainWindow === null) {
			global.mainWindow = createMainWindow();
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
	app.whenReady().then(() => {
		protocol.registerFileProtocol('static', (request, callback) => {
			const pathname = app.getPath('userData') + '/static/' + request.url.replace('static:///', '');
			callback(pathname);
		});

		protocol.registerFileProtocol('generate', async (request, callback) => {
			const url = new URL(request.url.replace('generate:///', ''));
			const path = await GenerateHat(url, gameReader.playercolors, Number(url.searchParams.get('color')), '');
			callback(path);
		});

		initializeIpcListeners();
		initializeIpcHandlers();
		global.mainWindow = createMainWindow();

		if (isDevelopment && !isLiteApp) {
			const { default: installExtension, REACT_DEVELOPER_TOOLS } = require('electron-devtools-installer');
			installExtension(REACT_DEVELOPER_TOOLS)
				.then((name: string) => console.log(`Added Extension:  ${name}`))
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

	ipcMain.on('update-app', () => {
		if (!acceptedUpdateInfo || !isRemoteVersionNewer(acceptedUpdateInfo)) {
			sendAutoUpdaterState({
				state: 'unavailable',
			});
			return;
		}
		autoUpdater.downloadUpdate().catch(sendAutoUpdaterError);
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

	ipcMain.on('enableOverlay', async (_event, enable) => {
		setTimeout(
			() => {

				try {
					if (enable) {
						if (!global.overlay) {
							global.overlay = createOverlay();
						}
						overlayWindow.show();
					} else {
						overlayWindow.hide();
						if (global.overlay?.closable) {
							overlayWindow.stop();
							global.overlay?.close();
							global.overlay = null;
						}
					}
				} catch (exception) {
					global.overlay?.hide();
					global.overlay?.close();
				}
			},
			1000
		)
	});

	ipcMain.on('setAlwaysOnTop', async (_event, enable) => {
		console.log("SETALWAYSONTOP?")
		if (global.mainWindow) {
			console.log("SETALWAYSONTOP?1")
			global.mainWindow.setAlwaysOnTop(enable, 'screen-saver');
		}
	});


}
