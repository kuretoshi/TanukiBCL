import type { Player } from './AmongUsState';
import type { ModsType } from './Mods';
import { isTohImpostor } from './TohGhostRoles';

export function isPlayerImpostor(mod: ModsType, player: Player): boolean {
	if (mod !== 'TOH4E') return player.isImpostor;
	const vanilla = player.vanillaIsImpostor ?? player.isImpostor;
	if (player.tohRole) return isTohImpostor(vanilla, player.tohRole);
	return vanilla === true && player.tohImpostor === true;
}

export function withImpostorClassification(mod: ModsType, player: Player): Player {
	if (mod !== 'TOH4E') return player;
	return {
		...player,
		vanillaIsImpostor: player.vanillaIsImpostor ?? player.isImpostor,
		isImpostor: isPlayerImpostor(mod, player),
	};
}

export interface TohImpostorEntry {
	playerId: number;
	clientId: number;
	isImpostor: boolean;
}

export function isTohImpostorEntries(value: unknown): value is TohImpostorEntry[] {
	if (!Array.isArray(value) || value.length > 20) return false;
	const ids = new Set<number>();
	const clients = new Set<number>();
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') return false;
		if (
			!Number.isInteger(entry.playerId) ||
			entry.playerId < 0 ||
			entry.playerId > 255 ||
			!Number.isInteger(entry.clientId) ||
			typeof entry.isImpostor !== 'boolean'
		)
			return false;
		if (ids.has(entry.playerId) || clients.has(entry.clientId)) return false;
		ids.add(entry.playerId);
		clients.add(entry.clientId);
	}
	return true;
}
