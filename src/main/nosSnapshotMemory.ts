import { NosPlayerData, NosSnapshot } from '../common/NosSnapshot';

type PlayerField = Exclude<keyof NosPlayerData, 'name'> | 'nameLength' | 'name';
export interface NosLayout {
	pid: number;
	pointerSize: 4;
	schemaVersion: number;
	latestSlotAddress: number;
	snapshot: { localMicPositionX: number; localMicPositionY: number; playersLength: number; players: number };
	playerData: Record<PlayerField | 'size', number>;
}

export function isNosLayout(value: unknown, pid: number): value is NosLayout {
	if (!value || typeof value !== 'object') return false;
	const v = value as NosLayout;
	const validOffset = (offset: number, size: number, limit: number) =>
		Number.isInteger(offset) && offset >= 0 && offset + size <= limit;
	if (
		v.pid !== pid ||
		v.pointerSize !== 4 ||
		v.schemaVersion !== 20260918 ||
		!Number.isInteger(v.latestSlotAddress) ||
		v.latestSlotAddress < 0x10000 ||
		v.latestSlotAddress > 0xfffffffc ||
		v.latestSlotAddress % 4 !== 0 ||
		!v.snapshot ||
		!v.playerData ||
		!Number.isInteger(v.playerData.size) ||
		v.playerData.size < 96 ||
		v.playerData.size > 4096
	)
		return false;
	const p = v.playerData;
	return (
		['localMicPositionX', 'localMicPositionY', 'playersLength', 'players'].every((key) =>
			validOffset(v.snapshot[key as keyof NosLayout['snapshot']], 4, 256)
		) &&
		['playerId', 'isKiller', 'isImpostor', 'isCrewmate', 'isNeutral', 'isImpostorlike', 'nameLength'].every((key) =>
			validOffset(p[key as PlayerField], 1, p.size)
		) &&
		['speakerPositionX', 'speakerPositionY', 'colorR', 'colorG', 'colorB'].every((key) =>
			validOffset(p[key as PlayerField], 4, p.size)
		) &&
		validOffset(p.name, 64, p.size)
	);
}

export function readNosSnapshot(
	layout: NosLayout,
	read: (address: number, size: number) => Buffer
): NosSnapshot & { publication: number } {
	const pointer = (address: number) => read(address, 4).readUInt32LE(0);
	const validPointer = (address: number) => address >= 0x10000 && address <= 0xfffffffc && address % 4 === 0;
	const snapshot = pointer(layout.latestSlotAddress);
	if (!validPointer(snapshot)) throw new Error('NoS snapshot not published');
	const s = layout.snapshot,
		p = layout.playerData;
	const headerSize = Math.max(...Object.values(s)) + 4;
	const header = read(snapshot, headerSize);
	const count = header.readInt32LE(s.playersLength);
	const playersAddress = header.readUInt32LE(s.players);
	if (count < 0 || count > 24 || (count > 0 && !validPointer(playersAddress))) throw new Error('Invalid NoS players');
	const payload = count ? read(playersAddress, count * p.size) : Buffer.alloc(0);
	const ids = new Set<number>();
	const finite = (value: number) => {
		if (!Number.isFinite(value)) throw new Error('Invalid NoS float');
		return value;
	};
	const players: NosPlayerData[] = [];
	for (let i = 0; i < count; i++) {
		const start = i * p.size;
		const u8 = (key: PlayerField) => payload[start + p[key]];
		const f32 = (key: PlayerField) => finite(payload.readFloatLE(start + p[key]));
		const bool = (key: PlayerField) => {
			const value = u8(key);
			if (value > 1) throw new Error('Invalid NoS flag');
			return value === 1;
		};
		const playerId = u8('playerId'),
			length = u8('nameLength');
		if (ids.has(playerId) || length > 32) throw new Error('Invalid NoS player identity');
		ids.add(playerId);
		players.push({
			playerId,
			name: payload.toString('utf16le', start + p.name, start + p.name + length * 2),
			isKiller: bool('isKiller'),
			isImpostor: bool('isImpostor'),
			isCrewmate: bool('isCrewmate'),
			isNeutral: bool('isNeutral'),
			isImpostorlike: bool('isImpostorlike'),
			speakerPositionX: f32('speakerPositionX'),
			speakerPositionY: f32('speakerPositionY'),
			colorR: f32('colorR'),
			colorG: f32('colorG'),
			colorB: f32('colorB'),
		});
	}
	// Latest may advance to another ring slot. Verify the selected slot itself was not recycled.
	if (
		!read(snapshot, headerSize).equals(header) ||
		(count > 0 && !read(playersAddress, count * p.size).equals(payload))
	)
		throw new Error('NoS snapshot changed during read');
	return {
		publication: snapshot,
		localMicPosition: {
			x: finite(header.readFloatLE(s.localMicPositionX)),
			y: finite(header.readFloatLE(s.localMicPositionY)),
		},
		players,
	};
}
