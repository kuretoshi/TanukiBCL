import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadPath } from 'unity-asset-reader-node';
import { decodeImage, isImage, type DecodedImage, type ImageAsset } from 'unity-asset-reader-texture';
import { PNG } from 'pngjs';
import type { Sprite } from 'unity-asset-reader';
import type { SnrCosmeticPart } from './snrCosmetics';
import { restoreSnrSpriteCanvas } from './snrSpriteCanvas';

type BundleEnvironment = ReturnType<typeof loadPath>;
type BundleImage = { paths: string[]; adaptive: boolean; scale?: boolean };
type BundleIndex = { key: string; environment: BundleEnvironment; images: Map<string, BundleImage> };
export type SnrCosmeticAsset = { file: string; adaptive: boolean; scale?: boolean };
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

function indexBundle(environment: BundleEnvironment): Map<string, BundleImage> {
	const images = new Map<string, BundleImage>();
	const bundle = environment.objects.find((object) => object.type === 142)?.read() as
		{ m_Container?: [string, unknown][] } | undefined;
	for (const [path] of bundle?.m_Container ?? []) {
		if (!/^assets\/(hats|visors)\/[^/]+\/package\.json$/i.test(path)) continue;
		const asset = environment.get(path);
		if (asset?.type !== 'TextAsset') continue;
		let definition: {
			package?: { name?: string };
			hats?: {
				hat_id?: string;
				adaptive?: boolean;
				front?: boolean;
				back?: boolean;
				front_adaptive?: boolean;
				back_adaptive?: boolean;
			}[];
			visors?: { visor_id?: string; adaptive?: boolean; IsSNR?: boolean | string; isSNR?: boolean | string }[];
			Visors?: { visor_id?: string; adaptive?: boolean; IsSNR?: boolean | string; isSNR?: boolean | string }[];
		};
		try {
			definition = JSON.parse(asset.data.text.replace(/^\uFEFF/, ''));
		} catch {
			continue;
		}
		const packageName = definition.package?.name;
		if (!packageName) continue;
		const prefix = path.slice(0, -'/package.json'.length);
		for (const hat of definition.hats ?? []) {
			if (!hat.hat_id) continue;
			const id = `Modded_${packageName}_${hat.hat_id}`;
			const front = hat.front_adaptive === true || (hat.adaptive === true && hat.front !== false);
			const back = hat.back_adaptive === true || (hat.adaptive === true && hat.back === true);
			images.set(`hat-front:${id}`, { paths: [`${prefix}/${hat.hat_id}/front.png`], adaptive: front });
			images.set(`hat-back:${id}`, { paths: [`${prefix}/${hat.hat_id}/back.png`], adaptive: back });
			images.set(`skin:${id}`, { paths: [`${prefix}/${hat.hat_id}/front.png`], adaptive: front });
		}
		for (const visor of definition.visors ?? definition.Visors ?? []) {
			if (!visor.visor_id) continue;
			const id = `Modded_${packageName}_${visor.visor_id}`;
			const flag = visor.IsSNR ?? visor.isSNR;
			images.set(`visor:${id}`, {
				paths: [`${prefix}/${visor.visor_id}/idle.png`, `${prefix}/${visor.visor_id}/front.png`],
				adaptive: visor.adaptive === true,
				scale: flag === undefined ? undefined : flag === true || flag === 'true',
			});
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

function fullSpriteCanvas(asset: ImageAsset, image: DecodedImage) {
	let { rgba, width, height } = image;
	if (asset.type === 'Sprite') {
		const sprite = asset.reader.read() as Sprite;
		let render = sprite.m_RD;
		const atlas = sprite.m_SpriteAtlas && asset.env.resolve(sprite.m_SpriteAtlas, asset.reader);
		if (atlas?.status === 'found') {
			const key = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
			const data = atlas.object.read() as { m_RenderDataMap: [unknown, typeof render][] };
			const entry = data.m_RenderDataMap.find(([candidate]) => key(candidate) === key(sprite.m_RenderDataKey));
			if (!entry) throw new Error('SNR sprite atlas rectangle is missing');
			render = entry[1];
		}
		({ rgba, width, height } = restoreSnrSpriteCanvas(
			{ rgba, width, height },
			sprite.m_Rect,
			render.textureRectOffset
		));
	}
	return { rgba, width, height };
}

async function extractImage(
	bundle: BundleIndex,
	id: string,
	part: SnrCosmeticPart,
	output: string,
	cacheRoot: string
): Promise<string | undefined> {
	for (const path of bundle.images.get(`${part}:${id}`)?.paths ?? []) {
		const asset = bundle.environment.get(path);
		if (!asset || !isImage(asset)) continue;
		const { rgba, width, height } = fullSpriteCanvas(asset, await decodeImage(asset));
		if (width <= 0 || height <= 0 || width > 4096 || height > 4096) continue;
		await mkdir(cacheRoot, { recursive: true });
		await writeFile(output, PNG.sync.write({ data: Buffer.from(rgba), width, height }));
		return output;
	}
	return undefined;
}

/** Extract only the requested sprite from SNR's locally installed Unity bundle. */
export async function findSnrBundledCosmetic(
	gameExecutable: string,
	productId: string,
	part: SnrCosmeticPart,
	cacheRoot: string
): Promise<SnrCosmeticAsset | undefined> {
	if (!productId.startsWith('Modded_')) return undefined;
	const id = productId.replace(/<[^>]*>/g, '');
	for (const file of bundleFiles(gameExecutable)) {
		try {
			const bundle = loadedBundle(file);
			const image = bundle.images.get(`${part}:${id}`);
			if (!image) continue;
			const stat = statSync(file);
			const output = join(
				cacheRoot,
				createHash('sha256').update(`full-canvas-v2:${file}:${stat.size}:${stat.mtimeMs}:${part}:${id}`).digest('hex') +
					'.png'
			);
			if (existsSync(output)) return { file: output, adaptive: image.adaptive, scale: image.scale };
			const extracted = await extractImage(bundle, id, part, output, cacheRoot);
			if (extracted) return { file: extracted, adaptive: image.adaptive, scale: image.scale };
		} catch (error) {
			console.warn('[SNR cosmetics] Could not read bundle:', file, error);
		}
	}
	return undefined;
}

export async function findSnrBundledCosmeticFile(
	gameExecutable: string,
	productId: string,
	part: SnrCosmeticPart,
	cacheRoot: string
): Promise<string | undefined> {
	return (await findSnrBundledCosmetic(gameExecutable, productId, part, cacheRoot))?.file;
}
