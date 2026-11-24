import type { Player } from '../common/AmongUsState';

export interface SnrSecondaryLayout {
	pid: number;
	pointerSize: 4 | 8;
	controlClass: number;
	cosmeticsClass: number;
	playerIdOffset: number;
	cosmeticsOffset: number;
	layers: { address: number; class: number; hat2Id: string | null; visor2Id: string | null }[];
}

export function isSnrSecondaryLayout(value: unknown, pid: number): value is SnrSecondaryLayout {
	if (!value || typeof value !== 'object') return false;
	const v = value as SnrSecondaryLayout;
	const pointer = (n: number) =>
		Number.isSafeInteger(n) && n >= 0x10000 && n % v.pointerSize === 0 && (v.pointerSize === 8 || n <= 0xfffffffc);
	const offset = (n: number, width: number) => Number.isInteger(n) && n >= 2 * v.pointerSize && n + width <= 4096;
	const id = (value: unknown) =>
		value === null || (typeof value === 'string' && value.length > 0 && value.length <= 1024);
	return (
		v.pid === pid &&
		[4, 8].includes(v.pointerSize) &&
		pointer(v.controlClass) &&
		pointer(v.cosmeticsClass) &&
		offset(v.playerIdOffset, 1) &&
		offset(v.cosmeticsOffset, v.pointerSize) &&
		Array.isArray(v.layers) &&
		v.layers.length <= 4096 &&
		v.layers.every(
			(row) => row && pointer(row.address) && row.class === v.cosmeticsClass && id(row.hat2Id) && id(row.visor2Id)
		) &&
		new Set(v.layers.map((row) => row.address)).size === v.layers.length
	);
}

/** Resolve a cosmetic layer from the base reader's native player, independently of roles. */
export function readSnrSecondaryCosmetics(
	layout: SnrSecondaryLayout,
	player: Pick<Player, 'id' | 'objectPtr' | 'disconnected'>,
	read: (address: number, size: number) => Buffer
): Pick<Player, 'snrHat2Id' | 'snrVisor2Id'> {
	const empty = { snrHat2Id: undefined, snrVisor2Id: undefined };
	try {
		if (
			player.disconnected ||
			!Number.isSafeInteger(player.objectPtr) ||
			player.objectPtr < 0x10000 ||
			player.objectPtr % layout.pointerSize !== 0 ||
			!Number.isInteger(player.id) ||
			player.id < 0 ||
			player.id > 255
		)
			return empty;
		const pointer = (address: number) =>
			layout.pointerSize === 8 ? Number(read(address, 8).readBigUInt64LE()) : read(address, 4).readUInt32LE();
		const sample = () => {
			if (
				pointer(player.objectPtr) !== layout.controlClass ||
				read(player.objectPtr + layout.playerIdOffset, 1)[0] !== player.id
			)
				throw new Error('SNR cosmetic owner changed');
			const address = pointer(player.objectPtr + layout.cosmeticsOffset);
			if (pointer(address) !== layout.cosmeticsClass) throw new Error('SNR cosmetic layer changed');
			return address;
		};
		const address = sample();
		const layer = layout.layers.find((layer) => layer.address === address);
		if (sample() !== address || !layer) return empty;
		return { snrHat2Id: layer.hat2Id ?? undefined, snrVisor2Id: layer.visor2Id ?? undefined };
	} catch {
		return empty;
	}
}
