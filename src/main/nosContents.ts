import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { createJimp } from '@jimp/core';
import png from '@jimp/js-png';
import { indexNosAddonImages, readNosZipImage, type NosZipImage } from './nosAddonImages';
import type { AmongUsState, Player } from '../common/AmongUsState';
import type { NosPlayerData } from '../common/NosSnapshot';

const Jimp = createJimp({ formats: [png] });
type Bitmap = Awaited<ReturnType<typeof Jimp.read>>['bitmap'];
const DECODED_BUDGET = 16 * 1024 * 1024;
type Part = 'hat' | 'hatBack' | 'visor' | 'skin' | 'bodyMask';
interface ImageEntry {
	Layer: string;
	Address?: string;
	ExAddress?: string;
	MaskAddress?: string;
	ExIsFront?: boolean;
	DivisionX: number;
	DivisionY: number;
}
interface CostumeEntry {
	ProductId: string;
	RelatedRawLocalPath?: string;
	Adaptive?: boolean;
	Images: ImageEntry[];
}
interface Asset {
	file: string | NosZipImage;
	extra?: string | NosZipImage;
	extraInFront: boolean;
	columns: number;
	rows: number;
	adaptive: boolean;
	mask?: boolean;
}

/** Read the game's exported manifest and serve only its locally registered PNGs. */
export class NosContentsTracker {
	private nextRead = 0;
	private signature = '';
	private result?: AmongUsState['nosLoadedContents'];
	private assets = new Map<string, Asset>();
	private costumes = new Map<string, Partial<Record<Part, string>>>();
	private images = new Map<string, Promise<Buffer | undefined>>();
	private decoded = new Map<string, Bitmap>();
	private decoding = new Map<string, Promise<Bitmap>>();
	private decodedBytes = 0;
	private generation = 0;
	private root = '';
	private addonImages?: Map<string, ReadonlyMap<string, NosZipImage>>;

	update(gameDirectory: string): NonNullable<AmongUsState['nosLoadedContents']> {
		const file = path.join(gameDirectory, 'BepInEx', 'MoreCosmic', 'LoadedContents.json');
		if (this.result?.path === file && Date.now() < this.nextRead) return this.result;
		this.nextRead = Date.now() + 2000;
		try {
			const stat = fs.statSync(file);
			if (stat.size > 4 * 1024 * 1024) throw new Error('ファイルが4MBを超えています');
			const signature = `${file}:${stat.mtimeMs}:${stat.size}`;
			if (signature === this.signature && this.result) return this.result;
			this.clear();
			this.root = fs.realpathSync(gameDirectory);
			const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
			if (data.Version === 20261005) {
				this.register(data.Hats, 'hat', signature);
				this.register(data.Visors, 'visor', signature);
				this.register(data.Skins, 'skin', signature);
			}
			this.signature = signature;
			this.result = {
				path: file,
				status: data.Version === 20261005 ? '読み取り成功' : '画像表示は未対応の定義バージョンです',
				data,
			};
		} catch (error) {
			this.clear();
			this.result = { path: file, status: `読み取り失敗: ${error instanceof Error ? error.message : String(error)}` };
		}
		return this.result;
	}

	private clear(): void {
		this.generation++;
		this.signature = '';
		this.assets.clear();
		this.costumes.clear();
		this.images.clear();
		this.decoded.clear();
		this.decoding.clear();
		this.decodedBytes = 0;
		this.addonImages = undefined;
	}

	private localFile(base: string, address: string): string | undefined {
		try {
			const file = fs.realpathSync(
				path.resolve(this.root, base.replace(/[\\/]/g, path.sep), address.replace(/[\\/]/g, path.sep))
			);
			const relative = path.relative(this.root, file);
			if (
				!relative ||
				relative.startsWith('..') ||
				path.isAbsolute(relative) ||
				path.extname(file).toLowerCase() !== '.png'
			)
				return undefined;
			if (fs.statSync(file).size > 16 * 1024 * 1024) return undefined;
			return file;
		} catch {
			return undefined;
		}
	}

