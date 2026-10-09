import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface NosZipImage {
	archive: string;
	entry: string;
	offset: number;
	compressedSize: number;
	size: number;
	method: number;
}

/** Index addon ZIP entries without extracting or modifying the game folder. */
function entries(archive: string): Map<string, NosZipImage> {
	const handle = fs.openSync(archive, 'r');
	try {
		const size = fs.fstatSync(handle).size;
		if (size > 512 * 1024 * 1024) throw new Error('Addon too large');
		const tail = Buffer.alloc(Math.min(size, 65557));
		fs.readSync(handle, tail, 0, tail.length, size - tail.length);
		let end = tail.length - 22;
		while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
		if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP');
		const length = tail.readUInt32LE(end + 12),
			offset = tail.readUInt32LE(end + 16);
		if (length > 16 * 1024 * 1024 || offset + length > size) throw new Error('Invalid ZIP directory');
		const directory = Buffer.alloc(length);
		fs.readSync(handle, directory, 0, length, offset);
		const result = new Map<string, NosZipImage>();
		for (let cursor = 0; cursor < length;) {
			if (directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
			const nameLength = directory.readUInt16LE(cursor + 28),
				extra = directory.readUInt16LE(cursor + 30),
				comment = directory.readUInt16LE(cursor + 32);
			const entry = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
			if (!(directory.readUInt16LE(cursor + 8) & 1) && !entry.endsWith('/') && !entry.split('/').includes('..'))
				result.set(entry, {
					archive,
					entry,
					offset: directory.readUInt32LE(cursor + 42),
					compressedSize: directory.readUInt32LE(cursor + 20),
					size: directory.readUInt32LE(cursor + 24),
					method: directory.readUInt16LE(cursor + 10),
				});
			cursor += 46 + nameLength + extra + comment;
		}
		return result;
	} finally {
		fs.closeSync(handle);
	}
}

export function readNosZipImage(image: NosZipImage): Buffer {
	if (image.size > 16 * 1024 * 1024 || image.compressedSize > 16 * 1024 * 1024 || ![0, 8].includes(image.method))
		throw new Error('Invalid ZIP image');
	const handle = fs.openSync(image.archive, 'r');
	try {
		const header = Buffer.alloc(30);
		fs.readSync(handle, header, 0, 30, image.offset);
		if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP header');
		const bytes = Buffer.alloc(image.compressedSize);
		const offset = image.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
		if (fs.readSync(handle, bytes, 0, bytes.length, offset) !== bytes.length) throw new Error('Incomplete ZIP image');
		const result = image.method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
		if (result.length !== image.size) throw new Error('Invalid ZIP image size');
		return result;
	} finally {
		fs.closeSync(handle);
	}
}

function registerContents(
	all: Map<string, NosZipImage>,
	name: string,
	entry: NosZipImage,
	result: Map<string, Map<string, NosZipImage>>
): void {
	const contents = JSON.parse(
		readNosZipImage(entry)
			.toString('utf8')
			.replace(/^\uFEFF/, '')
	);
	const root = name.slice(0, -'Contents.json'.length);
	for (const [category, prefix] of [
		['hats', 'noshat_'],
		['visors', 'nosvisor_'],
	]) {
		if (!Array.isArray(contents[category])) continue;
		const directory = `${root}${category}/`;
		// Every costume in a category shares this directory; scan it once.
		const images = [...all]
			.filter(([name]) => name.startsWith(directory) && name.endsWith('.png'))
			.map(([name, image]) => [name.slice(directory.length), image] as const);
		for (const costume of contents[category]) {
			if (typeof costume.Author !== 'string' || typeof costume.Name !== 'string') continue;
			result.set(`${prefix}${costume.Author}_${costume.Name}`, new Map(images));
		}
	}
}

function indexArchive(gameDirectory: string, file: string, result: Map<string, Map<string, NosZipImage>>): void {
	try {
		const archive = fs.realpathSync(path.join(gameDirectory, 'Addons', file));
		if (path.relative(gameDirectory, archive).startsWith('..')) return;
		const all = entries(archive);
		for (const [name, entry] of all) {
			if (!name.endsWith('MoreCosmic/Contents.json') || entry.size > 4 * 1024 * 1024) continue;
			registerContents(all, name, entry, result);
		}
	} catch {
		/* Ignore an unavailable or unsupported addon; folder cosmetics still work. */
	}
}

export function indexNosAddonImages(gameDirectory: string): Map<string, Map<string, NosZipImage>> {
	const result = new Map<string, Map<string, NosZipImage>>();
	const directory = path.join(gameDirectory, 'Addons');
	if (!fs.existsSync(directory)) return result;
	for (const file of fs.readdirSync(directory)) {
		if (file.toLowerCase().endsWith('.zip')) indexArchive(gameDirectory, file, result);
	}
	return result;
}

/** Identify installed NoS addons by addon.meta, independent of ZIP filenames. */
export function readNosAddonIds(gameDirectory: string): string[] {
	const result = new Set<string>();
	try {
		for (const file of fs.readdirSync(path.join(gameDirectory, 'Addons'))) {
			if (!file.toLowerCase().endsWith('.zip')) continue;
			collectNosAddonIds(gameDirectory, file, result);
		}
	} catch {
		/* The addon folder is optional. */
	}
	return [...result].sort();
}

function collectNosAddonIds(gameDirectory: string, file: string, result: Set<string>): void {
	try {
		const archive = fs.realpathSync(path.join(gameDirectory, 'Addons', file));
		if (path.relative(gameDirectory, archive).startsWith('..')) return;
		for (const [name, entry] of entries(archive)) {
			if ((!name.endsWith('/addon.meta') && name !== 'addon.meta') || entry.size > 65536) continue;
			// NoS metadata can contain non-JSON True/False literals.
			const text = readNosZipImage(entry).toString('utf8');
			const id = /"Id"\s*:\s*"([A-Za-z0-9_.-]{1,128})"/.exec(text)?.[1];
			if (id) result.add(id);
		}
	} catch {
		/* Ignore unreadable addons. */
	}
}
