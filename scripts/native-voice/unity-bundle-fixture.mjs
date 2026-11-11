// Minimal generated Unity 2019.4/v17 fixture. No game assets are redistributed.
class Writer {
	constructor(big = false) {
		this.big = big;
		this.parts = [];
		this.length = 0;
	}
	raw(b) {
		this.parts.push(Buffer.from(b));
		this.length += b.length;
		return this;
	}
	zero(n) {
		return this.raw(Buffer.alloc(n));
	}
	u32(v) {
		const b = Buffer.alloc(4);
		b[this.big ? 'writeUInt32BE' : 'writeUInt32LE'](v >>> 0);
		return this.raw(b);
	}
	u64(v) {
		const b = Buffer.alloc(8);
		b[this.big ? 'writeBigUInt64BE' : 'writeBigUInt64LE'](BigInt(v));
		return this.raw(b);
	}
	u16(v) {
		const b = Buffer.alloc(2);
		b[this.big ? 'writeUInt16BE' : 'writeUInt16LE'](v);
		return this.raw(b);
	}
	align(n = 4) {
		return this.zero((n - (this.length % n)) % n);
	}
	bytes(b) {
		return this.u32(b.length).raw(b).align();
	}
	string(s) {
		return this.bytes(Buffer.from(s));
	}
	ptr(id) {
		return this.u32(0).u64(id);
	}
	done() {
		return Buffer.concat(this.parts);
	}
}
export function unityBundleFixture() {
	const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 200, 100, 50, 255]);
	const texture = new Writer()
		.string('front')
		.u32(0)
		.zero(1)
		.align()
		.u32(2)
		.u32(2)
		.u32(16)
		.u32(4)
		.u32(1)
		.zero(4)
		.u32(0)
		.u32(1)
		.u32(2)
		.zero(24)
		.u32(0)
		.u32(1)
		.bytes(pixels)
		.u32(0)
		.u32(0)
		.string('')
		.done();
	const definition = JSON.stringify({ package: { name: 'bundlepack' }, hats: [{ hat_id: 'hat' }] });
	const text = new Writer().string('package').string(definition).done();
	const container = new Writer()
		.string('GeneratedSNR')
		.u32(0)
		.u32(2)
		.string('assets/hats/generated/package.json')
		.u32(0)
		.u32(0)
		.ptr(2)
		.string('assets/hats/generated/hat/front.png')
		.u32(0)
		.u32(0)
		.ptr(3)
		.u32(0)
		.u32(0)
		.ptr(0)
		.u32(0)
		.string('')
		.u32(0)
		.zero(2)
		.align()
		.u32(0).u32(0).u32(0)
		.done();
	const objects = [
			[1, 142, container],
			[2, 49, text],
			[3, 28, texture],
		],
		classes = [142, 49, 28];
	const m = new Writer().raw(Buffer.from('2019.4.0f1\0')).u32(5).zero(1).u32(classes.length);
	for (const type of classes) m.u32(type).zero(1).u16(65535).zero(16);
	m.u32(objects.length);
	let dataSize = 0;
	const starts = [];
	for (const [id, type, data] of objects) {
		m.align().u64(id).u32(dataSize).u32(data.length).u32(classes.indexOf(type));
		starts.push(dataSize);
		dataSize = Math.ceil((dataSize + data.length) / 8) * 8;
	}
	m.u32(0)
		.u32(0)
		.raw(Buffer.from([0]));
	const metadata = m.done(),
		dataOffset = Math.ceil((20 + metadata.length) / 16) * 16;
	const serialized = Buffer.alloc(dataOffset + dataSize),
		header = new Writer(true).u32(metadata.length).u32(serialized.length).u32(17).u32(dataOffset).zero(4).done();
	header.copy(serialized);
	metadata.copy(serialized, 20);
	objects.forEach((o, i) => o[2].copy(serialized, dataOffset + starts[i]));
	const info = new Writer(true)
		.zero(16)
		.u32(1)
		.u32(serialized.length)
		.u32(serialized.length)
		.u16(0)
		.u32(1)
		.u64(0)
		.u64(serialized.length)
		.u32(4)
		.raw(Buffer.from('CAB-generated\0'))
		.done();
	const h = new Writer(true)
		.raw(Buffer.from('UnityFS\0'))
		.u32(6)
		.raw(Buffer.from('5.x.x\0'))
		.raw(Buffer.from('2019.4.0f1\0'));
	const sizeAt = h.length;
	h.u64(0).u32(info.length).u32(info.length).u32(64);
	const bundle = Buffer.concat([h.done(), info, serialized]);
	bundle.writeBigUInt64BE(BigInt(bundle.length), sizeAt);
	return { bundle, pixels, width: 2, height: 2 };
}
