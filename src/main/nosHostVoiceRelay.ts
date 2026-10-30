import { version as clientVersion } from '../../package.json';
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AmongUsState } from '../common/AmongUsState';
import { hasTanukiAddon } from '../common/tanukiAddon';

let socket: Socket | undefined;
let sequence = 0;
interface HostDescriptor {
	protocol: number;
	pid: number;
	port: number;
	token: string;
	reportVersion?: boolean;
}
let descriptor: HostDescriptor | undefined;
let descriptorScope = '';
let descriptorSignature = '';
let checkedAt = -Infinity;

function signature(file: string): string {
	const stat = statSync(file, { bigint: true });
	if (stat.size > 4096) throw new Error('Host descriptor too large');
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function hostDescriptor(pid: number, state: AmongUsState, now: number): HostDescriptor | undefined {
	const scope = `${process.env.LOCALAPPDATA}|${pid}|${state.lobbyCode}|${state.clientId}|${state.hostId}`;
	if (descriptorScope !== scope) {
		closeHostVoice();
		descriptorScope = scope;
	}
	if (now >= checkedAt && now - checkedAt < 100) return descriptor;
	checkedAt = now;
	try {
		const file = join(process.env.LOCALAPPDATA!, 'TanukiBCL', 'NoS', `host-voice-${pid}.json`);
		const revision = signature(file);
		if (descriptor && revision === descriptorSignature) return descriptor;
		const value = JSON.parse(readFileSync(file, 'utf8')) as HostDescriptor | null;
		if (
			!value ||
			value.protocol !== 1 ||
			value.pid !== pid ||
			!Number.isInteger(value.port) ||
			value.port < 1 ||
			value.port > 65535 ||
			!/^[a-f0-9]{32}$/.test(value.token) ||
			signature(file) !== revision
		)
			throw new Error('Invalid host descriptor');
		descriptor = value;
		descriptorSignature = revision;
	} catch {
		descriptor = undefined;
		descriptorSignature = '';
	}
	return descriptor;
}

export function closeHostVoice(): void {
	descriptor = undefined;
	descriptorScope = '';
	descriptorSignature = '';
	checkedAt = -Infinity;
	const current = socket;
	socket = undefined;
	try {
		current?.close();
	} catch {
		/* The socket may have failed before binding. */
	}
}
export function sendHostVoice(
	playerId: unknown,
	rms: unknown,
	active: unknown,
	pid: number,
	state?: AmongUsState
): boolean {
	if (!hasTanukiAddon(state) || !state?.isHost || !Number.isInteger(pid) || pid <= 0) {
		closeHostVoice();
		return false;
	}
	if (
		!state?.isHost ||
		state.mod !== 'NoS' ||
		!Number.isInteger(playerId) ||
		typeof rms !== 'number' ||
		!Number.isFinite(rms) ||
		rms < 0 ||
		rms > 1 ||
		typeof active !== 'boolean'
	)
		return false;
	const player = state.players?.find((p) => p.id === playerId);
	if (!player || player.disconnected || player.isDead) return false;
	try {
		const now = Date.now();
		const d = hostDescriptor(pid, state, now);
		if (!d) return false;
		sequence = Math.max(sequence + 1, now * 1000);
		if (!socket) {
			socket = createSocket('udp4');
			socket.on('error', () => {});
			socket.unref();
		}
		socket.send(
			`TBCLH1|${d.token}|${player.id}|${sequence}|${now}|${rms}|${active ? 1 : 0}` +
				(d.reportVersion === true ? `|${clientVersion}` : ''),
			d.port,
			'127.0.0.1',
			() => {}
		);
		return true;
	} catch {
		return false;
	}
}
