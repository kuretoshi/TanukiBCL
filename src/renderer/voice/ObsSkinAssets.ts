import type { Player } from '../../common/AmongUsState';

const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 4;
const RETRY_DELAY_MS = 1500;

export function obsAppearance(player: Player, mod: string) {
	const outfit = player.currentOutfit > 0 && player.currentOutfit <= 10;
	const display = (original: string, current: string) =>
		outfit || current.startsWith('Modded_') ? current : original;
	const hatId = mod === 'NoS' && player.nosPlayer?.hat?.name
		? player.nosPlayer.hat.name
		: display(player.hatId, player.appearanceHatId);
	const skinId = mod === 'NoS' && player.nosPlayer?.skin?.name
		? player.nosPlayer.skin.name
		: display(player.skinId, player.appearanceSkinId);
	const visorId = mod === 'NoS' && player.nosPlayer?.visor?.name
		? player.nosPlayer.visor.name
		: display(player.visorId, player.appearanceVisorId);
	return {
		hatId,
		skinId,
		visorId,
		skinSource:
			mod === 'NoS' && player.nosCosmetics?.skin?.startsWith('nos-cosmetic://image/')
				? player.nosCosmetics.skin
				: mod === 'SUPER_NEW_ROLES' && skinId.startsWith('Modded_')
					? `snr-cosmetic://skin/${encodeURIComponent(skinId)}`
					: undefined,
		bodyMaskSource:
			mod === 'NoS' && player.nosCosmetics?.bodyMask?.startsWith('nos-cosmetic://image/')
				? player.nosCosmetics.bodyMask
				: undefined,
	};
}

export function isObsSkinSource(source: string): boolean {
	return source.length <= 512 &&
		(source.startsWith('nos-cosmetic://image/') || source.startsWith('snr-cosmetic://skin/'));
}

/** Only current lobby cosmetics are eligible for transfer to the local OBS browser source. */
export class ObsSkinAssets {
	private session = '';
	private generation = 0;
	private active = new Set<string>();
	private cache = new Map<string, string>();
	private pending = new Map<string, Promise<string | undefined>>();
	private retryAt = new Map<string, number>();
	private bytes = 0;

	reset(): void {
		this.generation++;
		this.session = '';
		this.active.clear();
		this.cache.clear();
		this.pending.clear();
		this.retryAt.clear();
		this.bytes = 0;
	}

	setActive(session: string, sources: (string | undefined)[]): void {
		if (session !== this.session) {
			this.reset();
			this.session = session;
		}
		this.active = new Set(sources.filter((source): source is string => !!source && isObsSkinSource(source)));
		for (const source of Array.from(this.active).slice(0, MAX_PENDING)) void this.get(source);
	}

	async get(source: string): Promise<string | undefined> {
		if (!isObsSkinSource(source) || !this.active.has(source)) return undefined;
		const cached = this.cache.get(source);
		if (cached) return cached;
		const pending = this.pending.get(source);
		if (pending) return pending;
		if (this.pending.size >= MAX_PENDING || Date.now() < (this.retryAt.get(source) ?? 0)) return undefined;
		const generation = this.generation;
		const request = this.load(source, generation);
		this.pending.set(source, request);
		try {
			return await request;
		} finally {
			if (this.pending.get(source) === request) this.pending.delete(source);
		}
	}

	private async load(source: string, generation: number): Promise<string | undefined> {
		try {
			const response = await fetch(source, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('OBS skin image unavailable');
			const image = new Uint8Array(await response.arrayBuffer());
			if (
				image.length < 24 || image.length > MAX_IMAGE_BYTES ||
				![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => image[index] === byte)
			) throw new Error('Invalid OBS skin PNG');
			const chunks: string[] = [];
			for (let offset = 0; offset < image.length; offset += 0x8000)
				chunks.push(String.fromCharCode(...image.subarray(offset, offset + 0x8000)));
			const dataUrl = `data:image/png;base64,${btoa(chunks.join(''))}`;
			if (generation !== this.generation || !this.active.has(source)) return undefined;
			while (this.bytes + dataUrl.length > MAX_CACHE_BYTES && this.cache.size) {
				const oldest = this.cache.keys().next().value!;
				this.bytes -= this.cache.get(oldest)!.length;
				this.cache.delete(oldest);
			}
			this.cache.set(source, dataUrl);
			this.bytes += dataUrl.length;
			return dataUrl;
		} catch {
			if (generation === this.generation) this.retryAt.set(source, Date.now() + RETRY_DELAY_MS);
			return undefined;
		}
	}
}
