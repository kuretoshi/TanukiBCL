import { NosSnapshot } from '../common/NosSnapshot';
import { isNosLayout, NosLayout, readNosSnapshot } from './nosSnapshotMemory';

/** Distinguish helper exits from errors returned by the MOD reader. */
export class NosReaderUnexpectedExitError extends Error {}

function readFailureReason(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const reasons: Record<string, string> = {
		'NoS snapshot not published': 'NoSからデータが公開されていません',
		'Invalid NoS players': 'プレイヤー一覧の件数またはメモリ位置が不正です',
		'Invalid NoS radios': '無線情報の件数またはメモリ位置が不正です',
		'Invalid NoS float': '位置・色・サイズ・首の長さの数値が不正です',
		'Invalid NoS body state': 'BodyTypeまたはNeckLengthが不正です',
		'Invalid NoS flag': '役職などの判定値が不正です',
		'Invalid NoS player identity': 'プレイヤーIDが重複しているか、名前の長さが不正です',
		'Invalid NoS costume name': 'コスチューム名の長さが不正です',
		'Invalid NoS radio name': '無線名の長さが不正です',
		'NoS snapshot changed during read': '読み取り中にNoSのデータが更新されました',
	};
	return reasons[raw] ? `${reasons[raw]}（${raw}）` : raw;
}

export class NosSnapshotTracker {
	private pid = -1;
	private layout?: NosLayout;
	private request = 0;
	private pending = false;
	private retryAt = 0;
	private failureSince?: number;
	private retryDelay = 5000;
	private observedSession = '';
	private publication = 0;
	private publishedAt = 0;
	private fresh = false;
	private lastFailure?: string;
	get schemaVersion(): number | undefined {
		return this.layout?.schemaVersion;
	}
	message = 'NoSスナップショット未取得';

	constructor(private resolve: (pid: number) => Promise<unknown>) {}

	reset(): void {
		this.request++;
		this.pid = -1;
		this.layout = undefined;
		this.pending = false;
		this.retryAt = 0;
		this.failureSince = undefined;
		this.retryDelay = 5000;
		this.observedSession = '';
		this.publication = 0;
		this.publishedAt = 0;
		this.fresh = false;
		this.lastFailure = undefined;
		this.message = 'NoSスナップショット未取得';
	}

	private failedRead(reason: string): void {
		this.lastFailure = reason;
		this.failureSince ??= Date.now();
		this.message = `${reason}（自動再取得中）`;
		if (Date.now() - this.failureSince < 5000) return;
		this.layout = undefined;
		this.failureSince = undefined;
		this.observedSession = '';
		this.publication = 0;
		this.publishedAt = 0;
		this.fresh = false;
		this.retryAt = Date.now();
		this.message = `${reason}（読み取り位置を再取得します）`;
	}

	update(pid: number, session: string, read: (address: number, size: number) => Buffer): NosSnapshot | undefined {
		if (pid !== this.pid) {
			this.reset();
			this.pid = pid;
		}
		if (!this.layout && !this.pending && Date.now() >= this.retryAt) {
			this.pending = true;
			const request = ++this.request;
			this.message = this.lastFailure
				? `${this.lastFailure}（読み取り位置を自動再取得中）`
				: 'NoSスナップショットの公開を有効化中…';
			void this.resolve(pid)
				.then((layout) => {
					if (request !== this.request) return;
					if (!isNosLayout(layout, pid)) throw new Error('未対応のNoSスナップショット定義です。');
					this.layout = layout;
				})
				.catch((error) => {
					if (request === this.request) {
						const reason = error instanceof Error ? error.message : String(error);
						this.lastFailure = `NoS未取得: ${reason}`;
						this.message = `NoS未取得: ${reason}（${this.retryDelay / 1000}秒後に自動再取得）`;
						this.retryAt = Date.now() + this.retryDelay;
						this.retryDelay = Math.min(this.retryDelay * 2, 30000);
					}
				})
				.finally(() => {
					if (request === this.request) this.pending = false;
				});
		}
		if (!this.layout) return undefined;
		try {
			const snapshot = readNosSnapshot(this.layout, read);
			if (this.observedSession !== session) {
				this.observedSession = session;
				this.publication = snapshot.publication;
				this.fresh = false;
			}
			if (snapshot.publication !== this.publication) {
				this.publication = snapshot.publication;
				this.publishedAt = Date.now();
				this.fresh = true;
			}
			if (!this.fresh || Date.now() - this.publishedAt > 3000) {
				this.failedRead(
					this.fresh ? 'NoSデータの更新が3秒以上停止しています' : 'NoSの新しいデータがまだ公開されていません'
				);
				return undefined;
			}
			this.failureSince = undefined;
			this.retryDelay = 5000;
			this.lastFailure = undefined;
			this.message = 'NoSスナップショットを自動更新中';
			return snapshot;
		} catch (error) {
			this.failedRead(`NoS読み取り失敗: ${readFailureReason(error)}`);
			return undefined;
		}
	}
}
