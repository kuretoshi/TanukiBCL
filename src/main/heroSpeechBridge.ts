import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type Socket } from 'node:dgram';
import type { IpcMain } from 'electron';
import { GameState, type AmongUsState } from '../common/AmongUsState';
import type { HeroSpeechPlayer } from '../common/HeroSpeech';
import { hasTanukiAddon } from '../common/tanukiAddon';

interface Descriptor {
	protocol: 2;
	pid: number;
	port: number;
	token: string;
	updated: number;
	players: HeroSpeechPlayer[];
}
export function validHeroSpeechDescriptor(value: unknown, pid: number, now: number): value is Descriptor {
	if (!value || typeof value !== 'object') return false;
	const d = value as Descriptor;
	if (
		d.protocol !== 2 ||
		d.pid !== pid ||
		!Number.isInteger(d.port) ||
		d.port < 1 ||
		d.port > 65535 ||
		!Number.isFinite(d.updated) ||
		now - d.updated > 1500 ||
		d.updated - now > 100 ||
		typeof d.token !== 'string' ||
		!/^[a-f0-9]{32}$/.test(d.token) ||
		!Array.isArray(d.players) ||
		d.players.length < 1 ||
		d.players.length > 48
	)
		return false;
	const ids = new Set<string>();
	return d.players.every((p) => {
		if (
			!p ||
			!Number.isInteger(p.playerId) ||
			p.playerId < 0 ||
			p.playerId > 255 ||
			!['hero', 'ng'].includes(p.kind) ||
			ids.has(`${p.playerId}|${p.kind}`) ||
			!Number.isInteger(p.request) ||
			p.request < 0 ||
			p.request > 2147483647 ||
			!Array.isArray(p.words) ||
			p.words.length > 3 ||
			!p.words.every((w) => typeof w === 'string' && w.length >= 2 && w.length <= 32) ||
			(p.kind === 'ng' && (p.request === 0 || p.words.length === 0)) ||
			!Number.isSafeInteger(p.expires) ||
			(p.request > 0 && (p.expires < now - 100 || p.expires > now + 16000))
		)
			return false;
		ids.add(`${p.playerId}|${p.kind}`);
		return true;
	});
}
export function registerHeroSpeechBridge(
	ipc: IpcMain,
	getContext: () => { pid: number; state?: AmongUsState },
	isMainRenderer: (id: number) => boolean
): () => void {
	let udp: Socket | undefined;
	function close(): void {
		const current = udp;
		udp = undefined;
		current?.close();
	}
	function send(payload: string, port: number): void {
		if (!udp) {
			udp = createSocket('udp4');
			udp.on('error', () => {});
			udp.unref();
		}
		udp.send(payload, port, '127.0.0.1');
	}
	function descriptor(): Descriptor | undefined {
		const { pid, state } = getContext();
		if (
			!hasTanukiAddon(state) ||
			![GameState.TASKS, GameState.DISCUSSION].includes(state.gameState) ||
			!pid ||
			!process.env.LOCALAPPDATA
		) {
			close();
			return;
		}
		try {
			const path = join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', `hero-speech-${pid}.json`);
			if (statSync(path).size > 32768) return;
			const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
			if (validHeroSpeechDescriptor(data, pid, Date.now())) return data;
		} catch {
			/* No armed hero or an in-progress heartbeat write. */
		}
	}
	ipc.handle('NOS_HERO_SPEECH_STATE', (event) => {
		if (!isMainRenderer(event.sender.id)) return null;
		const d = descriptor();
		return d ? { pid: d.pid, session: d.token, players: d.players } : null;
	});
	ipc.on('NOS_HERO_SPEECH_READY', (event, session: unknown, ready: unknown) => {
		if (!isMainRenderer(event.sender.id) || !Array.isArray(ready) || ready.length > 24) return;
		const d = descriptor();
		if (!d || session !== d.token) return;
		for (const id of ready) {
			if (!d.players.some((p) => p.playerId === id) || !permitted(id)) continue;
			send(`TBCLHS2|${d.token}|ready|${Date.now()}|${id}|1`, d.port);
		}
	});
	function permitted(id: unknown): boolean {
		const state = getContext().state;
		return !!state && (state.isHost || state.players.some((p) => p.isLocal && p.id === id));
	}
	ipc.on('NOS_HERO_SPEECH_WORD', (event, session: unknown, player: unknown, request: unknown, kind: unknown) => {
		if (!isMainRenderer(event.sender.id)) return;
		const d = descriptor();
		const armed = d?.players.find(
			(p) => p.playerId === player && p.request === request && p.kind === kind && p.request > 0
		);
		if (!d || session !== d.token || !armed || armed.expires <= Date.now() || !permitted(player)) return;
		send(
			`TBCLHS2|${d.token}|word|${Date.now()}|${armed.playerId}|${armed.request}|${kind === 'ng' ? 'ng' : 'henshin'}`,
			d.port
		);
	});
	return close;
}
