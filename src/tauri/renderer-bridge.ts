import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { normalizeAssetUrls } from './asset-urls';

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Set<Listener>>();
// Subscribe before sending START_HOOK so its initial events cannot be lost.
const ready = listen<{ channel: string; args: unknown[] }>('backend-ipc', ({ payload }) => {
	for (const listener of [...(listeners.get(payload.channel) ?? [])])
		listener(undefined, ...normalizeAssetUrls(payload.args));
});

async function request(channel: string, args: unknown[], mode: 'invoke' | 'send') {
	await ready;
	if (channel.startsWith('native:voice:')) {
		return invoke('native_voice', { action: channel.slice('native:voice:'.length), value: args[0] ?? null });
	}
	if (channel === 'SELECT_INQUIRY_ATTACHMENTS') {
		const selected = await open({ multiple: true, directory: false });
		return selected
			? invoke('ipc', {
					channel: 'tauri:attachments',
					args: [Array.isArray(selected) ? selected : [selected]],
					mode: 'invoke',
				})
			: [];
	}
	if (channel === 'debug:save-log') {
		const destination = await save({
			defaultPath: 'TanukiBCL-Tauri-debug.log',
			filters: [{ name: 'Log', extensions: ['log'] }],
		});
		return destination
			? invoke('ipc', { channel: 'tauri:save-log', args: [destination], mode: 'invoke' })
			: { status: 'cancelled' };
	}
	const result = normalizeAssetUrls(await invoke('ipc', { channel, args, mode }));
	if (channel === 'settings:get' && isNativeVoice) {
		const base =
			new URLSearchParams(location.search).get('voiceLab') === '1'
				? {
						...(result as Record<string, unknown>),
						...(await invoke<Record<string, unknown>>('voice_lab', { action: 'config', value: null })),
					}
				: (result as Record<string, unknown>);
		const { preferences: prefs } = await invoke<{ preferences: Record<string, unknown> }>('native_voice', {
			action: 'status',
			value: null,
		});
		return {
			...base,
			serverURL: prefs.serverUrl,
			microphone: prefs.microphone || 'default',
			speaker: prefs.speaker || 'default',
			masterVolume: Number(prefs.volume) * 100,
			microphoneGain: Number(prefs.microphoneGain) * 100,
			microphoneGainEnabled: prefs.microphoneGainEnabled,
			micSensitivity: prefs.micSensitivity,
			micSensitivityEnabled: prefs.micSensitivityEnabled,
			enableSpatialAudio: prefs.spatialAudio,
			pushToTalkMode: prefs.pushToTalkMode,
			echoCancellation: prefs.echoCancellation,
			noiseSuppression: prefs.noiseSuppression,
			autoGainControl: prefs.autoGainControl,
		};
	}
	if (channel === 'settings:get' && new URLSearchParams(location.search).get('voiceLab') === '1') {
		const overrides = await invoke<Record<string, unknown>>('voice_lab', { action: 'config', value: null });
		return { ...(result as Record<string, unknown>), ...overrides };
	}
	return result;
}

export const ipcRenderer = {
	send(channel: string, ...args: unknown[]) {
		void request(channel, args, 'send').catch((error) => console.error(channel, error));
	},
	invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		return request(channel, args, 'invoke');
	},
	sendSync(_channel: string, ..._args: unknown[]): never {
		throw new Error('Synchronous IPC is unavailable in Tauri');
	},
	on(channel: string, listener: Listener) {
		if (!listeners.has(channel)) listeners.set(channel, new Set());
		listeners.get(channel)!.add(listener);
	},
	off(channel: string, listener?: Listener) {
		if (listener) listeners.get(channel)?.delete(listener);
		else listeners.delete(channel);
	},
};
export const shell = {
	async openExternal(url: string): Promise<void> {
		await invoke('open_external', { url });
	},
};
export const platform = 'win32';
export const isTauri = true;
export const isNativeVoice = new URLSearchParams(location.search).get('nativeVoice') === '1';
export const closeWindow = (): Promise<void> => getCurrentWindow().close();
export const selectExecutable = () =>
	open({ directory: false, multiple: false, filters: [{ name: 'Executable', extensions: ['exe'] }] });
export const getPathForFile = (_file: File): string => {
	throw new Error('Use the Tauri file picker');
};

if (
	new URLSearchParams(location.search).get('voiceLab') === '1' &&
	!isNativeVoice &&
	new URLSearchParams(location.search).get('view') === 'app'
) {
	window.setTimeout(
		() => void import('./voice-lab').then(({ startVoiceLabObserver }) => startVoiceLabObserver()),
		2000
	);
}

document.addEventListener('mousedown', (event) => {
	if (event.button !== 0) return;
	for (let element = event.target as HTMLElement | null; element; element = element.parentElement) {
		const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
		if (region === 'no-drag' || element.closest('button, input, a, select, textarea')) return;
		if (region === 'drag' || element.hasAttribute('data-tauri-drag-region')) {
			void getCurrentWindow().startDragging();
			return;
		}
	}
});
