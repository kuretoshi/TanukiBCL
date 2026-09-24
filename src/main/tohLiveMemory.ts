import { TohRole, tohNeutralKiller } from '../common/TohRole';

interface KillerLayout {
	dictionarySlot: number;
	dictionaryType: number;
	entriesType: number;
	entriesOffset: number;
	countOffset: number;
	versionOffset: number;
	dataOffset: number;
	stride: number;
	nextOffset: number;
	keyOffset: number;
	valueOffset: number;
	types: Record<string, { isKiller: boolean; stateOffset: number }>;
}

export interface TohLayout {
	pid: number;
	pointerSize: number;
	dictionarySlot: number;
	dictionaryType: number;
	playerType: number;
	entriesType: number;
	entriesOffset: number;
	countOffset: number;
	versionOffset: number;
	dataOffset: number;
	stride: number;
	nextOffset: number;
	keyOffset: number;
	valueOffset: number;
	idOffset: number;
	roleOffset: number;
	opportunistCanKillSlot: number;
	names: Record<string, string>;
	killerLayout?: KillerLayout | null;
}
const validPointer = (n: number) => Number.isInteger(n) && n >= 0x10000 && n <= 0xfffffffc && n % 4 === 0;
export function isTohLayout(value: unknown, pid: number): value is TohLayout {
	if (!value || typeof value !== 'object') return false;
	const v = value as TohLayout;
	return (
		v.pid === pid &&
		v.pointerSize === 4 &&
		[v.dictionarySlot, v.dictionaryType, v.playerType, v.entriesType].every(validPointer) &&
		[v.entriesOffset, v.countOffset, v.versionOffset, v.idOffset, v.roleOffset].every(
			(n) => Number.isInteger(n) && n >= 4 && n <= 1024
		) &&
		v.dataOffset === 8 &&
		Number.isInteger(v.stride) &&
		v.stride >= 12 &&
		v.stride <= 64 &&
		[v.nextOffset, v.keyOffset, v.valueOffset].every((n) => Number.isInteger(n) && n >= 0 && n + 4 <= v.stride) &&
		Number.isInteger(v.opportunistCanKillSlot) &&
		(v.opportunistCanKillSlot === 0 ||
			(v.opportunistCanKillSlot >= 0x10000 && v.opportunistCanKillSlot <= 0xffffffff)) &&
		!!v.names &&
		typeof v.names === 'object' &&
		Object.values(v.names).every((n) => typeof n === 'string') &&
		(v.killerLayout == null || isKillerLayout(v.killerLayout))
	);
}

function isKillerLayout(v: KillerLayout): boolean {
	return (
		[v.dictionarySlot, v.dictionaryType, v.entriesType].every(validPointer) &&
		[v.entriesOffset, v.countOffset, v.versionOffset].every((n) => Number.isInteger(n) && n >= 4 && n <= 1024) &&
		v.dataOffset === 8 &&
		Number.isInteger(v.stride) &&
		v.stride >= 12 &&
		v.stride <= 64 &&
		[v.nextOffset, v.keyOffset, v.valueOffset].every((n) => Number.isInteger(n) && n >= 0 && n + 4 <= v.stride) &&
		!!v.types &&
		typeof v.types === 'object' &&
		Object.entries(v.types).every(
			([key, type]) =>
				validPointer(Number(key)) &&
				!!type &&
				typeof type.isKiller === 'boolean' &&
				Number.isInteger(type.stateOffset) &&
				type.stateOffset >= 4 &&
				type.stateOffset <= 1024
		)
	);
}

