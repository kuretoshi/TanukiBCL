import { parentPort } from 'node:worker_threads';
import { findSnrBundledCosmeticFile } from './snrBundleCosmetics';
import type { SnrCosmeticPart } from './snrCosmetics';

interface CosmeticRequest {
	id: number;
	gameExecutable: string;
	productId: string;
	part: SnrCosmeticPart;
	cacheRoot: string;
}

parentPort?.on('message', async (request: CosmeticRequest) => {
	let file: string | undefined;
	try {
		file = await findSnrBundledCosmeticFile(request.gameExecutable, request.productId, request.part, request.cacheRoot);
	} catch (error) {
		console.warn('[SNR cosmetics] Bundle worker failed:', error);
	}
	parentPort?.postMessage({ id: request.id, file });
});
