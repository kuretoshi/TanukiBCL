import { AmongUsState, Player } from '../../common/AmongUsState';

type Parts = NonNullable<Player['nosCosmetics']>;
const MAX_IMAGE_BYTES = 192 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/** Processed local PNGs are relayed separately from the frequent game-state frames. */
export class MobileCosmetics {
	private session = '';
	private generation = 0;
	private cache = new Map<string, { id: string; png: string }>();
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

	frame(state: AmongUsState): { gameState: AmongUsState; nosCosmeticAssets?: Record<string, string> } {
		const session = `${state.lobbyCode}:${state.mod}`;
		if (this.session !== session) {
			this.reset();
			this.session = session;
		}
		const active = new Set<string>();
		const players = state.players.map((player) => {
			const parts: Parts = {};
			if (state.mod === 'NoS') {
				for (const [part, source] of Object.entries(player.nosCosmetics ?? {})) {
					if (!source.startsWith('nos-cosmetic://image/')) continue;
					active.add(source);
					this.load(source);
					parts[part as keyof Parts] = `nos-web://${this.cache.get(source)?.id ?? 'pending'}`;
				}
			}
			return { ...player, nosCosmetics: Object.keys(parts).length ? parts : undefined };
		});
		const frame: { gameState: AmongUsState; nosCosmeticAssets?: Record<string, string> } = {
			gameState: { ...state, players, nosLoadedContents: undefined },
		};
		// At most one small PNG every 100ms, keeping the server's frame size bounded.
		if (Date.now() - this.lastSentAt >= 100) {
			for (const source of active) {
				const asset = this.cache.get(source);
				if (!asset || this.sent.has(asset.id)) continue;
				frame.nosCosmeticAssets = { [asset.id]: asset.png };
				this.sent.add(asset.id);
				this.lastSentAt = Date.now();
				break;
			}
		}
		return frame;
	}

	private load(source: string): void {
		if (this.cache.has(source) || this.pending.has(source) || Date.now() < (this.retryAt.get(source) ?? 0)) return;
		if (this.pending.size >= 3) return;
		const generation = this.generation;
		this.pending.add(source);
		void (async () => {
			try {
				const response = await fetch(source, { signal: AbortSignal.timeout(5000) });
				if (!response.ok) throw new Error('NoS image unavailable');
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80)
					throw new Error('Invalid NoS PNG');
				const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
				const id = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
				let binary = '';
				for (const byte of bytes) binary += String.fromCharCode(byte);
				const png = `data:image/png;base64,${btoa(binary)}`;
				if (generation !== this.generation) return;
				while (this.bytes + png.length > MAX_CACHE_BYTES && this.cache.size) {
					const oldest = this.cache.keys().next().value!;
					const old = this.cache.get(oldest)!;
					this.bytes -= old.png.length;
					this.cache.delete(oldest);
					this.sent.delete(old.id);
				}
				this.cache.set(source, { id, png });
				this.bytes += png.length;
			} catch {
				if (generation === this.generation) this.retryAt.set(source, Date.now() + 5000);
			} finally {
				if (generation === this.generation) this.pending.delete(source);
			}
		})();
	}
}
