import { nosColorHex } from '../common/NosSnapshot';

interface PaletteLayout {
	pid: number;
	pointerSize: number;
	arraySlot: number;
	arrayType: number;
	arrayLengthOffset: number;
	arrayDataOffset: number;
	stride: number;
	r: number;
	g: number;
	b: number;
}

const pointerValid = (value: number) =>
	Number.isInteger(value) && value >= 0x10000 && value <= 0xfffffffc && value % 4 === 0;
export function isNosPaletteLayout(value: unknown, pid: number): value is PaletteLayout {
	if (!value || typeof value !== 'object') return false;
	const v = value as PaletteLayout;
	return (
		v.pid === pid &&
		v.pointerSize === 4 &&
		pointerValid(v.arraySlot) &&
		pointerValid(v.arrayType) &&
		v.arrayLengthOffset === 4 &&
		Number.isInteger(v.arrayDataOffset) &&
		v.arrayDataOffset >= 8 &&
		v.arrayDataOffset <= 64 &&
		Number.isInteger(v.stride) &&
		v.stride >= 12 &&
		v.stride <= 64 &&
		[v.r, v.g, v.b].every((offset) => Number.isInteger(offset) && offset >= 0 && offset + 4 <= v.stride)
	);
}

export function readNosPalette(layout: PaletteLayout, read: (address: number, size: number) => Buffer): string[] {
	const pointer = (address: number) => read(address, 4).readUInt32LE();
	const array = pointer(layout.arraySlot);
	if (!pointerValid(array) || pointer(array) !== layout.arrayType || pointer(array + layout.arrayLengthOffset) !== 32)
		throw new Error('NoS palette changed');
	const bytes = read(array + layout.arrayDataOffset, 32 * layout.stride);
	const colors = Array.from({ length: 32 }, (_, i) => {
		const values = [layout.r, layout.g, layout.b].map((offset) => bytes.readFloatLE(i * layout.stride + offset));
		if (!values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid NoS palette color');
		return nosColorHex({ colorR: values[0], colorG: values[1], colorB: values[2] })!;
	});
	if (
		pointer(layout.arraySlot) !== array ||
		pointer(array) !== layout.arrayType ||
		!read(array + layout.arrayDataOffset, bytes.length).equals(bytes)
	)
		throw new Error('NoS palette changed during read');
	return colors;
}

export class NosPaletteTracker {
	private pid = -1;
	private request = 0;
	private pending = false;
	private retryAt = 0;
	private layout?: PaletteLayout;
	constructor(private resolve: (pid: number) => Promise<unknown>) {}
	reset(): void {
		this.request++;
		this.pid = -1;
		this.pending = false;
		this.retryAt = 0;
		this.layout = undefined;
	}
	update(pid: number, read: (address: number, size: number) => Buffer): string[] | undefined {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		if (!this.layout && !this.pending && Date.now() >= this.retryAt) {
			this.pending = true;
			const request = ++this.request;
			void this.resolve(pid)
				.then((layout) => {
					if (request !== this.request) return;
					if (!isNosPaletteLayout(layout, pid)) throw new Error('Unsupported NoS palette');
					this.layout = layout;
				})
				.catch(() => {
					if (request === this.request) this.retryAt = Date.now() + 30000;
				})
				.finally(() => {
					if (request === this.request) this.pending = false;
				});
		}
		if (!this.layout) return undefined;
		try {
			return readNosPalette(this.layout, read);
		} catch {
			return undefined;
		}
	}
}
