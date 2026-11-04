import { addonLinkPort } from './AddonLink';
import type { NosSnapshot } from './NosSnapshot';
import type { HeroTransformState } from './HeroTransformState';

export interface TanukiAddonState {
	heroes: HeroTransformState[];
	portable: { playerId: number; extraRange: number }[];
}
export function readTanukiAddonData(snapshot?: NosSnapshot | null): TanukiAddonState | undefined {
	const v2 = addonLinkPort(snapshot?.addonData) !== undefined;
	if (!snapshot || (!v2 && snapshot.addonData !== 0x544b0001) || snapshot.players.length > 24) return;
	const result: TanukiAddonState = { heroes: [], portable: [] };
	const ids = new Set<number>();
	for (const player of snapshot.players) {
		const data = player.addonData;
		if (
			!Number.isInteger(player.playerId) ||
			player.playerId < 0 ||
			player.playerId >= 24 ||
			ids.has(player.playerId) ||
			!Number.isInteger(data) ||
			data < 0 ||
			data > 0x7fffffff ||
			(v2 ? (data & 0xffff0000) !== 0x544c0000 : (data & 0xfffffe00) !== 0x544b0000)
		)
			return;
		ids.add(player.playerId);
		const hero = data & 3,
			range = (data >> 2) & 63,
			active = (data & 0x100) !== 0;
		if (hero === 3 || range > 60 || (!active && range !== 0)) return;
		if (hero) result.heroes.push({ playerId: player.playerId, kind: hero === 1 ? 'super' : 'evil' });
		if (active) result.portable.push({ playerId: player.playerId, extraRange: range / 2 });
	}
	return result;
}
