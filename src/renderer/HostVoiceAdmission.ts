import type { AmongUsState, Client } from '../common/AmongUsState';

/** Admission uses the signaling server's sender identity, never only packet-supplied player IDs. */
export class HostVoiceAdmission {
	private readonly peers = new Map<string, { session: string; sequence: number; at: number }>();
	private scope = '';
	accept(
		from: string,
		client: Client | undefined,
		data: Record<string, unknown>,
		state: AmongUsState | undefined,
		now = Date.now()
	): boolean {
		if (
			!state?.isHost ||
			state.mod !== 'NoS' ||
			!client ||
			data.lobbyCode !== state.lobbyCode ||
			data.playerId !== client.playerId ||
			data.clientId !== client.clientId ||
			typeof data.rms !== 'number' ||
			!Number.isFinite(data.rms) ||
			data.rms < 0 ||
			data.rms > 1 ||
			typeof data.active !== 'boolean' ||
			typeof data.session !== 'string' ||
			!/^[a-f0-9-]{36}$/.test(data.session) ||
			typeof data.sequence !== 'number' ||
			!Number.isSafeInteger(data.sequence) ||
			data.sequence <= 0
		)
			return false;
		const player = state.players.find((p) => p.id === client.playerId && p.clientId === client.clientId);
		if (!player || player.disconnected || player.isDead) return false;
		if (this.scope !== state.lobbyCode) {
			this.scope = state.lobbyCode;
			this.peers.clear();
		}
		const previous = this.peers.get(from);
		if (
			previous &&
			(now - previous.at < 80 || (previous.session === data.session && data.sequence <= previous.sequence))
		)
			return false;
		if (this.peers.size >= 256 && !previous) return false;
		this.peers.set(from, { session: data.session, sequence: data.sequence, at: now });
		return true;
	}
}
