import { parentPort } from 'node:worker_threads';
import { findSnrBundledCosmetic } from './snrBundleCosmetics';
import type { SnrCosmeticPart } from './snrCosmetics';

interface CosmeticRequest {
	id: number;
	gameExecutable: string;
	productId: string;
	part: SnrCosmeticPart;
	cacheRoot: string;
}

parentPort?.on('message', async (request: CosmeticRequest) => {
	let asset: Awaited<ReturnType<typeof findSnrBundledCosmetic>>;
	try {
		asset = await findSnrBundledCosmetic(request.gameExecutable, request.productId, request.part, request.cacheRoot);
	} catch (error) {
		console.warn('[SNR cosmetics] Bundle worker failed:', error);
	}
	parentPort?.postMessage({ id: request.id, ...asset });
});
