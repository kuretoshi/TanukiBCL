import { hasSnrJumbo, SnrEnumValue, SnrLiveRole } from '../common/SnrRole';
import type { SnrMeetingLayout } from './snrMeetingMemory';

interface JumboLayout {
	abilityType: number;
	dataType: number;
	listType: number;
	itemsType: number;
	abilitiesOffset: number;
	itemsOffset: number;
	countOffset: number;
	currentOffset: number;
	dataOffset: number;
	maxOffset: number;
}

interface BuskerLayout {
	abilityType: number;
	listType: number;
	itemsType: number;
	abilitiesOffset: number;
	itemsOffset: number;
	countOffset: number;
	activeOffset: number;
}

interface NumberField {
	offset: number;
	size: 1 | 2 | 4;
	signed: boolean;
	names: Record<string, string> | null;
}

export interface SnrLiveLayout {
	meeting?: SnrMeetingLayout | null;
	pid: number;
	pointerSize: 4 | 8;
	arraySlot: number;
	arrayType: number;
	playerType: number;
	arrayLengthOffset: number;
	arrayDataOffset: number;
	jumbo?: JumboLayout | null;
	busker?: BuskerLayout | null;
	fields: { playerId: NumberField; role: NumberField; modifier: NumberField | null; ghostRole: NumberField | null };
}

export function isSnrLiveLayout(value: unknown, pid: number): value is SnrLiveLayout {
	if (!value || typeof value !== 'object') return false;
	const v = value as SnrLiveLayout;
	const pointer = (n: number) =>
		Number.isSafeInteger(n) && n >= 0x10000 && (v.pointerSize === 8 || n <= 0xfffffffc) && n % v.pointerSize === 0;
	const field = (f: NumberField | null, required = false) =>
		f == null
			? !required
			: Number.isInteger(f.offset) &&
				f.offset >= 4 &&
				f.offset <= 1024 &&
				[1, 2, 4].includes(f.size) &&
				typeof f.signed === 'boolean' &&
				(f.names === null ||
					(typeof f.names === 'object' && Object.values(f.names).every((n) => typeof n === 'string')));
	return (
		v.pid === pid &&
		(v.pointerSize === 4 || v.pointerSize === 8) &&
		pointer(v.arraySlot) &&
		pointer(v.arrayType) &&
		pointer(v.playerType) &&
		v.arrayLengthOffset === v.pointerSize &&
		v.arrayDataOffset >= v.pointerSize + 4 &&
		v.arrayDataOffset <= 32 &&
		v.arrayDataOffset % v.pointerSize === 0 &&
		(v.jumbo == null ||
			(['abilityType', 'dataType', 'listType', 'itemsType'].every((key) =>
				pointer(v.jumbo![key as keyof JumboLayout])
			) &&
				['abilitiesOffset', 'itemsOffset', 'countOffset', 'currentOffset', 'dataOffset', 'maxOffset'].every((key) => {
					const n = v.jumbo![key as keyof JumboLayout];
					return Number.isInteger(n) && n >= 4 && n <= 4096 && n % 4 === 0;
				}))) &&
		(v.busker == null ||
			(['abilityType', 'listType', 'itemsType'].every((key) => pointer(v.busker![key as keyof BuskerLayout])) &&
				['abilitiesOffset', 'itemsOffset', 'countOffset', 'activeOffset'].every((key) => {
					const n = v.busker![key as keyof BuskerLayout];
					return Number.isInteger(n) && n >= 4 && n <= 4096;
				}))) &&
		!!v.fields &&
		field(v.fields.playerId, true) &&
		field(v.fields.role, true) &&
		field(v.fields.modifier) &&
		field(v.fields.ghostRole)
	);
}

