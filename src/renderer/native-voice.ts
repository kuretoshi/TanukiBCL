import { invoke } from '@tauri-apps/api/core';
import './native-voice.css';

interface Preferences {
	serverUrl: string;
	microphone: string;
	speaker: string;
	volume: number;
	microphoneGain: number;
	microphoneGainEnabled: boolean;
	micSensitivity: number;
	micSensitivityEnabled: boolean;
	spatialAudio: boolean;
	pushToTalkMode: number;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	autoGainControl: boolean;
}
interface Snapshot {
	preferences: Preferences;
	muted: boolean;
	deafened: boolean;
	synthetic: boolean;
	hideCode: boolean;
	players: { clientId: number; name: string; isDead: boolean; volume: number; isMuted: boolean }[];
	status: {
		connected: boolean;
		audioReady: boolean;
		gameOpen: boolean;
		gameState: number | null;
		lobby: string;
		peers: number;
		talking: boolean;
		error: string;
		gameError: string;
		radioActive: boolean;
	};
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const call = <T = Snapshot>(action: string, value: unknown = null) => invoke<T>('native_voice', { action, value });
let current: Snapshot | undefined;
let initialized = false;
let actionError = '';
let dirty = false;
let preferenceSignature = '';
const playerRows = new Map<
	number,
	{ row: HTMLElement; label: HTMLElement; volume: HTMLInputElement; mute: HTMLButtonElement }
>();
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);

function render(snapshot: Snapshot) {
	current = snapshot;
	const { status } = snapshot;
	const ready = status.connected && status.audioReady;
	element('connection').classList.toggle('ready', ready);
	element('connection').querySelector('span')!.textContent = ready ? '通話サーバーに接続済み' : '通話を準備しています…';
	element('game').textContent = status.lobby
		? `${snapshot.synthetic ? 'テスト接続' : ['ロビー', 'ゲーム中', '会議中'][status.gameState ?? 0]} · ${snapshot.hideCode ? '部屋に接続済み' : status.lobby}`
		: status.gameOpen
			? '部屋への入室を待っています'
			: 'Among Usの起動を待っています';
	element('peers').textContent =
		`通話相手 ${status.peers}人${status.talking ? ' · 発話中' : ''}${status.radioActive ? ' · 無線送信中' : ''}`;
	const present = new Set(snapshot.players.map((p) => p.clientId));
	for (const [client, item] of playerRows)
		if (!present.has(client)) {
			item.row.remove();
			playerRows.delete(client);
		}
	for (const player of snapshot.players) {
		let item = playerRows.get(player.clientId);
		if (!item) {
			const row = document.createElement('div'),
				label = document.createElement('span'),
				volume = document.createElement('input'),
				mute = document.createElement('button');
			volume.type = 'range';
			volume.min = '0';
			volume.max = '200';
			volume.setAttribute('aria-label', `${player.name}の音量`);
			mute.type = 'button';
			row.className = 'player';
			row.append(label, volume, mute);
			element('players').append(row);
			volume.onchange = () => {
				const value = current?.players.find((p) => p.clientId === player.clientId);
				if (value)
					void perform('player', {
						clientId: player.clientId,
						volume: Number(volume.value) / 100,
						isMuted: value.isMuted,
					});
			};
			mute.onclick = () => {
				const value = current?.players.find((p) => p.clientId === player.clientId);
				if (value) void perform('player', { clientId: player.clientId, volume: value.volume, isMuted: !value.isMuted });
			};
			item = { row, label, volume, mute };
			playerRows.set(player.clientId, item);
		}
		item.label.textContent = `${player.name}${player.isDead ? ' 👻' : ''}`;
		if (document.activeElement !== item.volume) item.volume.value = String(Math.round(player.volume * 100));
		item.mute.textContent = player.isMuted ? '解除' : 'ミュート';
		item.mute.setAttribute('aria-pressed', String(player.isMuted));
	}
	element('players').hidden = snapshot.players.length === 0;
	for (const [id, muted, label] of [
		['mute', snapshot.muted || snapshot.deafened, 'マイク'],
		['deafen', snapshot.deafened, 'スピーカー'],
	] as const) {
		const button = element<HTMLButtonElement>(id);
		button.textContent = `${label} ${muted ? 'OFF' : 'ON'}`;
		button.classList.toggle('muted', muted);
		button.setAttribute('aria-pressed', String(muted));
	}
	const error = [actionError, status.gameError, status.error].filter(Boolean).join('\n');
	element('error').textContent = error;
	element('error').hidden = !error;
	const signature = JSON.stringify(snapshot.preferences);
	if (!initialized || (!dirty && preferenceSignature !== signature)) {
		const prefs = snapshot.preferences;
		input('server').value = prefs.serverUrl;
		select('microphone').value = prefs.microphone;
		select('speaker').value = prefs.speaker;
		input('volume').value = String(prefs.volume * 100);
		element('volume-label').textContent = `${Math.round(prefs.volume * 100)}%`;
		input('spatial').checked = prefs.spatialAudio;
		input('echo').checked = prefs.echoCancellation;
		input('noise').checked = prefs.noiseSuppression;
		input('gain').checked = prefs.autoGainControl;
		input('manual-gain').checked = prefs.microphoneGainEnabled;
		input('microphone-gain').value = String(prefs.microphoneGain * 100);
		element('microphone-gain-label').textContent = `${Math.round(prefs.microphoneGain * 100)}%`;
		input('sensitivity-enabled').checked = prefs.micSensitivityEnabled;
		input('sensitivity').value = String(prefs.micSensitivity * 100);
		element('sensitivity-label').textContent = `${Math.round(prefs.micSensitivity * 100)}%`;
		select('ptt').value = String(prefs.pushToTalkMode);
		initialized = true;
		preferenceSignature = signature;
	}
}
async function perform(action: string, value: unknown = null) {
	try {
		actionError = '';
		const snapshot = await call(action, value);
		if (action === 'configure') {
			dirty = false;
			initialized = false;
		}
		if (snapshot) render(snapshot);
	} catch (error) {
		actionError = String(error);
		if (current) render(current);
	}
}
element('mute').onclick = () => void perform('mute', current?.deafened ? false : !current?.muted);
element('deafen').onclick = () => void perform('deafen', !current?.deafened);
element('background').onclick = () => void perform('background');
element('quit').onclick = () => void perform('quit');
element('open-settings').onclick = () => void perform('open-settings');
element('settings').addEventListener('input', () => {
	dirty = true;
});
input('volume').oninput = () => (element('volume-label').textContent = `${input('volume').value}%`);
input('microphone-gain').oninput = () =>
	(element('microphone-gain-label').textContent = `${input('microphone-gain').value}%`);
