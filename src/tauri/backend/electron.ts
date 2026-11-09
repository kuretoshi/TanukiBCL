// Compatibility boundary for the existing game reader. This is bundled into a
// plain Node worker; it never loads Electron or creates browser windows.
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type Handler = (event: ReturnType<typeof makeEvent>, ...args: unknown[]) => unknown;
export const handlers = new Map<string, Handler>();
export const ipcMain = Object.assign(new EventEmitter(), {
	handle(channel: string, handler: Handler) {
		if (handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
		handlers.set(channel, handler);
	},
});

export function writeFrame(frame: Record<string, unknown>): void {
	process.stdout.write(
		JSON.stringify(frame, (_key, value) =>
			typeof value === 'string'
				? value.replace(/^(nos-cosmetic|snr-cosmetic|static|generate):\/\//, 'https://$1.localhost/')
				: value
		) + '\n'
	);
}

export function control(action: string, target = 'main', value?: unknown): void {
	if (action === 'open' || (action === 'overlay' && value === true)) setWindowOpen(target, true);
	writeFrame({ type: 'control', action, target, value });
}

const labels = ['main', 'settings', 'lobbies', 'debug', 'overlay', 'player-history'];
const windows = new Map<string, WorkerWindow>();
export class WorkerWindow {
	open: boolean;
	readonly webContents: {
		id: number;
		send: (channel: string, ...args: unknown[]) => void;
		isDestroyed: () => boolean;
		getURL: () => string;
	};
	constructor(readonly label: string) {
		if (!labels.includes(label)) throw new Error('Invalid window');
		this.open = label === 'main';
		this.webContents = {
			id: labels.indexOf(label) + 1,
			send: (channel, ...args) => {
				if (this.open) writeFrame({ type: 'event', target: label, channel, args });
			},
			isDestroyed: () => !this.open,
			getURL: () => '',
		};
		windows.set(label, this);
	}
	isDestroyed() {
		return !this.open;
	}
	loadURL(_url: string) {
		control('reload', this.label);
		return Promise.resolve();
	}
	minimize() {
		control('minimize', this.label);
	}
	close() {
		control('close', this.label);
	}
	destroy() {
		this.close();
	}
}

export const BrowserWindow = {
	getAllWindows: () => [...windows.values()].filter((window) => window.open),
	fromWebContents: (sender: unknown) => [...windows.values()].find((window) => window.webContents === sender),
};

export function setWindowOpen(label: string, open: boolean): void {
	const window = windows.get(label);
	if (window) window.open = open;
}

export function makeEvent(label: string) {
	const window = windows.get(label) ?? new WorkerWindow(label);
	return {
		sender: window.webContents,
		returnValue: undefined as unknown,
		reply: (channel: string, ...args: unknown[]) => window.webContents.send(channel, ...args),
	};
}

const lifecycle = new EventEmitter();
export const app = Object.assign(lifecycle, {
	getPath(name: string) {
		if (name === 'userData') {
			if (!process.env.TANUKI_TAURI_DATA) throw new Error('Missing Tauri data directory');
			return process.env.TANUKI_TAURI_DATA;
		}
		if (name === 'temp') return tmpdir();
		if (name === 'documents') return join(homedir(), 'Documents');
		throw new Error(`Unsupported app path: ${name}`);
	},
	getAppPath: () => import.meta.dirname,
	getVersion: () => process.env.TANUKI_TAURI_VERSION || '3.2.63-tauri-beta.1',
	getLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
	getName: () => 'TanukiBCL Tauri Beta',
	isPackaged: true,
	relaunch: () => control('relaunch'),
	quit: () => control('quit'),
	exit: () => control('quit'),
});
export const net = { fetch: globalThis.fetch };
export const shell = {
	async openExternal(url: string) {
		control('openExternal', 'main', url);
	},
	async openPath(_path: string) {
		return 'Unsupported in Tauri beta';
	},
};
export const dialog = {
	showErrorBox(title: string, message: string) {
		control('error', 'main', { title, message });
	},
	async showOpenDialog(..._args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> {
		throw new Error('Use the Tauri file picker');
	},
};
export default { app, ipcMain, shell, BrowserWindow, net, dialog };
