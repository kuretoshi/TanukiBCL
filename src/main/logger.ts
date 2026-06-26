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

export function isDebugLoggingEnabled() {
	return debugLoggingEnabled;
}

export function initializeDebugLogging() {
	if (!debugLoggingEnabled) {
		return;
	}

	log.transports.file.level = 'debug';
	log.transports.file.resolvePath = () => joinPath(app.getPath('userData'), 'logs', 'debug.log');
	log.transports.console.level = false;
	Object.assign(console, log.functions);

	console.log('Debug logging enabled:', log.transports.file.getFile().path);
}

export function registerWindowLogging(window: BrowserWindow, name: string) {
	if (!debugLoggingEnabled) {
		return;
	}

	window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
		const logLevel = logLevels[level] || 'info';
		log[logLevel](`[renderer:${name}] ${message}`, sourceId ? `(${sourceId}:${line})` : '');
	});

	window.webContents.on('render-process-gone', (_event, details) => {
		log.error(`[renderer:${name}] ${details.reason}`, `exitCode=${details.exitCode}`);
	});
}
