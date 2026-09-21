import { hasSnrJumbo, SnrLiveRole } from '../common/SnrRole';
import { isSnrLiveLayout, readSnrLiveRoles, SnrLiveLayout } from './snrLiveMemory';

export class SnrLiveTracker {
	private pid = -1;
	private layout: SnrLiveLayout | undefined;
	private attemptedSession = '';
	private request = 0;
	private pending = false;
	private needsJumboLayout = false;
	private roleMetadata = new Map<number, { isNeutral: boolean; canKill: boolean }>();
	message = 'SNR役職未取得';

	constructor(private discover: (pid: number) => Promise<unknown>) {}

	reset(): void {
		this.request++;
		this.pid = -1;
		this.layout = undefined;
		this.attemptedSession = '';
		this.pending = false;
		this.needsJumboLayout = false;
		this.roleMetadata.clear();
		this.message = 'SNR役職未取得';
	}

	accept(pid: number, result: unknown): boolean {
		if ((this.pid !== -1 && pid !== this.pid) || !result || typeof result !== 'object') return false;
		const response = result as {
			status?: string;
			pid?: number;
			liveLayout?: unknown;
			players?: Array<{ playerId?: number; isNeutral?: boolean; canKill?: boolean }>;
		};
		if (response.status !== 'ok' || response.pid !== pid || !isSnrLiveLayout(response.liveLayout, pid)) return false;
		this.pid = pid;
		this.layout = response.liveLayout;
		this.roleMetadata = new Map(
			(response.players ?? [])
				.filter((player) => Number.isInteger(player.playerId))
				.map((player) => [player.playerId!, { isNeutral: player.isNeutral === true, canKill: player.canKill === true }])
		);
		return true;
	}

	update(pid: number, session: string, read: (address: number, size: number) => Buffer): Map<number, SnrLiveRole> {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		const discoverySession = this.layout ? `${session}:jumbo` : session;
		if ((!this.layout || this.needsJumboLayout) && !this.pending && this.attemptedSession !== discoverySession) {
			this.attemptedSession = discoverySession;
			this.pending = true;
			this.message = 'SNR役職の読み取り位置を確認中…';
			const request = ++this.request;
			void this.discover(pid)
				.then((result) => {
					if (request !== this.request) return;
					if (!this.accept(pid, result)) this.message = 'SNR役職未取得。「SNR役職を取得」で再確認してください。';
				})
				.catch(() => {
					if (request === this.request) this.message = 'SNR役職の読み取り位置を取得できませんでした。';
				})
				.finally(() => {
					if (request === this.request) this.pending = false;
				});
		}
		if (!this.layout) return new Map();
		try {
			const roles = readSnrLiveRoles(this.layout, read);
			for (const [playerId, role] of roles) {
				const metadata = this.roleMetadata.get(playerId);
				if (metadata) roles.set(playerId, { ...role, ...metadata });
			}
			this.needsJumboLayout = !this.layout.jumbo && [...roles.values()].some(hasSnrJumbo);
			this.message = 'SNR役職を自動更新中';
			return roles;
		} catch {
			// Keep only the layout, never old role values; moving objects are resolved next tick.
			this.message = 'SNR役職未取得（更新待ち）。続く場合は「SNR役職を取得」で再確認してください。';
			return new Map();
		}
	}
}
