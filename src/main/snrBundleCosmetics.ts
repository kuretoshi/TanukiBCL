import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadPath } from 'unity-asset-reader-node';
import { decodeImage, isImage } from 'unity-asset-reader-texture';
import { PNG } from 'pngjs';
import type { SnrCosmeticPart } from './snrCosmetics';

type BundleEnvironment = ReturnType<typeof loadPath>;
type BundleIndex = { key: string; environment: BundleEnvironment; images: Map<string, string[]> };
let cachedBundle: BundleIndex | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function bundleFiles(gameExecutable: string): string[] {
	const root = join(dirname(gameExecutable), 'SuperNewRolesNext', 'CustomCosmetics');
	if (!existsSync(root)) return [];
	const files: { path: string; changed: number }[] = [];
	for (const folder of readdirSync(root, { withFileTypes: true })) {
		if (!folder.isDirectory() || !folder.name.toLowerCase().endsWith('.bundle')) continue;
		const directory = join(root, folder.name);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.bundle')) continue;
			const path = join(directory, entry.name);
			files.push({ path, changed: statSync(path).mtimeMs });
		}
	}
	return files.sort((a, b) => b.changed - a.changed).map((file) => file.path);
}

function indexBundle(environment: BundleEnvironment): Map<string, string[]> {
	const images = new Map<string, string[]>();
	const bundle = environment.objects.find((object) => object.type === 142)?.read() as
		{ m_Container?: [string, unknown][] } | undefined;
	for (const [path] of bundle?.m_Container ?? []) {
		if (!/^assets\/(hats|visors)\/[^/]+\/package\.json$/i.test(path)) continue;
		const asset = environment.get(path);
		if (asset?.type !== 'TextAsset') continue;
		let definition: {
			package?: { name?: string };
			hats?: { hat_id?: string }[];
			visors?: { visor_id?: string }[];
			Visors?: { visor_id?: string }[];
		};
		try {
			definition = JSON.parse(asset.data.text);
		} catch {
			continue;
		}
		const packageName = definition.package?.name;
		if (!packageName) continue;
		const prefix = path.slice(0, -'/package.json'.length);
		for (const hat of definition.hats ?? []) {
			if (!hat.hat_id) continue;
			const id = `Modded_${packageName}_${hat.hat_id}`;
			images.set(`hat-front:${id}`, [`${prefix}/${hat.hat_id}/front.png`]);
			images.set(`hat-back:${id}`, [`${prefix}/${hat.hat_id}/back.png`]);
			images.set(`skin:${id}`, [`${prefix}/${hat.hat_id}/front.png`]);
		}
		for (const visor of definition.visors ?? definition.Visors ?? []) {
			if (!visor.visor_id) continue;
			const id = `Modded_${packageName}_${visor.visor_id}`;
			images.set(`visor:${id}`, [`${prefix}/${visor.visor_id}/idle.png`, `${prefix}/${visor.visor_id}/front.png`]);
		}
	}
	return images;
}

function loadedBundle(file: string): BundleIndex {
	const stat = statSync(file);
	const key = `${file}:${stat.size}:${stat.mtimeMs}`;
	if (releaseTimer) clearTimeout(releaseTimer);
	releaseTimer = setTimeout(() => {
		cachedBundle = undefined;
		releaseTimer = undefined;
	}, 120_000);
	releaseTimer.unref();
	if (cachedBundle?.key === key) return cachedBundle;
	const environment = loadPath(file);
	cachedBundle = { key, environment, images: indexBundle(environment) };
	return cachedBundle;
}

/** Extract only the requested sprite from SNR's locally installed Unity bundle. */
export async function findSnrBundledCosmeticFile(
	gameExecutable: string,
	productId: string,
	part: SnrCosmeticPart,
	cacheRoot: string
): Promise<string | undefined> {
	if (!productId.startsWith('Modded_')) return undefined;
	const id = productId.replace(/<[^>]*>/g, '');
	for (const file of bundleFiles(gameExecutable)) {
		try {
			const stat = statSync(file);
			const output = join(
				cacheRoot,
				createHash('sha256').update(`${file}:${stat.size}:${stat.mtimeMs}:${part}:${id}`).digest('hex') + '.png'
			);
			if (existsSync(output)) return output;
			const bundle = loadedBundle(file);
			for (const path of bundle.images.get(`${part}:${id}`) ?? []) {
				const asset = bundle.environment.get(path);
				if (!asset || !isImage(asset)) continue;
				const { rgba, width, height } = await decodeImage(asset);
				if (width <= 0 || height <= 0 || width > 4096 || height > 4096) continue;
				await mkdir(cacheRoot, { recursive: true });
				await writeFile(output, PNG.sync.write({ data: Buffer.from(rgba), width, height }));
				return output;
			}
		} catch (error) {
			console.warn('[SNR cosmetics] Could not read bundle:', file, error);
		}
	}
	return undefined;
}
