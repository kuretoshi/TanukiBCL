function crc32(bytes) {
	let crc = -1;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ -1) >>> 0;
}
export function zipFixture(files) {
	const local = [],
		central = [];
	let offset = 0;
	for (const [path, bytes] of files) {
		const name = Buffer.from(path),
			header = Buffer.alloc(30),
			entry = Buffer.alloc(46);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc32(bytes), 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(name.length, 26);
		entry.writeUInt32LE(0x02014b50);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc32(bytes), 16);
		entry.writeUInt32LE(bytes.length, 20);
		entry.writeUInt32LE(bytes.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		local.push(header, name, bytes);
		central.push(entry, name);
		offset += header.length + name.length + bytes.length;
	}
	const directory = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}