/** Read from the current static slot every time: managed object addresses can move during GC. */
export function readSnrLiveRoles(
	layout: SnrLiveLayout,
	read: (address: number, size: number) => Buffer
): Map<number, SnrLiveRole> {
	const pointer = (address: number) => {
		const bytes = read(address, layout.pointerSize);
		return layout.pointerSize === 8 ? Number(bytes.readBigUInt64LE(0)) : bytes.readUInt32LE(0);
	};
	const validPointer = (address: number) =>
		Number.isSafeInteger(address) &&
		address >= 0x10000 &&
		(layout.pointerSize === 8 || address <= 0xfffffffc) &&
		address % layout.pointerSize === 0;
	const readJumbo = (player: number): SnrLiveRole['jumbo'] => {
		const j = layout.jumbo;
		if (!j) return undefined;
		try {
			const list = pointer(player + j.abilitiesOffset);
			if (!validPointer(list) || pointer(list) !== j.listType) return undefined;
			const items = pointer(list + j.itemsOffset);
			const count = read(list + j.countOffset, 4).readUInt32LE(0);
			if (
				!validPointer(items) ||
				pointer(items) !== j.itemsType ||
				count > 512 ||
				count > read(items + layout.arrayLengthOffset, 4).readUInt32LE(0)
			)
				return undefined;
			const entries = read(items + layout.arrayDataOffset, count * layout.pointerSize);
			for (let i = 0; i < count; i++) {
				const ability = layout.pointerSize === 8 ? Number(entries.readBigUInt64LE(i * 8)) : entries.readUInt32LE(i * 4);
				if (!validPointer(ability) || pointer(ability) !== j.abilityType) continue;
				const data = pointer(ability + j.dataOffset);
				if (!validPointer(data) || pointer(data) !== j.dataType) return undefined;
				const currentSize = read(ability + j.currentOffset, 4).readFloatLE(0);
				const maxSize = read(data + j.maxOffset, 4).readFloatLE(0);
				if (!Number.isFinite(currentSize) || currentSize < 0 || !Number.isFinite(maxSize) || maxSize <= 0)
					return undefined;
				if (
					pointer(player) !== layout.playerType ||
					pointer(player + j.abilitiesOffset) !== list ||
					pointer(list) !== j.listType ||
					pointer(list + j.itemsOffset) !== items ||
					read(list + j.countOffset, 4).readUInt32LE(0) !== count ||
					pointer(items) !== j.itemsType ||
					!read(items + layout.arrayDataOffset, count * layout.pointerSize).equals(entries) ||
					pointer(ability) !== j.abilityType ||
					pointer(ability + j.dataOffset) !== data ||
					pointer(data) !== j.dataType
				)
					return undefined;
				return { currentSize, maxSize };
			}
		} catch {
			// A moving/unavailable ability must not reuse an old size or hide valid roles.
		}
		return undefined;
	};
	const readBuskerState = (player: number): boolean | undefined => {
		const b = layout.busker;
		if (!b) return undefined;
		try {
			const list = pointer(player + b.abilitiesOffset);
			if (!validPointer(list) || pointer(list) !== b.listType) return undefined;
			const items = pointer(list + b.itemsOffset);
			const count = read(list + b.countOffset, 4).readUInt32LE(0);
			if (
				!validPointer(items) ||
				pointer(items) !== b.itemsType ||
				count > 512 ||
				count > read(items + layout.arrayLengthOffset, 4).readUInt32LE(0)
			)
				return undefined;
			const entries = read(items + layout.arrayDataOffset, count * layout.pointerSize);
			for (let i = 0; i < count; i++) {
				const ability = layout.pointerSize === 8 ? Number(entries.readBigUInt64LE(i * 8)) : entries.readUInt32LE(i * 4);
				if (!validPointer(ability) || pointer(ability) !== b.abilityType) continue;
				const activeByte = read(ability + b.activeOffset, 1)[0];
				if (activeByte > 1) return undefined;
				if (
					pointer(player) !== layout.playerType ||
					pointer(player + b.abilitiesOffset) !== list ||
					pointer(list) !== b.listType ||
					pointer(list + b.itemsOffset) !== items ||
					read(list + b.countOffset, 4).readUInt32LE(0) !== count ||
					!read(items + layout.arrayDataOffset, count * layout.pointerSize).equals(entries) ||
					pointer(ability) !== b.abilityType ||
					read(ability + b.activeOffset, 1)[0] !== activeByte
				)
					return undefined;
				return activeByte === 1;
			}
		} catch {
			// A moving ability must fail closed.
		}
		return undefined;
	};
	const snapshot = () => {
		const array = pointer(layout.arraySlot);
		if (
			!validPointer(array) ||
			pointer(array) !== layout.arrayType ||
			read(array + layout.arrayLengthOffset, 4).readUInt32LE(0) !== 256
		)
			throw new Error('SNR player array changed or is unavailable');
		const entries = read(array + layout.arrayDataOffset, 256 * layout.pointerSize);
		const result = new Map<number, SnrLiveRole>();
		const fields = Object.values(layout.fields).filter((f): f is NumberField => f !== null);
		const size = Math.max(...fields.map((f) => f.offset + f.size));
		const describe = (bytes: Buffer, field: NumberField | null, flags = false): SnrEnumValue | null => {
			if (!field) return null;
			const value = field.signed
				? bytes.readIntLE(field.offset, field.size)
				: bytes.readUIntLE(field.offset, field.size);
			let name = field.names?.[String(value)] ?? null;
			if (flags && !name && value > 0 && field.names) {
				let remaining = BigInt(value);
				const names: string[] = [];
				for (const [key, label] of Object.entries(field.names)) {
					const bit = BigInt(key);
					if (bit > 0n && (bit & (bit - 1n)) === 0n && (remaining & bit) === bit) {
						names.push(label);
						remaining &= ~bit;
					}
				}
				if (remaining === 0n && names.length) name = names.join(' | ');
			}
			return { value, name };
		};
		for (let id = 0; id < 256; id++) {
			const player = layout.pointerSize === 8 ? Number(entries.readBigUInt64LE(id * 8)) : entries.readUInt32LE(id * 4);
			if (!player) continue;
			if (!validPointer(player)) throw new Error('Invalid SNR player pointer');
			const bytes = read(player, size);
			if (
				(layout.pointerSize === 8 ? Number(bytes.readBigUInt64LE(0)) : bytes.readUInt32LE(0)) !== layout.playerType ||
				describe(bytes, layout.fields.playerId)?.value !== id
			)
				throw new Error('SNR player changed during read');
			const role: SnrLiveRole = {
				role: describe(bytes, layout.fields.role)!,
				modifier: describe(bytes, layout.fields.modifier, true),
				ghostRole: describe(bytes, layout.fields.ghostRole),
			};
			if (hasSnrJumbo(role)) role.jumbo = readJumbo(player);
			if (role.role.name === 'Busker') {
				role.buskerPseudocideActive = readBuskerState(player);
			}
			result.set(id, role);
		}
		if (
			pointer(layout.arraySlot) !== array ||
			!read(array + layout.arrayDataOffset, 256 * layout.pointerSize).equals(entries)
		)
			throw new Error('SNR player array changed during read');
		return result;
	};
	// Unsuspended reads can race with a role change or GC. Discard inconsistent samples.
	const first = snapshot();
	const second = snapshot();
	// Size advances continuously; compare role identity, not the changing float.
	const identity = (roles: Map<number, SnrLiveRole>) =>
		JSON.stringify([...roles].map(([id, role]) => [id, role.role, role.modifier, role.ghostRole]));
	if (identity(first) !== identity(second)) throw new Error('SNR roles changed during read');
	return second;
}
