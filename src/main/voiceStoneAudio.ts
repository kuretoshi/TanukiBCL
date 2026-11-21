export function validStoneWav(data: Uint8Array): boolean {
	if (data.byteLength < 3244 || data.byteLength > 320044 || data.byteLength % 2 !== 0) return false;
	const b = Buffer.from(data);
	return (
		b.toString('ascii', 0, 4) === 'RIFF' &&
		b.readUInt32LE(4) === b.length - 8 &&
		b.toString('ascii', 8, 16) === 'WAVEfmt ' &&
		b.readUInt32LE(16) === 16 &&
		b.readUInt16LE(20) === 1 &&
		b.readUInt16LE(22) === 1 &&
		b.readUInt32LE(24) === 16000 &&
		b.readUInt32LE(28) === 32000 &&
		b.readUInt16LE(32) === 2 &&
		b.readUInt16LE(34) === 16 &&
		b.toString('ascii', 36, 40) === 'data' &&
		b.readUInt32LE(40) === b.length - 44
	);
}
