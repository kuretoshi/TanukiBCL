import { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addonLinkPort, validAddonProfile, type AddonProfile } from '../common/AddonLink';

// One bounded loopback stream per selected Among Us process. No microphone audio
// is carried here: this is role state, level samples and recognition results only.
export class NosAddonLink {
	private pid = 0;
	private scope = '';
	private port = 0;
	private socket?: Socket;
	private buffer = Buffer.alloc(0);
	private nonce = '';
	private session = '';
	private sequence = 0;
	private profile?: AddonProfile;
	private nextAttempt = 0;
	private nextPoll = 0;
	private nextDiscovery = 0;
	private phase?: AddonProfile['phase'];
	private localPlayer?: number;
	update(
		pid: number,
		scope: string,
		marker?: number,
		phase?: AddonProfile['phase'],
		localPlayer?: number
	): AddonProfile | undefined {
		if (pid !== this.pid || scope !== this.scope) {
			this.close();
			this.pid = pid;
			this.scope = scope;
		}
		this.phase = phase;
		this.localPlayer = localPlayer;
		if (!pid) return;
		const now = Date.now();
		const memoryPort = addonLinkPort(marker);
		const port = memoryPort ?? this.discover(now);
		if (port && port !== this.port) {
			this.disconnect();
			this.port = port;
			this.nextAttempt = 0;
		}
		if (this.port && !this.socket && now >= this.nextAttempt) this.connect();
		if (this.session && now >= this.nextPoll) {
			this.nextPoll = now + 100;
			this.send('poll', { accepted: this.current(pid)?.sequence ?? 0 });
		}
		if (this.profile && now - this.profile.unixMs > 1500) this.disconnect();
		return this.current(pid);
	}
	current(pid: number): AddonProfile | undefined {
		const p = this.profile;
		return p &&
			this.pid === pid &&
			Date.now() - p.unixMs <= 700 &&
			(!this.phase || p.phase === this.phase) &&
			(this.localPlayer === undefined || p.localPlayer === this.localPlayer)
			? p
			: undefined;
	}
	endpoint(): number {
		return this.port;
	}
	sendCommand(pid: number, kind: 'sample' | 'ready' | 'word' | 'parrot', fields: Record<string, unknown>): boolean {
		return !!this.current(pid) && this.send(kind, fields);
	}
	private discover(now: number): number | undefined {
		if (now < this.nextDiscovery) return this.port || undefined;
		this.nextDiscovery = now + 500;
		try {
			if (!process.env.LOCALAPPDATA) return;
			const path = join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', `addon-link-${this.pid}.json`);
			if (statSync(path).size > 4096) return;
			const d = JSON.parse(readFileSync(path, 'utf8'));
			if (
				d.protocol === 1 &&
				d.pid === this.pid &&
				Number.isInteger(d.port) &&
				d.port > 0 &&
				d.port <= 65535 &&
				Number.isSafeInteger(d.unixMs) &&
				now - d.unixMs <= 2500 &&
				d.unixMs <= now + 100
			)
				return d.port;
		} catch {
			/* Old addon, lobby transition or descriptor replacement. */
		}
	}
	private connect(): void {
		this.nextAttempt = Date.now() + 500;
		const socket = new Socket();
		this.socket = socket;
		this.nonce = randomBytes(16).toString('hex');
		socket.setNoDelay();
		socket.unref();
		socket.setTimeout(2000);
		socket.on('connect', () =>
			socket.write(JSON.stringify({ kind: 'hello', protocol: 1, pid: this.pid, nonce: this.nonce }) + '\n')
		);
		socket.on('data', (bytes) => this.receive(bytes));
		socket.on('timeout', () => socket.destroy());
		socket.on('error', () => socket.destroy());
		socket.on('close', () => {
			if (this.socket === socket) this.disconnect();
		});
		socket.connect(this.port, '127.0.0.1');
	}
	private receive(bytes: Buffer): void {
		try {
			this.buffer = Buffer.concat([this.buffer, bytes]);
			let frames = 0,
				end: number;
			while ((end = this.buffer.indexOf(10)) >= 0) {
				if (++frames > 64 || end >= 131072) throw new Error('Oversized addon link frame');
				const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, end));
				this.buffer = this.buffer.subarray(end + 1);
				this.accept(JSON.parse(text));
			}
			if (this.buffer.length >= 131072) throw new Error('Oversized addon link buffer');
		} catch {
			this.disconnect();
		}
	}
	private accept(value: unknown): void {
		if (!this.session) {
			const h = value as { kind?: string; protocol?: number; pid?: number; nonce?: string; session?: string };
			if (
				h?.kind !== 'hello' ||
				h.protocol !== 1 ||
				h.pid !== this.pid ||
				h.nonce !== this.nonce ||
				!/^[a-f0-9]{32}$/.test(h.session ?? '')
			)
				throw new Error('Invalid addon link hello');
			this.session = h.session!;
			this.nextPoll = 0;
			return;
		}
		if (!validAddonProfile(value, this.pid, this.session, this.profile?.sequence ?? 0, Date.now())) return;
		if (
			(this.phase && value.phase !== this.phase) ||
			(this.localPlayer !== undefined && value.localPlayer !== this.localPlayer)
		)
			return;
		this.profile = value;
	}
	private send(kind: string, fields: Record<string, unknown>): boolean {
		if (!this.session || !this.socket || this.socket.destroyed || this.socket.writableLength > 131072) return false;
		this.socket.write(
			JSON.stringify({
				...fields,
				kind,
				protocol: 1,
				pid: this.pid,
				session: this.session,
				sequence: ++this.sequence,
				unixMs: Date.now(),
			}) + '\n'
		);
		return true;
	}
	private disconnect(): void {
		const socket = this.socket;
		this.socket = undefined;
		socket?.destroy();
		this.session = '';
		this.sequence = 0;
		this.profile = undefined;
		this.buffer = Buffer.alloc(0);
	}
	close(): void {
		this.disconnect();
		this.pid = 0;
		this.scope = '';
		this.port = 0;
		this.nextDiscovery = 0;
	}
}
export const nosAddonLink = new NosAddonLink();
