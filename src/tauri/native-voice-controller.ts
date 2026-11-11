import { invoke } from '@tauri-apps/api/core';
import type { AmongUsState } from '../common/AmongUsState';
import type { VoiceSnapshot } from '../renderer/voice/types';
import { normalizeAssetUrls } from './asset-urls';

const empty: VoiceSnapshot = {
	remoteVoiceCode: '',
	remoteVoiceConnected: false,
	versionWarning: '',
	connected: false,
	error: '',
	talking: false,
	muted: false,
	deafened: false,
	otherTalking: {},
	otherDead: {},
	socketClients: {},
	playerSocketIds: {},
	audioConnected: {},
	connectionQuality: {},
	impostorRadioClientId: -1,
	impostorRadioClientIds: [],
	activeLobbySettings: null,
	hostId: 0,
	toh4eLobby: false,
	tohRole: null,
	tohRoleCatalog: [],
	tohGameStartNames: {},
	nosRadiosByPlayer: {},
};

export class NativeVoiceController {
	private snapshot = empty;
	private listeners = new Set<() => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private effectiveGame?: AmongUsState;
	running = false;
	getSnapshot = (): VoiceSnapshot => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getEffectiveGameState(state: AmongUsState): AmongUsState {
		return this.effectiveGame?.lobbyCode === state.lobbyCode && this.snapshot.toh4eLobby ? this.effectiveGame : state;
	}
	getVisibleRadioClientIds(_state: AmongUsState): number[] {
		return this.snapshot.impostorRadioClientIds;
	}
	async start() {
		if (this.running) return;
		this.running = true;
		const generation = ++this.generation;
		const poll = async () => {
			try {
				const data = await invoke<{
					status: {
						connected: boolean;
						error: string;
						talking: boolean;
						voiceSnapshot: Partial<VoiceSnapshot>;
						effectiveGame?: AmongUsState;
					};
					muted: boolean;
					deafened: boolean;
				}>('native_voice', { action: 'status', value: null });
				if (!this.running || generation !== this.generation) return;
				this.effectiveGame = normalizeAssetUrls(data.status.effectiveGame);
				this.snapshot = {
					...empty,
					...data.status.voiceSnapshot,
					connected: data.status.connected,
					error: data.status.error,
					talking: data.status.talking,
					muted: data.muted,
					deafened: data.deafened,
				};
				for (const listener of this.listeners) listener();
			} catch (error) {
				if (!this.running || generation !== this.generation) return;
				this.snapshot = { ...this.snapshot, connected: false, error: String(error) };
				for (const listener of this.listeners) listener();
			}
			if (this.running && generation === this.generation) this.timer = setTimeout(() => void poll(), 200);
		};
		await poll();
	}
	// Closing/reloading a WebView only detaches the view. The Rust engine keeps
	// its microphone, peers, hotkeys and integrations alive in the tray.
	stop() {
		this.running = false;
		this.generation++;
		clearTimeout(this.timer);
	}
	private command(action: string, value: unknown) {
		void invoke('native_voice', { action, value }).catch((error) => {
			this.snapshot = { ...this.snapshot, error: String(error) };
			for (const listener of this.listeners) listener();
		});
	}
	toggleMute = () => this.command('mute', !this.snapshot.muted);
	toggleDeafen = () => this.command('deafen', !this.snapshot.deafened);
	setImpostorRadio(pressing: boolean, kind = 0) {
		this.command(kind === 0 ? 'radio' : 'jackal-radio', pressing);
	}
	enableRemoteVoice = () => this.command('remote-enable', true);
	disableRemoteVoice = () => this.command('remote-disable', true);
}
