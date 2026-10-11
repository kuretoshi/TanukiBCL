import type { Client, SocketClientMap, numberStringMap } from './AmongUsState';

/** Keep PC and companion sockets, but choose one voice stream per game player. */
export class VoiceRoleSources {
	private entries = new Map<number, { peerId: string; playerId: number; receivedAt: number }>();
	clear(): void {
		this.entries.clear();
	}
	receive(
		sender: Client | undefined,
		data: unknown,
		lobbyCode: string,
		clients: SocketClientMap,
		now = Date.now()
	): boolean {
		if (!sender || !data || typeof data !== 'object') return false;
		const source = data as { lobbyCode: string; playerId: number; clientId: number; peerId: string };
		if (
			source.lobbyCode !== lobbyCode ||
			source.playerId !== sender.playerId ||
			source.clientId !== sender.clientId ||
			typeof source.peerId !== 'string' ||
			source.peerId.length > 128
		)
			return false;
		const peer = clients[source.peerId];
		if (!peer || peer.clientId !== sender.clientId || peer.playerId !== sender.playerId) return false;
		this.entries.set(sender.clientId, { peerId: source.peerId, playerId: sender.playerId, receivedAt: now });
		return true;
	}
	apply(map: numberStringMap, clients: SocketClientMap, now = Date.now()): numberStringMap {
		for (const [clientId, entry] of this.entries) {
			if (
				now - entry.receivedAt > 2500 ||
				clients[entry.peerId]?.clientId !== clientId ||
				clients[entry.peerId]?.playerId !== entry.playerId
			) {
				this.entries.delete(clientId);
				continue;
			}
			map[clientId] = entry.peerId;
		}
		return map;
	}
}
