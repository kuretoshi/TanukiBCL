import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { join as joinPath } from 'path';
import { getAppArgs } from './args';

const args = getAppArgs();
const debugLoggingEnabled =
	process.env.BETTERCREWLINK_LOG === '1' ||
	process.env.BETTERCREWLINK_DEBUG_LOG === '1' ||
	args.log ||
	args['debug-log'] ||
	args.debugLog ||
	/debug/i.test(process.execPath);

const logLevels: Record<number, 'debug' | 'info' | 'warn' | 'error'> = {
	0: 'debug',
	1: 'info',
	2: 'warn',
	3: 'error',
};
const logFilePath = joinPath(app.getPath('userData'), 'logs', 'debug.log');

export function isDebugLoggingEnabled() {
	return debugLoggingEnabled;
}

export function initializeDebugLogging() {
	log.transports.file.level = debugLoggingEnabled ? 'debug' : 'warn';
	log.transports.file.resolvePath = () => logFilePath;
	log.transports.console.level = false;
	Object.assign(console, log.functions);

	console.log(
		debugLoggingEnabled ? 'Debug logging enabled:' : 'Support logging enabled:',
		log.transports.file.getFile().path
	);
}

export function getLogFilePaths() {
	return [logFilePath];
}

export function registerWindowLogging(window: BrowserWindow, name: string) {
	window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
		const logLevel = logLevels[level] || 'info';
		if (!debugLoggingEnabled && logLevel !== 'warn' && logLevel !== 'error') {
			return;
		}
		log[logLevel](`[renderer:${name}] ${message}`, sourceId ? `(${sourceId}:${line})` : '');
	});

	(window.webContents as Electron.WebContents & {
		on(event: 'crashed', listener: () => void): Electron.WebContents;
	}).on('crashed', () => {
		log.error(`[renderer:${name}] crashed`);
	});
}
