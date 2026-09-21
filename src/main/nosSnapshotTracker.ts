import { NosSnapshot } from '../common/NosSnapshot';
import { isNosLayout, NosLayout, readNosSnapshot } from './nosSnapshotMemory';

export class NosSnapshotTracker {
	private pid = -1;
	private layout?: NosLayout;
	private request = 0;
	private pending = false;
	private attemptedSession = '';
	private retryAt = 0;
	private observedSession = '';
	private publication = 0;
	private publishedAt = 0;
	private fresh = false;
	message = 'NoSスナップショット未取得';

	constructor(private resolve: (pid: number) => Promise<unknown>) {}

	reset(): void {
		this.request++;
		this.pid = -1;
		this.layout = undefined;
		this.pending = false;
		this.attemptedSession = '';
		this.retryAt = 0;
		this.observedSession = '';
		this.publication = 0;
		this.publishedAt = 0;
		this.fresh = false;
		this.message = 'NoSスナップショット未取得';
	}

	update(pid: number, session: string, read: (address: number, size: number) => Buffer): NosSnapshot | undefined {
		if (pid !== this.pid) {
			this.reset();
			this.pid = pid;
		}
		if (!this.layout && !this.pending && (this.attemptedSession !== session || Date.now() >= this.retryAt)) {
			this.attemptedSession = session;
			this.pending = true;
			const request = ++this.request;
			this.message = 'NoSスナップショットの公開を有効化中…';
			void this.resolve(pid)
				.then((layout) => {
					if (request !== this.request) return;
					if (!isNosLayout(layout, pid)) throw new Error('未対応のNoSスナップショット定義です。');
					this.layout = layout;
				})
				.catch((error) => {
					if (request === this.request) {
						// Game entry may precede initialization of the MOD's static storage.
						this.retryAt = Date.now() + 30000;
						this.message = `NoS未取得: ${error instanceof Error ? error.message : String(error)}`;
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
				this.message = 'NoSの新しいスナップショットを待機中';
				return undefined;
			}
			this.message = 'NoSスナップショットを自動更新中';
			return snapshot;
		} catch {
			this.message = 'NoSスナップショット待機中';
			return undefined;
		}
	}
}
