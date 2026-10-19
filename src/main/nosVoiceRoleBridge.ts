import { version as clientVersion } from '../../package.json';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import type { IpcMain } from 'electron';
import { GameState, type AmongUsState } from '../common/AmongUsState';
import { IpcMessages } from '../common/ipc-messages';
import { sendHostVoice } from './nosHostVoiceRelay';

export interface NosVoiceRoleDescriptor {
	protocol: 1;
	reportVersion?: boolean;
	role: 'tanukiMegaphone' | 'tanukiBclBibiri' | 'tanukiTalkative' | 'tanukiMicTest' | 'tanukiVoiceRoles';
	playerId: number;
	pid: number;
	port: number;
	token: string;
}

export function validVoiceRoleDescriptor(value: unknown): value is NosVoiceRoleDescriptor {
	if (!value || typeof value !== 'object') return false;
	const d = value as NosVoiceRoleDescriptor;
	return (
		d.protocol === 1 &&
		(d.role === 'tanukiMegaphone' ||
			d.role === 'tanukiBclBibiri' ||
			d.role === 'tanukiTalkative' ||
			d.role === 'tanukiMicTest' ||
			d.role === 'tanukiVoiceRoles') &&
		Number.isInteger(d.playerId) &&
		d.playerId >= 0 &&
		d.playerId <= 255 &&
		Number.isInteger(d.pid) &&
		d.pid > 0 &&
		Number.isInteger(d.port) &&
		d.port > 0 &&
		d.port <= 65535 &&
		typeof d.token === 'string' &&
		/^[a-f0-9]{32}$/.test(d.token)
	);
}

export class NosVoiceRoleSender {
	private descriptor?: NosVoiceRoleDescriptor;
	private lastRead = -Infinity;
	private sequence = 0;
	private token = '';
	private socket?: Socket;
	private discoveryNonce = randomBytes(16).toString('hex');
	private discovered?: NosVoiceRoleDescriptor;
	private discoveredAt = 0;
	private lastDiscovery = -Infinity;
	private currentPid = 0;
	private currentPlayer = -1;

	constructor(
		private readonly descriptorPath: string,
		private readonly discoveryPort = 57741
	) {}

	send(rms: unknown, active: unknown, pid: number, state?: AmongUsState): void {
		if (typeof rms !== 'number' || !Number.isFinite(rms) || rms < 0 || rms > 1 || typeof active !== 'boolean') return;
		const player = state?.players?.find((p) => p.isLocal);
		if (
			state?.mod !== 'NoS' ||
			(state.gameState !== GameState.TASKS &&
				state.gameState !== GameState.DISCUSSION &&
				state.gameState !== GameState.LOBBY) ||
			!player ||
			player.isDead ||
			player.disconnected
		)
			return;
		const now = Date.now();
		this.currentPid = pid;
		this.currentPlayer = player.id;
		if (!this.socket) {
			this.socket = createSocket('udp4');
			this.socket.on('error', () => this.close());
			this.socket.on('message', (bytes, remote) => {
				if (remote.address !== '127.0.0.1' || remote.port !== this.discoveryPort || bytes.length > 4096) return;
				const prefix = `TBCLD1|${this.discoveryNonce}|`;
				const response = bytes.toString('utf8');
				if (!response.startsWith(prefix)) return;
				try {
					const descriptor: unknown = JSON.parse(response.slice(prefix.length));
					if (
						validVoiceRoleDescriptor(descriptor) &&
						descriptor.pid === this.currentPid &&
						descriptor.playerId === this.currentPlayer
					) {
						this.discovered = descriptor;
						this.discoveredAt = Date.now();
					}
				} catch {
					/* Invalid discovery response. */
				}
			});
			this.socket.unref();
		}
		if (now - this.lastDiscovery >= 250) {
			this.lastDiscovery = now;
			this.socket.send(`TBCLD1|${pid}|${this.discoveryNonce}`, this.discoveryPort, '127.0.0.1', () => {});
		}
		if (now - this.lastRead >= 250) {
			this.lastRead = now;
			this.descriptor = undefined;
			try {
				if (statSync(this.descriptorPath).size > 4096) return;
				const descriptor: unknown = JSON.parse(readFileSync(this.descriptorPath, 'utf8'));
				if (validVoiceRoleDescriptor(descriptor)) this.descriptor = descriptor;
			} catch {
				/* No active voice role, or descriptor is being replaced. */
			}
		}
		const descriptor =
			this.discovered &&
			now - this.discoveredAt < 1000 &&
			this.discovered.pid === pid &&
			this.discovered.playerId === player.id
				? this.discovered
				: this.descriptor;
		if (!descriptor || descriptor.pid !== pid || descriptor.playerId !== player.id) return;
		if (descriptor.role === 'tanukiMicTest' ? state.gameState !== GameState.LOBBY : state.gameState === GameState.LOBBY)
			return;
		if (
			state.gameState === GameState.DISCUSSION &&
			descriptor.role !== 'tanukiTalkative' &&
			descriptor.role !== 'tanukiBclBibiri' &&
			descriptor.role !== 'tanukiVoiceRoles'
		)
			return;
		if (this.token !== descriptor.token) {
			this.token = descriptor.token;
			this.sequence = 0;
		}
		if (!this.socket) {
			this.socket = createSocket('udp4');
			this.socket.on('error', () => this.close());
			this.socket.unref();
		}
		// Wall-clock based watermark also increases when BCL is restarted mid-charge.
		this.sequence = Math.max(this.sequence + 1, now * 1000);
		const payload =
			`TBCL1|${descriptor.token}|${this.sequence}|${now}|${rms}|${active ? 1 : 0}` +
			(descriptor.reportVersion === true ? `|${clientVersion}` : '');
		this.socket.send(payload, descriptor.port, '127.0.0.1', () => {});
	}

	close(): void {
		this.discovered = undefined;
		this.discoveryNonce = randomBytes(16).toString('hex');
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close();
		} catch {
			/* Socket may have failed before binding. */
		}
	}
}

export function registerNosVoiceRoleBridge(
	ipcMain: IpcMain,
	getContext: () => { pid: number; state?: AmongUsState },
	isMainRenderer: (senderId: number) => boolean
): NosVoiceRoleSender | undefined {
	if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;
	const sender = new NosVoiceRoleSender(join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', 'voice-role.json'));
	ipcMain.on('NOS_HOST_VOICE_SAMPLE', (event, player: unknown, rms: unknown, active: unknown) => {
		if (!isMainRenderer(event.sender.id)) return;
		const context = getContext();
		sendHostVoice(player, rms, active, context.pid, context.state);
	});
	ipcMain.on(IpcMessages.NOS_VOICE_ROLE_SAMPLE, (event, rms: unknown, active: unknown) => {
		if (!isMainRenderer(event.sender.id)) return;
		const context = getContext();
		sender.send(rms, active, context.pid, context.state);
	});
	return sender;
}
