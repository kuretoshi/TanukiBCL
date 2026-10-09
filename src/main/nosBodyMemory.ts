export interface NosBodyLayout {
	pointerSize: 4 | 8;
	controlAddress: number;
	controlClass: number;
	cosmeticsClass: number;
	playerIdOffset: number;
	cosmeticsOffset: number;
	bodyTypeOffset: number;
}

const validPointer = (value: number, size: number) =>
	Number.isSafeInteger(value) && value > 0x10000 && value % size === 0 && (size === 8 || value <= 0xffffffff);

export function isNosBodyLayout(value: unknown): value is NosBodyLayout {
	if (!value || typeof value !== 'object') return false;
	const layout = value as NosBodyLayout;
	return (
		(layout.pointerSize === 4 || layout.pointerSize === 8) &&
		[layout.controlAddress, layout.controlClass, layout.cosmeticsClass].every((n) =>
			validPointer(n, layout.pointerSize)
		) &&
		[layout.playerIdOffset, layout.cosmeticsOffset, layout.bodyTypeOffset].every(
			(n) => Number.isInteger(n) && n >= 2 * layout.pointerSize && n <= 4096
		)
	);
}

/** Read every game tick; a changed identity, pointer or class disables the effect immediately. */
export function readNosBodyType(
	layout: NosBodyLayout,
	playerId: number,
	read: (address: number, size: number) => Buffer
): number {
	const pointer = (address: number) => {
		const bytes = read(address, layout.pointerSize);
		const value = layout.pointerSize === 8 ? Number(bytes.readBigUInt64LE()) : bytes.readUInt32LE();
		if (!validPointer(value, layout.pointerSize)) throw new Error('Invalid NoS native pointer');
		return value;
	};
	const control = layout.controlAddress;
	if (pointer(control) !== layout.controlClass || read(control + layout.playerIdOffset, 1)[0] !== playerId)
		throw new Error('NoS native player identity changed');
	const cosmetics = pointer(control + layout.cosmeticsOffset);
	if (pointer(cosmetics) !== layout.cosmeticsClass) throw new Error('NoS cosmetics class changed');
	const bodyType = read(cosmetics + layout.bodyTypeOffset, 4).readInt32LE();
	if (bodyType < 0 || bodyType > 32) throw new Error('Invalid NoS body type');
	if (
		pointer(control) !== layout.controlClass ||
		read(control + layout.playerIdOffset, 1)[0] !== playerId ||
		pointer(control + layout.cosmeticsOffset) !== cosmetics
	)
		throw new Error('NoS body changed during read');
	return bodyType;
}
