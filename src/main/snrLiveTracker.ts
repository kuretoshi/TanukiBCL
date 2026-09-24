import { hasSnrJumbo, isSnrJackal, SnrLiveRole } from '../common/SnrRole';
import { isSnrLiveLayout, readSnrLiveRoles, SnrLiveLayout } from './snrLiveMemory';

export class SnrLiveTracker {
	private pid = -1;
	private layout: SnrLiveLayout | undefined;
	private attemptedSession = '';
	private request = 0;
	private pending = false;
	private needsJumboLayout = false;
	private needsRoleMetadata = false;
	private roleMetadataRetryAt = 0;
	private roleMetadata = new Map<number, { roleId: number; isNeutral: boolean; canKill: boolean }>();
	message = 'SNR役職未取得';

	constructor(private discover: (pid: number) => Promise<unknown>) {}

	reset(): void {
		this.request++;
		this.pid = -1;
		this.layout = undefined;
		this.attemptedSession = '';
		this.pending = false;
		this.needsJumboLayout = false;
		this.needsRoleMetadata = false;
		this.roleMetadataRetryAt = 0;
		this.roleMetadata.clear();
		this.message = 'SNR役職未取得';
	}

	accept(pid: number, result: unknown): boolean {
		if ((this.pid !== -1 && pid !== this.pid) || !result || typeof result !== 'object') return false;
		const response = result as {
			status?: string;
			pid?: number;
			liveLayout?: unknown;
			players?: Array<{ playerId?: number; role?: { value?: number }; isNeutral?: boolean; canKill?: boolean }>;
		};
		if (response.status !== 'ok' || response.pid !== pid || !isSnrLiveLayout(response.liveLayout, pid)) return false;
		this.pid = pid;
		this.layout = response.liveLayout;
		this.needsRoleMetadata = !(response.players ?? []).some(
			(player) =>
				Number.isInteger(player.playerId) &&
				Number.isInteger(player.role?.value) &&
				typeof player.isNeutral === 'boolean' &&
				typeof player.canKill === 'boolean'
		);
		this.roleMetadataRetryAt = this.needsRoleMetadata ? Date.now() + 1000 : 0;
		this.roleMetadata = new Map(
			(response.players ?? [])
				.filter((player) => Number.isInteger(player.playerId) && Number.isInteger(player.role?.value))
				.map((player) => [
					player.playerId!,
					{ roleId: player.role!.value!, isNeutral: player.isNeutral === true, canKill: player.canKill === true },
				])
		);
		return true;
	}

	update(pid: number, session: string, read: (address: number, size: number) => Buffer): Map<number, SnrLiveRole> {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		const discoverySession = this.layout
			? `${session}:${this.needsRoleMetadata ? 'metadata' : 'jumbo'}`
			: session;
		const retryReady = !this.needsRoleMetadata || Date.now() >= this.roleMetadataRetryAt;
		if (
			(!this.layout || this.needsJumboLayout || this.needsRoleMetadata) &&
			retryReady &&
			!this.pending &&
			this.attemptedSession !== discoverySession
		) {
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
				if (metadata && metadata.roleId !== role.role.value) this.roleMetadata.delete(playerId);
				if (isSnrJackal(role)) {
					// Both role definitions assign Neutral and attach JackalAbility with canKill:true.
					roles.set(playerId, { ...role, isNeutral: true, canKill: true });
				} else if (metadata?.roleId === role.role.value) {
					roles.set(playerId, { ...role, isNeutral: metadata.isNeutral, canKill: metadata.canKill });
				}
			}
			this.needsRoleMetadata = [...roles].some(
				([playerId, role]) => !isSnrJackal(role) && !this.roleMetadata.has(playerId)
			);
			if (this.needsRoleMetadata) this.roleMetadataRetryAt = Math.max(this.roleMetadataRetryAt, Date.now() + 1000);
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
