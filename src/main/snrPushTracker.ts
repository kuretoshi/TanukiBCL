import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Live fall animation samples; no duration estimate and no retained death permission. */
export class SnrPushTracker {
	private child?: ChildProcess;
	private pid = -1;
	private retryAt = 0;
	private receivedAt = 0;
	private ids: number[] = [];

	reset(): void {
		const child = this.child;
		this.child = undefined;
		this.pid = -1;
		this.ids = [];
		this.receivedAt = 0;
		this.retryAt = 0;
		child?.kill();
	}

	update(pid: number, is64Bit = false): readonly number[] {
		if (this.pid !== pid) {
			this.reset();
			this.pid = pid;
		}
		if (!this.child && Date.now() >= this.retryAt) this.start(pid, is64Bit);
		return Date.now() - this.receivedAt <= 500 ? this.ids : [];
	}

	private start(pid: number, is64Bit: boolean): void {
		this.retryAt = Date.now() + 10000;
		const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
		const executable = is64Bit
			? join(root, 'out', 'debug-reader', 'x64', 'SnrRoleReader.exe')
			: join(root, 'out', 'debug-reader', 'SnrRoleReader.exe');
		if (!existsSync(executable)) return;
		const child = spawn(executable, [String(pid), '--push-watch', String(process.pid)], {
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		this.child = child;
		let pending = '';
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			if (this.child !== child) return;
			pending += chunk;
			if (pending.length > 65536) {
				pending = '';
				this.ids = [];
				return;
			}
			let end: number;
			while ((end = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				this.ids = [];
				try {
					const sample = JSON.parse(line);
					if (
						sample.pid === pid &&
						sample.available === true &&
						Number.isSafeInteger(sample.capturedAt) &&
						Math.abs(Date.now() - sample.capturedAt) <= 500 &&
						Array.isArray(sample.playerIds) &&
						sample.playerIds.length <= 256 &&
						sample.playerIds.every((id: number) => Number.isInteger(id) && id >= 0 && id < 256)
					) {
						this.ids = sample.playerIds;
						this.receivedAt = Date.now();
					}
				} catch {
					/* Failed samples clear fall state. */
				}
			}
		});
		const stopped = () => {
			if (this.child !== child) return;
			this.child = undefined;
			this.ids = [];
			this.receivedAt = 0;
			this.retryAt = Date.now() + 10000;
		};
		child.on('error', stopped);
		child.on('exit', stopped);
	}
}