	private register(collection: unknown, kind: 'hat' | 'visor' | 'skin', revision: string): void {
		if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return;
		for (const [id, value] of Object.entries(collection)) {
			const costume = value as CostumeEntry;
			if (!costume || !Array.isArray(costume.Images)) continue;
			const parts: Partial<Record<Part, string>> = {};
			for (const [part, layer] of [[kind, 'Main'], ...(kind === 'hat' ? [['hatBack', 'Back']] : [])] as [
				Part,
				string,
			][]) {
				const image = costume.Images.find((image) => image?.Layer === layer);
				if (
					!image ||
					typeof image.Address !== 'string' ||
					!Number.isInteger(image.DivisionX) ||
					!Number.isInteger(image.DivisionY) ||
					image.DivisionX < 1 ||
					image.DivisionX > 256 ||
					image.DivisionY < 1 ||
					image.DivisionY > 256
				)
					continue;
				const findImage = (address: string) =>
					typeof costume.RelatedRawLocalPath === 'string'
						? this.localFile(costume.RelatedRawLocalPath, address)
						: (this.addonImages ??= indexNosAddonImages(this.root)).get(id)?.get(address.replace(/\\/g, '/'));
				const file = findImage(image.Address);
				if (!file) continue;
				const extra = typeof image.ExAddress === 'string' ? findImage(image.ExAddress) : undefined;
				const key = createHash('sha256').update(`${revision}:${kind}:${id}:${part}`).digest('hex');
				this.assets.set(key, {
					file,
					extra,
					extraInFront: image.ExIsFront === true,
					columns: image.DivisionX,
					rows: image.DivisionY,
					adaptive: costume.Adaptive === true,
				});
				parts[part] = key;
				if (kind === 'hat' && layer === 'Main' && typeof image.MaskAddress === 'string')
					this.registerBodyMask(findImage(image.MaskAddress), key, image.DivisionX, image.DivisionY, parts);
			}
			if (!Object.keys(parts).length) continue;
			this.costumes.set(`${kind}:${id}`, parts);
			if (typeof costume.ProductId === 'string') this.costumes.set(`${kind}:${costume.ProductId}`, parts);
		}
	}

	private registerBodyMask(
		file: string | NosZipImage | undefined,
		key: string,
		columns: number,
		rows: number,
		parts: Partial<Record<Part, string>>
	): void {
		if (!file) return;
		const maskKey = `${key}mask`;
		this.assets.set(maskKey, { file, extraInFront: false, columns, rows, adaptive: false, mask: true });
		parts.bodyMask = maskKey;
	}

	/** Lobby outfits exist before NoS publishes its round's PlayerData. */
	lobbyCosmetics(player: Player, color?: string): Player['nosCosmetics'] {
		if (player.disconnected) return undefined;
		const rgb = /^#[0-9a-f]{6}$/i.test(color ?? '')
			? [1, 3, 5].map((offset) => parseInt(color!.slice(offset, offset + 2), 16) / 255)
			: [1, 1, 1];
		return this.cosmetics({
			skin: { name: player.appearanceSkinId ?? player.skinId },
			hat: { name: player.appearanceHatId ?? player.hatId },
			visor: { name: player.appearanceVisorId ?? player.visorId },
			colorR: rgb[0],
			colorG: rgb[1],
			colorB: rgb[2],
		});
	}

	cosmetics(
		player?: Pick<NosPlayerData, 'skin' | 'hat' | 'visor' | 'colorR' | 'colorG' | 'colorB'>
	): Player['nosCosmetics'] {
		if (!player) return undefined;
		const result: NonNullable<Player['nosCosmetics']> = {};
		const color = [player.colorR, player.colorG, player.colorB].join(',');
		for (const kind of ['skin', 'hat', 'visor'] as const) {
			const parts = this.costumes.get(`${kind}:${player[kind]?.name ?? ''}`);
			if (parts)
				for (const [part, key] of Object.entries(parts)) {
					const tint = this.assets.get(key)?.adaptive ? color : '1,1,1';
					result[part as Part] = `nos-cosmetic://image/${key}?color=${encodeURIComponent(tint)}`;
				}
		}
		return Object.keys(result).length ? result : undefined;
	}

