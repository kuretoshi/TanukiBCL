import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AmongUsState } from '../common/AmongUsState';

const socket = createSocket('udp4');
socket.on('error', () => {});
socket.unref();
let sequence = 0;
export function sendHostVoice(
	playerId: unknown,
	rms: unknown,
	active: unknown,
	pid: number,
	state?: AmongUsState
): boolean {
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
	const player = state.players.find((p) => p.id === playerId);
	if (!player || player.disconnected || player.isDead) return false;
	try {
		const d = JSON.parse(
			readFileSync(join(process.env.LOCALAPPDATA!, 'TanukiBCL', 'NoS', `host-voice-${pid}.json`), 'utf8')
		) as { protocol: number; pid: number; port: number; token: string };
		if (
			d.protocol !== 1 ||
			d.pid !== pid ||
			!Number.isInteger(d.port) ||
			d.port < 1 ||
			d.port > 65535 ||
			!/^[a-f0-9]{32}$/.test(d.token)
		)
			return false;
		const now = Date.now();
		sequence = Math.max(sequence + 1, now * 1000);
		socket.send(
			`TBCLH1|${d.token}|${player.id}|${sequence}|${now}|${rms}|${active ? 1 : 0}`,
			d.port,
			'127.0.0.1',
			() => {}
		);
		return true;
	} catch {
		return false;
	}
}