input('sensitivity').oninput = () => (element('sensitivity-label').textContent = `${input('sensitivity').value}%`);
element('settings').onsubmit = (event) => {
	event.preventDefault();
	if (!current) return;
	void perform('configure', {
		...current.preferences,
		serverUrl: input('server').value.trim().replace(/\/$/, ''),
		microphone: select('microphone').value,
		speaker: select('speaker').value,
		volume: Number(input('volume').value) / 100,
		spatialAudio: input('spatial').checked,
		pushToTalkMode: Number(select('ptt').value),
		echoCancellation: input('echo').checked,
		noiseSuppression: input('noise').checked,
		autoGainControl: input('gain').checked,
		microphoneGain: Number(input('microphone-gain').value) / 100,
		microphoneGainEnabled: input('manual-gain').checked,
		micSensitivity: Number(input('sensitivity').value) / 100,
		micSensitivityEnabled: input('sensitivity-enabled').checked,
	});
};
async function start() {
	try {
		const devices = await call<{ inputs: { id: string; name: string }[]; outputs: { id: string; name: string }[] }>(
			'devices'
		);
		for (const [id, list] of [
			['microphone', devices.inputs],
			['speaker', devices.outputs],
		] as const) {
			for (const device of list) select(id).add(new Option(device.name, device.id));
		}
	} catch (error) {
		actionError = String(error);
	}
	async function poll() {
		try {
			render(await call('status'));
		} catch (error) {
			element('error').textContent = String(error);
			element('error').hidden = false;
		}
		window.setTimeout(() => void poll(), 500);
	}
	await poll();
}
void start();
