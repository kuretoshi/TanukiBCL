import { isNosPlayerRoles, type NosRole } from '../common/NosRole';
import { GameState, type Player } from '../common/AmongUsState';
import { isNosBodyLayout, readNosBodyType, type NosBodyLayout } from './nosBodyMemory';

/** Managed role snapshots plus live native state; no reuse across rounds or processes. */
export class NosRoleTracker {
	private session = '';
	private request = 0;
	private pending = false;
	private nextRead = 0;
	private receivedAt = 0;
	private roles = new Map<number, NosRole>();
	private bodies = new Map<number, NosBodyLayout>();
	private cancelledBuskers = new Set<number>();
	message = 'NoS役職未取得';

	constructor(private read: (pid: number) => Promise<unknown>) {}

	reset(): void {
		this.session = '';
		this.request++;
		this.nextRead = 0;
		this.receivedAt = 0;
		this.roles.clear();
		this.bodies.clear();
		this.cancelledBuskers.clear();
		this.message = 'NoS役職未取得';
	}

	update(
		pid: number,
		round: string,
		readBody?: (address: number, size: number) => Buffer,
		gameState: GameState = GameState.UNKNOWN,
		players: readonly Player[] = []
	): ReadonlyMap<number, NosRole> {
		const session = `${pid}:${round}`;
		if (session !== this.session) {
			this.reset();
			this.session = session;
		}
		if (!this.pending && Date.now() >= this.nextRead) {
			this.pending = true;
			const request = ++this.request;
			void this.read(pid)
				.then((rows) => {
					if (request !== this.request) return;
					if (!isNosPlayerRoles(rows)) throw new Error('未対応のNoS役職データです。');
					this.roles = new Map(rows.map(({ playerId, role }) => [playerId, role]));
					this.bodies.clear();
					for (const row of rows) {
						const body = (row as typeof row & { bodyLayout?: unknown }).bodyLayout;
						if (row.role.roleName === 'berserker' && isNosBodyLayout(body)) this.bodies.set(row.playerId, body);
					}
					this.receivedAt = Date.now();
					this.message = rows.length ? 'NoS役職を自動更新中（約2秒間隔）' : 'NoSの役職割り当てを待っています';
				})
				.catch((error: unknown) => {
					if (request !== this.request) return;
					this.roles.clear();
					this.bodies.clear();
					this.message = `NoS役職未取得: ${error instanceof Error ? error.message : String(error)}`;
				})
				.finally(() => {
					this.pending = false;
					if (request !== this.request) return;
					this.nextRead = Date.now() + 2000;
				});
		}
		if (Date.now() - this.receivedAt > 5000) {
			this.roles.clear();
			this.bodies.clear();
		}
		const result = new Map<number, NosRole>();
		for (const [id, role] of this.roles) {
			const player = players.find((candidate) => candidate.id === id);
			if (player && !player.isDead) this.cancelledBuskers.delete(id);
			if (gameState === GameState.DISCUSSION && role.roleName === 'busker' && (role.buskerReviveRemaining ?? 0) > 0)
				this.cancelledBuskers.add(id);
			let bodyType: number | undefined;
			try {
				const body = this.bodies.get(id);
				if (body && readBody) bodyType = readNosBodyType(body, id, readBody);
			} catch {
				// Do not retain the last active flag after an unreadable native state.
			}
			result.set(id, {
				...role,
				buskerReviveRemaining:
					!this.cancelledBuskers.has(id) &&
					role.buskerReviveRemaining != null &&
					role.buskerReviveRemaining - (Date.now() - this.receivedAt) / 1000 > 0
						? role.buskerReviveRemaining - (Date.now() - this.receivedAt) / 1000
						: undefined,
				bodyType,
				isBerserking: role.roleName === 'berserker' && bodyType !== undefined ? bodyType === 2 : undefined,
			});
		}
		return result;
	}
}
