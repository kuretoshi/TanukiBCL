import { Worker } from 'node:worker_threads';
import type { SnrCosmeticPart } from './snrCosmetics';
import type { SnrCosmeticAsset } from './snrBundleCosmetics';

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (asset: SnrCosmeticAsset | undefined) => void>();

function getWorker(): Worker {
	if (worker) return worker;
	const instance = new Worker(new URL('./snrCosmeticsWorker.js', import.meta.url));
	instance.unref();
	worker = instance;
	instance.on(
		'message',
		({ id, file, adaptive, scale }: { id: number; file?: string; adaptive?: boolean; scale?: boolean }) => {
			pending.get(id)?.(file ? { file, adaptive: adaptive === true, scale } : undefined);
			pending.delete(id);
		}
	);
	const finish = (error?: Error) => {
		if (worker !== instance) return;
		worker = undefined;
		if (error) console.warn('[SNR cosmetics] Bundle worker stopped:', error);
		for (const resolve of pending.values()) resolve(undefined);
		pending.clear();
	};
	instance.on('error', finish);
	instance.on('exit', () => finish());
	return instance;
}

/** Read SNR's bundle without blocking game updates and voice controls on the main thread. */
export function findSnrBundledCosmetic(
	gameExecutable: string,
	productId: string,
	part: SnrCosmeticPart,
	cacheRoot: string
): Promise<SnrCosmeticAsset | undefined> {
	return new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		try {
			getWorker().postMessage({ id, gameExecutable, productId, part, cacheRoot });
		} catch (error) {
			pending.delete(id);
			console.warn('[SNR cosmetics] Could not start bundle worker:', error);
			resolve(undefined);
		}
	});
}
