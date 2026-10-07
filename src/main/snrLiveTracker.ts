import { hasSnrJumbo, isSnrJackal, SnrEnumValue, SnrLiveRole } from '../common/SnrRole';
import { isSnrLiveLayout, readSnrLiveRoles, SnrLiveLayout } from './snrLiveMemory';

function readTeam(value: unknown): SnrEnumValue | null | undefined {
	if (value === null) return null;
	if (!value || typeof value !== 'object') return undefined;
	const team = value as Partial<SnrEnumValue>;
	return Number.isSafeInteger(team.value) && (team.name === null || typeof team.name === 'string')
		? { value: team.value!, name: team.name! }
		: undefined;
}

export class SnrLiveTracker {
	private pid = -1;
	private layout: SnrLiveLayout | undefined;
	private attemptedSession = '';
	private request = 0;
	private pending = false;
	private needsJumboLayout = false;
	private needsRoleMetadata = false;
	private roleMetadataRetryAt = 0;
	private cosmeticRefreshAt = 0;
	private discoveryRetryAt = 0;
	private roleMetadata = new Map<
		number,
		{ roleId: number; isNeutral: boolean; canKill: boolean; hat2Id?: string; visor2Id?: string } & Pick<
			SnrLiveRole,
			'assignedTeam' | 'winnerTeam' | 'teamTag'
		>
	>();
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
		this.cosmeticRefreshAt = 0;
		this.discoveryRetryAt = 0;
		this.roleMetadata.clear();
		this.message = 'SNR役職未取得';
	}

	accept(pid: number, result: unknown): boolean {
		if ((this.pid !== -1 && pid !== this.pid) || !result || typeof result !== 'object') return false;
		const response = result as {
			status?: string;
			pid?: number;
			liveLayout?: unknown;
			players?: Array<{
				playerId?: number;
				role?: { value?: number };
				isNeutral?: boolean;
				canKill?: boolean;
				assignedTeam?: unknown;
				winnerTeam?: unknown;
				teamTag?: unknown;
				hat2Id?: string;
				visor2Id?: string;
			}>;
		};
		if (response.status !== 'ok' || response.pid !== pid || !isSnrLiveLayout(response.liveLayout, pid)) return false;
		this.pid = pid;
		this.layout = response.liveLayout;
		this.discoveryRetryAt = 0;
		this.needsRoleMetadata = !(response.players ?? []).some(
			(player) =>
				Number.isInteger(player.playerId) &&
				Number.isInteger(player.role?.value) &&
				typeof player.isNeutral === 'boolean' &&
				typeof player.canKill === 'boolean'
		);
		this.roleMetadataRetryAt = this.needsRoleMetadata ? Date.now() + 1000 : 0;
		this.cosmeticRefreshAt = Date.now() + 5000;
		const previousMetadata = this.roleMetadata;
		this.roleMetadata = new Map(
			(response.players ?? [])
				.filter((player) => Number.isInteger(player.playerId) && Number.isInteger(player.role?.value))
				.map((player) => [
					player.playerId!,
					{
						roleId: player.role!.value!,
						isNeutral: player.isNeutral === true,
						canKill: player.canKill === true,
						assignedTeam: readTeam(player.assignedTeam),
						winnerTeam: readTeam(player.winnerTeam),
						teamTag: readTeam(player.teamTag),
						hat2Id: player.hat2Id || previousMetadata.get(player.playerId!)?.hat2Id,
						visor2Id: player.visor2Id || previousMetadata.get(player.playerId!)?.visor2Id,
					},
				])
		);
		return true;
	}

	update(pid: number, session: string, read: (address: number, size: number) => Buffer): Map<number, SnrLiveRole> {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		const refreshCosmetics = !!this.layout && Date.now() >= this.cosmeticRefreshAt;
		const discoverySession = this.layout
			? `${session}:${
					this.needsRoleMetadata
						? 'metadata'
						: this.needsJumboLayout
							? 'jumbo'
							: `cosmetics-${Math.floor(Date.now() / 5000)}`
				}`
			: session;
		const retryReady =
			(!this.needsRoleMetadata || Date.now() >= this.roleMetadataRetryAt) && Date.now() >= this.discoveryRetryAt;
		if (
			(!this.layout || this.needsJumboLayout || this.needsRoleMetadata || refreshCosmetics) &&
			retryReady &&
			!this.pending &&
			(this.attemptedSession !== discoverySession || !this.layout)
		) {
			this.attemptedSession = discoverySession;
			this.pending = true;
			this.message = 'SNR役職の読み取り位置を確認中…';
			const request = ++this.request;
			void this.discover(pid)
				.then((result) => {
					if (request !== this.request) return;
					if (!this.accept(pid, result)) {
						this.discoveryRetryAt = Date.now() + 10000;
						this.message = 'SNR役職未取得（10秒後に自動再取得）。';
					}
				})
				.catch(() => {
					if (request === this.request) {
						this.discoveryRetryAt = Date.now() + 10000;
						this.message = 'SNR役職の読み取り位置を取得できませんでした（10秒後に自動再取得）。';
					}
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
					roles.set(playerId, {
						...role,
						isNeutral: true,
						canKill: true,
						assignedTeam: metadata?.roleId === role.role.value ? metadata.assignedTeam : undefined,
						winnerTeam: metadata?.roleId === role.role.value ? metadata.winnerTeam : undefined,
						teamTag: metadata?.roleId === role.role.value ? metadata.teamTag : undefined,
						hat2Id: metadata?.hat2Id,
						visor2Id: metadata?.visor2Id,
					});
					continue;
				}
				if (metadata?.roleId === role.role.value) {
					roles.set(playerId, {
						...role,
						isNeutral: metadata.isNeutral,
						canKill: metadata.canKill,
						assignedTeam: metadata.assignedTeam,
						winnerTeam: metadata.winnerTeam,
						teamTag: metadata.teamTag,
						hat2Id: metadata.hat2Id,
						visor2Id: metadata.visor2Id,
					});
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
			this.message = 'SNR役職未取得（自動更新待ち）。';
			return new Map();
		}
	}
}
