import { open } from 'node:fs/promises';

const pending = new Map<string, Promise<string | undefined>>();

/** Share an in-flight read, but never retain a completed role snapshot. */
export function readRoleStateFile(file: string, limit: number, fallback?: string): Promise<string | undefined> {
	const key = `${file}:${limit}:${fallback ?? ''}`;
	const existing = pending.get(key);
	if (existing) return existing;
	const request = load(file, limit)
		.catch((error: NodeJS.ErrnoException) => {
			if (fallback && error.code === 'ENOENT') return load(fallback, limit);
		})
		.catch(() => undefined);
	pending.set(key, request);
	void request.finally(() => {
		if (pending.get(key) === request) pending.delete(key);
	});
	return request;
}

async function load(file: string, limit: number): Promise<string | undefined> {
	const handle = await open(file, 'r');
	try {
		const { size } = await handle.stat();
		if (size > limit) return;
		const bytes = Buffer.alloc(size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > size) return;
		return bytes.toString('utf8', 0, offset);
	} finally {
		await handle.close();
	}
}
