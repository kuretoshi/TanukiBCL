import type { SnrMeeting } from '../common/SnrMeeting';

export interface SnrMeetingLayout {
	enabledSlot: number;
	pageSlot: number;
	areasSlot: number;
	listType: number;
	itemsType: number;
	voteAreaType: number;
	nativeClass: number;
	itemsOffset: number;
	countOffset: number;
	versionOffset: number;
	pooledPtrOffset: number;
	playerIdOffset: number;
}

export function readSnrMeeting(
	layout: { pointerSize: 4 | 8; arrayDataOffset: number; meeting?: SnrMeetingLayout | null },
	read: (address: number, size: number) => Buffer
): SnrMeeting | undefined {
	const m = layout.meeting;
	if (!m) return undefined;
	try {
		const valid = (value: number) =>
			Number.isSafeInteger(value) &&
			value >= 0x10000 &&
			value % layout.pointerSize === 0 &&
			(layout.pointerSize === 8 || value <= 0xfffffffc);
		if (
			![m.enabledSlot, m.pageSlot].every((value) => Number.isSafeInteger(value) && value >= 0x10000) ||
			![m.areasSlot, m.listType, m.itemsType, m.voteAreaType, m.nativeClass].every(valid) ||
			![m.itemsOffset, m.countOffset, m.versionOffset, m.pooledPtrOffset, m.playerIdOffset].every(
				(value) => Number.isInteger(value) && value >= 4 && value <= 4096
			)
		)
			return undefined;
		const pointer = (address: number) => {
			const bytes = read(address, layout.pointerSize);
			return fromPointer(bytes);
		};
		const fromPointer = (bytes: Buffer, offset = 0) => {
			const value = layout.pointerSize === 8 ? Number(bytes.readBigUInt64LE(offset)) : bytes.readUInt32LE(offset);
			if (!valid(value)) throw Error('Invalid SNR meeting pointer');
			return value;
		};
		const integer = (address: number) => read(address, 4).readInt32LE();
		const snapshot = (): SnrMeeting => {
			const enabled = read(m.enabledSlot, 1)[0];
			if (enabled === 0) return { enabled: false, currentPage: 1, playerIds: [] };
			if (enabled !== 1) throw Error('Invalid SNR paging flag');
			const currentPage = integer(m.pageSlot),
				list = pointer(m.areasSlot);
			if (pointer(list) !== m.listType) throw Error('SNR meeting list type changed');
			const count = integer(list + m.countOffset),
				version = integer(list + m.versionOffset);
			const items = pointer(list + m.itemsOffset),
				capacity = integer(items + layout.pointerSize);
			if (
				pointer(items) !== m.itemsType ||
				count < 1 ||
				count > 256 ||
				capacity < count ||
				capacity > 512 ||
				currentPage < 1 ||
				currentPage > Math.ceil(count / 15)
			)
				throw Error('Invalid SNR meeting page');
			const references = read(items + layout.arrayDataOffset, count * layout.pointerSize);
			const playerIds = Array.from({ length: count }, (_, index) => {
				const area = fromPointer(references, index * layout.pointerSize);
				const wrapper = read(area, m.pooledPtrOffset + layout.pointerSize);
				if (fromPointer(wrapper) !== m.voteAreaType) throw Error('SNR vote area type changed');
				const native = read(fromPointer(wrapper, m.pooledPtrOffset), m.playerIdOffset + 1);
				if (fromPointer(native) !== m.nativeClass) throw Error('SNR native vote area class changed');
				return native[m.playerIdOffset];
			});
			if (new Set(playerIds).size !== count || playerIds.includes(255) || integer(list + m.versionOffset) !== version)
				throw Error('SNR meeting order changed during read');
			return { enabled: true, currentPage, playerIds };
		};
		const first = snapshot(),
			second = snapshot();
		return JSON.stringify(first) === JSON.stringify(second) ? second : undefined;
	} catch {
		return undefined;
	}
}