export function readTohRoles(l: TohLayout, read: (address: number, size: number) => Buffer): Map<number, TohRole> {
	const u32 = (address: number) => read(address, 4).readUInt32LE();
	const once = () => {
		const killers = new Map<number, { state: number; isKiller: boolean | null }>();
		let validateKillers = () => {};
		if (l.killerLayout) {
			const k = l.killerLayout;
			const dictionary = u32(k.dictionarySlot);
			if (!validPointer(dictionary) || u32(dictionary) !== k.dictionaryType)
				throw new Error('TOH4E active roles unavailable');
			const entries = u32(dictionary + k.entriesOffset),
				count = u32(dictionary + k.countOffset);
			const version = u32(dictionary + k.versionOffset);
			if (!validPointer(entries) || u32(entries) !== k.entriesType || count > 256 || count > u32(entries + 4))
				throw new Error('Invalid TOH4E active roles');
			const bytes = read(entries + k.dataOffset, count * k.stride);
			for (let i = 0; i < count; i++) {
				const start = i * k.stride;
				if (bytes.readInt32LE(start + k.nextOffset) < -1) continue;
				const id = bytes[start + k.keyOffset],
					role = bytes.readUInt32LE(start + k.valueOffset);
				if (!validPointer(role) || killers.has(id)) throw new Error('Invalid TOH4E active role');
				const type = k.types[String(u32(role))];
				killers.set(id, { state: type ? u32(role + type.stateOffset) : 0, isKiller: type?.isKiller ?? null });
			}
			validateKillers = () => {
				if (
					u32(k.dictionarySlot) !== dictionary ||
					u32(dictionary) !== k.dictionaryType ||
					u32(dictionary + k.versionOffset) !== version ||
					u32(dictionary + k.entriesOffset) !== entries ||
					u32(dictionary + k.countOffset) !== count ||
					!read(entries + k.dataOffset, bytes.length).equals(bytes)
				)
					throw new Error('TOH4E active roles changed');
			};
		}
		const dictionary = u32(l.dictionarySlot);
		if (!validPointer(dictionary) || u32(dictionary) !== l.dictionaryType)
			throw new Error('TOH4E dictionary unavailable');
		const version = u32(dictionary + l.versionOffset);
		const entries = u32(dictionary + l.entriesOffset),
			count = u32(dictionary + l.countOffset);
		if (!validPointer(entries) || u32(entries) !== l.entriesType || count > 256 || count > u32(entries + 4))
			throw new Error('Invalid TOH4E entries');
		const bytes = read(entries + l.dataOffset, count * l.stride);
		let canKill: boolean | undefined;
		if (l.opportunistCanKillSlot) {
			const value = read(l.opportunistCanKillSlot, 1)[0];
			if (value > 1) throw new Error('Invalid TOH4E CanKill');
			canKill = value === 1;
		}
		const roles = new Map<number, TohRole>();
		for (let i = 0; i < count; i++) {
			const start = i * l.stride;
			if (bytes.readInt32LE(start + l.nextOffset) < -1) continue;
			const id = bytes[start + l.keyOffset],
				player = bytes.readUInt32LE(start + l.valueOffset);
			if (
				!validPointer(player) ||
				u32(player) !== l.playerType ||
				read(player + l.idOffset, 1)[0] !== id ||
				roles.has(id)
			)
				throw new Error('TOH4E player identity changed');
			const roleId = read(player + l.roleOffset, 4).readInt32LE(),
				roleName = l.names[String(roleId)] ?? null;
			roles.set(id, {
				roleId,
				roleName,
				isNeutralKiller: tohNeutralKiller(roleName, canKill),
				isKiller:
					roleName && roleName !== 'NotAssigned' && killers.get(id)?.state === player
						? killers.get(id)!.isKiller
						: null,
				...(roleName === 'Opportunist' ? { opportunistCanKill: canKill } : {}),
			});
		}
		if (
			u32(l.dictionarySlot) !== dictionary ||
			u32(dictionary) !== l.dictionaryType ||
			u32(dictionary + l.versionOffset) !== version ||
			u32(dictionary + l.entriesOffset) !== entries ||
			u32(dictionary + l.countOffset) !== count ||
			u32(entries) !== l.entriesType ||
			!read(entries + l.dataOffset, bytes.length).equals(bytes)
		)
			throw new Error('TOH4E dictionary changed');
		validateKillers();
		return roles;
	};
	const first = once(),
		second = once();
	if (JSON.stringify([...first]) !== JSON.stringify([...second])) throw new Error('TOH4E roles changed during read');
	return second;
}
