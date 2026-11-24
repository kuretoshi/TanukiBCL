import { AmongUsState, Player } from '../../common/AmongUsState';
import { cosmeticType, getCosmetic, isSnrScaledVisor } from '../lib/cosmetics';
import { isLiteRuntime } from '../../common/appVariant';

type Parts = NonNullable<Player['nosCosmetics']>;
type Asset = { id: string; png: string; scale?: boolean };
type MobileFrame = { gameState: AmongUsState; nosCosmeticAssets?: Record<string, string>; nosVoiceFrameTime?: number };
const MAX_IMAGE_BYTES = 192 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** Processed local PNGs are relayed separately from the frequent game-state frames. */
export class MobileCosmetics {
	private session = '';
	private generation = 0;
	private cache = new Map<string, Asset>();
	private pending = new Set<string>();
	private retryAt = new Map<string, number>();
	private sent = new Set<string>();
	private bytes = 0;
	private lastSentAt = 0;

	reset(): void {
		this.generation++;
		this.session = '';
		this.cache.clear();
		this.pending.clear();
		this.retryAt.clear();
		this.sent.clear();
		this.bytes = 0;
		this.lastSentAt = 0;
	}

	resend(ids?: string[]): void {
		if (ids) for (const id of ids) this.sent.delete(id);
		else this.sent.clear();
	}

	frame(state: AmongUsState): MobileFrame {
		const session = `${state.lobbyCode}:${state.mod}`;
		if (this.session !== session) {
			this.reset();
			this.session = session;
		}
		const active = new Set<string>();
		const players = state.players.map((player) => this.webPlayer(player, state.mod, active));
		return {
			gameState: { ...state, players, nosLoadedContents: undefined },
			nosVoiceFrameTime: state.mod === 'NoS' ? Date.now() : undefined,
			nosCosmeticAssets: this.nextAssets(active),
		};
	}

	private webPlayer(player: Player, mod: AmongUsState['mod'], active: Set<string>): Player {
		if (mod === 'SUPER_NEW_ROLES' && !isLiteRuntime()) return this.snrPlayer(player, active);
		const entries = mod === 'NoS' ? Object.entries(player.nosCosmetics ?? {}) : [];
		const parts: Parts = Object.fromEntries(
			entries
				.filter(([, source]) => source.startsWith('nos-cosmetic://image/'))
				.map(([part, source]) => {
					active.add(source);
					this.load(source);
					return [part, `nos-web://${this.cache.get(source)?.id ?? 'pending'}`];
				})
		);
		return {
			...player,
			nosCosmetics: Object.keys(parts).length ? parts : undefined,
			snrCosmetics: undefined,
			snrCosmeticScale: undefined,
		};
	}

	private snrPlayer(player: Player, active: Set<string>): Player {
		const outfit = player.currentOutfit > 0 && player.currentOutfit <= 10;
		const id = (part: 'hat' | 'skin' | 'visor') => {
			const appearance = player[`appearance${part === 'hat' ? 'Hat' : part === 'skin' ? 'Skin' : 'Visor'}Id`];
			return outfit || appearance?.startsWith('Modded_') ? appearance : player[`${part}Id`];
		};
		const color = outfit && player.appearanceColorId >= 0 ? player.appearanceColorId : player.colorId;
		const ids = {
			hat: id('hat'),
			skin: id('skin'),
			visor: id('visor'),
			hat2: player.snrHat2Id,
			visor2: player.snrVisor2Id,
		};
		const sources = {
			hat: [ids.hat, cosmeticType.hat],
			hatBack: [ids.hat, cosmeticType.hat_back],
			skin: [ids.skin, cosmeticType.skin],
			visor: [ids.visor, cosmeticType.visor],
			hat2: [ids.hat2, cosmeticType.hat],
			hat2Back: [ids.hat2, cosmeticType.hat_back],
			visor2: [ids.visor2, cosmeticType.visor],
		} as const;
		const parts: NonNullable<Player['snrCosmetics']> = {};
		const scale: NonNullable<Player['snrCosmeticScale']> = {};
		for (const [part, [id, type]] of Object.entries(sources)) {
			if (!id?.startsWith('Modded_')) continue;
			const source = getCosmetic(color, true, type, id, 'SUPER_NEW_ROLES');
			active.add(source);
			this.load(source);
			parts[part as keyof typeof parts] = `nos-web://${this.cache.get(source)?.id ?? 'pending'}`;
			if (part === 'visor' || part === 'visor2') scale[part] = this.cache.get(source)?.scale ?? isSnrScaledVisor(id);
		}
		return { ...player, nosCosmetics: undefined, snrCosmetics: parts, snrCosmeticScale: scale };
	}

	private nextAssets(active: Set<string>): Record<string, string> | undefined {
		// At most one small PNG every 100ms, keeping the server's frame size bounded.
		if (Date.now() - this.lastSentAt >= 100) {
			for (const source of active) {
				const asset = this.cache.get(source);
				if (!asset || this.sent.has(asset.id)) continue;
				this.sent.add(asset.id);
				this.lastSentAt = Date.now();
				return { [asset.id]: asset.png };
			}
		}
		return undefined;
	}

	private load(source: string): void {
		if (this.cache.has(source) || this.pending.has(source) || Date.now() < (this.retryAt.get(source) ?? 0)) return;
		if (this.pending.size >= 3) return;
		const generation = this.generation;
		this.pending.add(source);
		void this.loadAsset(source, generation);
	}

	private async loadAsset(source: string, generation: number): Promise<void> {
		try {
			const response = await fetch(source, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('NoS image unavailable');
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80)
				throw new Error('Invalid NoS PNG');
			const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
			const id = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
			const png = this.pngDataUrl(bytes);
			if (generation !== this.generation) return;
			const scale = response.headers.get('X-Tanuki-Snr-Scale');
			this.storeAsset(source, { id, png, scale: scale === null ? undefined : scale === '1' });
		} catch {
			if (generation === this.generation) this.retryAt.set(source, Date.now() + 5000);
		} finally {
			if (generation === this.generation) this.pending.delete(source);
		}
	}

	private pngDataUrl(bytes: Uint8Array): string {
		const chunks: string[] = [];
		// Bounded chunks avoid both per-byte string concatenation and argument limits.
		for (let offset = 0; offset < bytes.length; offset += 0x8000) {
			chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
		}
		return `data:image/png;base64,${btoa(chunks.join(''))}`;
	}

	private storeAsset(source: string, asset: Asset): void {
		while (this.bytes + asset.png.length > MAX_CACHE_BYTES && this.cache.size) {
			const oldest = this.cache.keys().next().value!;
			const old = this.cache.get(oldest)!;
			this.bytes -= old.png.length;
			this.cache.delete(oldest);
			this.sent.delete(old.id);
		}
		this.cache.set(source, asset);
		this.bytes += asset.png.length;
	}
}
