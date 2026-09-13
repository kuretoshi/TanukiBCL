import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main.js';
import { open } from 'fs/promises';
import { join as joinPath } from 'path';
import { getAppArgs } from './args';

const args = getAppArgs();
let debugLoggingEnabled =
	process.env.BETTERCREWLINK_LOG === '1' ||
	process.env.BETTERCREWLINK_DEBUG_LOG === '1' ||
	args.log ||
	args['debug-log'] ||
	args.debugLog ||
	/debug/i.test(process.execPath);

const logFilePath = joinPath(app.getPath('userData'), 'logs', 'debug.log');

export function isDebugLoggingEnabled() {
	return debugLoggingEnabled;
}

export function setDebugLoggingEnabled(enabled: boolean): void {
	debugLoggingEnabled = enabled;
	log.transports.file.level = enabled ? 'debug' : 'warn';
}

export function initializeDebugLogging() {
	log.transports.file.level = debugLoggingEnabled ? 'debug' : 'warn';
	log.transports.file.resolvePathFn = () => logFilePath;
	log.transports.console.level = false;
	Object.assign(console, log.functions);

	console.log(
		debugLoggingEnabled ? 'Debug logging enabled:' : 'Support logging enabled:',
		log.transports.file.getFile().path
	);
}

export async function readDebugLog(): Promise<string> {
	try {
		const file = await open(logFilePath, 'r');
		try {
			const { size } = await file.stat();
			const buffer = Buffer.alloc(Math.min(size, 65536));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
			return buffer.subarray(0, bytesRead).toString('utf8');
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		return String(error);
	}
}
export function getLogFilePaths() {
	return [logFilePath];
}

export function registerWindowLogging(window: BrowserWindow, name: string) {
	window.webContents.on('console-message', (event) => {
		const logLevel = event.level === 'warning' ? 'warn' : event.level;
		if (!debugLoggingEnabled && logLevel !== 'warn' && logLevel !== 'error') {
			return;
		}
		log[logLevel](
			`[renderer:${name}] ${event.message}`,
			event.sourceId ? `(${event.sourceId}:${event.lineNumber})` : ''
		);
	});

	(
		window.webContents as Electron.WebContents & {
			on(event: 'crashed', listener: () => void): Electron.WebContents;
		}
	).on('crashed', () => {
		log.error(`[renderer:${name}] crashed`);
	});
}