	async image(key: string, color: string): Promise<Buffer | undefined> {
		const asset = this.assets.get(key);
		if (!asset) return undefined;
		const rgb = color.split(',').map(Number);
		if (rgb.length !== 3 || !rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
		// Fixed colors and body masks do not vary with the player's body color.
		color = asset.adaptive ? rgb.join(',') : '1,1,1';
		const cacheKey = `${key}:${color}`;
		const existing = this.images.get(cacheKey);
		if (existing) {
			this.images.delete(cacheKey);
			this.images.set(cacheKey, existing);
			return existing;
		}
		if (this.images.size >= 128) this.images.delete(this.images.keys().next().value!);
		const request = this.render(asset, color).catch(() => undefined);
		this.images.set(cacheKey, request);
		if (!(await request) && this.images.get(cacheKey) === request) this.images.delete(cacheKey);
		return request;
	}

	private async source(file: string | NosZipImage): Promise<Bitmap> {
		const generation = this.generation;
		const canonical = await fs.promises.realpath(typeof file === 'string' ? file : file.archive);
		const relative = path.relative(this.root, canonical);
		if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Image unavailable');
		const stat = await fs.promises.stat(canonical, { bigint: true });
		if (typeof file === 'string' && stat.size > 16 * 1024 * 1024) throw new Error('Image too large');
		const entry = typeof file === 'string' ? '' : `${file.offset}:${file.compressedSize}:${file.size}:${file.method}`;
		const key = `${canonical}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${entry}`;
		const cached = this.decoded.get(key);
		if (cached) {
			this.decoded.delete(key);
			this.decoded.set(key, cached);
			return cached;
		}
		const pending = this.decoding.get(key);
		if (pending) return pending;
		const request = this.decode(typeof file === 'string' ? canonical : { ...file, archive: canonical }).then(
			(bitmap) => {
				if (generation === this.generation) this.rememberSource(key, bitmap);
				return bitmap;
			}
		);
		this.decoding.set(key, request);
		try {
			return await request;
		} finally {
			if (this.decoding.get(key) === request) this.decoding.delete(key);
		}
	}

	private rememberSource(key: string, bitmap: Bitmap): void {
		if (bitmap.data.length > DECODED_BUDGET) return;
		while (this.decoded.size && (this.decoded.size >= 32 || this.decodedBytes + bitmap.data.length > DECODED_BUDGET)) {
			const oldest = this.decoded.keys().next().value!;
			this.decodedBytes -= this.decoded.get(oldest)!.data.length;
			this.decoded.delete(oldest);
		}
		this.decoded.set(key, bitmap);
		this.decodedBytes += bitmap.data.length;
	}

	private async decode(file: string | NosZipImage): Promise<Bitmap> {
		const bytes = typeof file === 'string' ? await fs.promises.readFile(file) : readNosZipImage(file);
		if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16 * 1024 * 1024)
			throw new Error('Image too large');
		return (await Jimp.read(bytes)).bitmap;
	}

	private async render(asset: Asset, color: string): Promise<Buffer> {
		const rgb = color.split(',').map(Number);
		if (rgb.length !== 3 || !rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
			throw new Error('Invalid color');
		const output = Buffer.alloc(300 * 375 * 4, asset.mask ? 255 : 0);
		const draw = async (file: string | NosZipImage, adaptive: boolean) => {
			const { width, height, data } = await this.source(file);
			if (width % asset.columns || height % asset.rows) throw new Error('Invalid sprite divisions');
			const w = width / asset.columns,
				h = height / asset.rows;
			const left = Math.round((300 - w) * 0.53),
				top = Math.round((375 - h) * 0.425);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const dx = left + x,
						dy = top + y;
					if (dx < 0 || dy < 0 || dx >= 300 || dy >= 375) continue;
					const source = (y * width + x) * 4,
						target = (dy * 300 + dx) * 4;
					const a = data[source + 3] / 255,
						oldA = output[target + 3] / 255,
						alpha = a + oldA * (1 - a);
					if (!alpha) continue;
					if (asset.mask) {
						output[target + 3] = 255 - Math.round(data[source] * a);
						continue;
					}

					for (let channel = 0; channel < 3; channel++) {
						const pixel = adaptive
							? Math.min(
									255,
									data[source] * rgb[channel] +
										data[source + 1] * [0.604, 0.792, 0.835][channel] +
										data[source + 2] * rgb[channel] * 0.55
								)
							: data[source + channel];
						output[target + channel] = Math.round((pixel * a + output[target + channel] * oldA * (1 - a)) / alpha);
					}
					output[target + 3] = Math.round(alpha * 255);
				}
		};
		if (asset.extra && !asset.extraInFront) await draw(asset.extra, false);
		await draw(asset.file, asset.adaptive);
		if (asset.extra && asset.extraInFront) await draw(asset.extra, false);
		return Jimp.fromBitmap({ width: 300, height: 375, data: output }).getBuffer('image/png');
	}
}
