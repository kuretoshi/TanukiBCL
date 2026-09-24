import { TohRole } from '../common/TohRole';
import { isTohLayout, readTohRoles, TohLayout } from './tohLiveMemory';

export class TohLiveTracker {
	private pid = -1;
	private layout?: TohLayout;
	private request = 0;
	private pending = false;
	private retryAt = 0;
	private session = '';
	private needsCanKill = false;
	private needsKiller = false;
	message = 'TOH4E役職未取得';
	constructor(private discover: (pid: number) => Promise<unknown>) {}
	reset(): void {
		this.request++;
		this.pid = -1;
		this.layout = undefined;
		this.pending = false;
		this.retryAt = 0;
		this.session = '';
		this.needsCanKill = false;
		this.needsKiller = false;
		this.message = 'TOH4E役職未取得';
	}
	update(pid: number, session: string, read: (address: number, size: number) => Buffer): Map<number, TohRole> {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		if (this.session !== session) {
			this.session = session;
			this.retryAt = 0;
		}
		if ((!this.layout || this.needsCanKill || this.needsKiller) && !this.pending && Date.now() >= this.retryAt) {
			this.pending = true;
			const request = ++this.request;
			this.message = 'TOH4Eの役職読み取り位置を確認中…';
			void this.discover(pid)
				.then((value) => {
					if (request !== this.request) return;
					const result = value as { status?: string; layout?: unknown; message?: string };
					if (result?.status !== 'ok' || !isTohLayout(result.layout, pid))
						throw new Error(result?.message || '未対応の読み取り定義');
					this.layout = result.layout;
					this.retryAt = Date.now() + 3000;
				})
				.catch((error) => {
					if (request !== this.request) return;
					this.message = `TOH4E未取得: ${error instanceof Error ? error.message : String(error)}`;
					this.retryAt = Date.now() + 30000;
				})
				.finally(() => {
					if (request === this.request) this.pending = false;
				});
		}
		if (!this.layout) return new Map();
		try {
			const roles = readTohRoles(this.layout, read);
			this.needsCanKill =
				!this.layout.opportunistCanKillSlot && [...roles.values()].some((role) => role.roleName === 'Opportunist');
			this.needsKiller = !this.layout.killerLayout || [...roles.values()].some((role) => role.isKiller === null);
			this.message = `TOH4E役職を自動更新中（${roles.size}人）／取得元: ローカルMODのPlayerState`;
			return roles;
		} catch {
			this.needsKiller = true;
			this.message = 'TOH4E役職未取得（配列・役職の更新待ち）';
			return new Map();
		}
	}
}
