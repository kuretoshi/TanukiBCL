import ioV2 from 'socket.io-client';
import { io as ioV4 } from 'socket.io-client-v4';

type SocketVersion = '2.4.0' | '4';
export type CompatibleSocketVersion = SocketVersion;
type SocketHandler = (...args: any[]) => void;
type AnySocket = {
	connected?: boolean;
	id?: string;
	on(event: string, handler: SocketHandler): AnySocket;
	emit(event: string, ...args: any[]): AnySocket;
	close(): AnySocket;
	disconnect?(): AnySocket;
};

const COMPATIBLE_SOCKET_OPTIONS: SocketIOClient.ConnectOpts = {
	transports: ['websocket'],
};
const SOCKET_CONNECT_TIMEOUT_MS = 8000;
const V4_FALLBACK_DELAY_MS = 3500;
const MAX_PENDING_EMITS = 50;
const COALESCED_PENDING_EVENTS = new Set(['VAD', 'id', 'join', 'lobby', 'setHost']);
const INTERNAL_EVENTS = new Set(['connect', 'disconnect', 'connect_error', 'connect_timeout', 'error']);

class CompatibleSocket {
	private socket?: AnySocket;
	private listeners = new Map<string, Set<SocketHandler>>();
	private bridgedEvents = new Set<string>();
	private pendingEmits: Array<{ event: string; args: any[] }> = [];
	private v2FallbackStarted = false;
	private closed = false;
	private fallbackTimer?: number;

	constructor(private readonly serverUrl: string) {
		this.connectV4();
	}

	get connected(): boolean {
		return !!this.socket?.connected;
	}

	get id(): string | undefined {
		return this.socket?.id;
	}

	on(event: string, handler: SocketHandler): this {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
		this.bridgeEvent(event);
		return this;
	}

	once(event: string, handler: SocketHandler): this {
		const onceHandler = (...args: any[]) => {
			this.off(event, onceHandler);
			handler(...args);
		};
		return this.on(event, onceHandler);
	}

	off(event: string, handler?: SocketHandler): this {
		if (!handler) {
			this.listeners.delete(event);
			return this;
		}
		this.listeners.get(event)?.delete(handler);
		return this;
	}

	removeListener(event: string, handler?: SocketHandler): this {
		return this.off(event, handler);
	}

	emit(event: string, ...args: any[]): this {
		if (this.closed) {
			return this;
		}
		if (!this.socket?.connected) {
			if (COALESCED_PENDING_EVENTS.has(event)) {
				this.pendingEmits = this.pendingEmits.filter((emit) => emit.event !== event);
			}
			this.pendingEmits.push({ event, args });
			if (this.pendingEmits.length > MAX_PENDING_EMITS) {
				this.pendingEmits = this.pendingEmits.slice(this.pendingEmits.length - MAX_PENDING_EMITS);
			}
			return this;
		}
		this.socket.emit(event, ...args);
		return this;
	}

	close(): this {
		this.closed = true;
		this.clearFallbackTimer();
		this.pendingEmits = [];
		this.socket?.close();
		return this;
	}

	disconnect(): this {
		this.closed = true;
		this.clearFallbackTimer();
		this.pendingEmits = [];
		if (this.socket?.disconnect) {
			this.socket.disconnect();
		} else {
			this.socket?.close();
		}
		return this;
	}

	private connectV4(): void {
		const socket = ioV4(this.serverUrl, {
			transports: ['websocket'],
			timeout: SOCKET_CONNECT_TIMEOUT_MS,
			reconnection: true,
			forceNew: true,
		}) as unknown as AnySocket;
		this.activateSocket(socket, '4');
		this.fallbackTimer = window.setTimeout(() => this.fallbackToV2(), V4_FALLBACK_DELAY_MS);
	}

	private fallbackToV2(error?: unknown): void {
		if (this.closed || this.v2FallbackStarted) {
			return;
		}
		this.v2FallbackStarted = true;
		this.clearFallbackTimer();
		console.warn('Socket.IO 4 connection failed; falling back to Socket.IO 2.4.0', error);
		this.socket?.close();
		const socket = ioV2(this.serverUrl, {
			...COMPATIBLE_SOCKET_OPTIONS,
			timeout: SOCKET_CONNECT_TIMEOUT_MS,
			reconnection: true,
			forceNew: true,
		}) as unknown as AnySocket;
		this.activateSocket(socket, '2.4.0');
	}

	private activateSocket(socket: AnySocket, version: SocketVersion): void {
		this.socket = socket;
		this.bridgedEvents = new Set();
		let connectedOnce = false;

		socket.on('connect', () => {
			if (this.socket !== socket) {
				return;
			}
			connectedOnce = true;
			this.clearFallbackTimer();
			console.log(`Connected to voice server with Socket.IO ${version}`);
			this.dispatch('compatible_socket_version', version);
			this.dispatch('connect');
			this.flushPendingEmits();
		});
		socket.on('disconnect', (...args: any[]) => {
			if (this.socket === socket) {
				this.dispatch('disconnect', ...args);
			}
		});
		socket.on('connect_error', (error: unknown) => {
			if (this.socket !== socket) {
				return;
			}
			if (version === '4' && !this.v2FallbackStarted && !connectedOnce) {
				this.fallbackToV2(error);
				return;
			}
			this.dispatch('connect_error', error);
		});
		socket.on('connect_timeout', (error: unknown) => {
			if (this.socket === socket) {
				this.dispatch('connect_timeout', error);
			}
		});
		socket.on('error', (error: unknown) => {
			if (this.socket !== socket) {
				return;
			}
			if (version === '4' && !this.v2FallbackStarted && !connectedOnce) {
				this.fallbackToV2(error);
				return;
			}
			this.dispatch('error', error);
		});

		for (const event of this.listeners.keys()) {
			this.bridgeEvent(event);
		}
	}

	private bridgeEvent(event: string): void {
		if (!this.socket || INTERNAL_EVENTS.has(event) || this.bridgedEvents.has(event)) {
			return;
		}
		const socket = this.socket;
		socket.on(event, (...args: any[]) => {
			if (this.socket === socket) {
				this.dispatch(event, ...args);
			}
		});
		this.bridgedEvents.add(event);
	}

	private dispatch(event: string, ...args: any[]): void {
		const handlers = this.listeners.get(event);
		if (!handlers) {
			return;
		}
		for (const handler of [...handlers]) {
			handler(...args);
		}
	}

	private flushPendingEmits(): void {
		if (!this.socket?.connected) {
			return;
		}
		const pending = this.pendingEmits;
		this.pendingEmits = [];
		for (const { event, args } of pending) {
			this.socket.emit(event, ...args);
		}
	}

	private clearFallbackTimer(): void {
		if (this.fallbackTimer !== undefined) {
			window.clearTimeout(this.fallbackTimer);
			this.fallbackTimer = undefined;
		}
	}
}

export function connectCompatibleSocket(serverUrl: string): SocketIOClient.Socket {
	return new CompatibleSocket(serverUrl) as unknown as SocketIOClient.Socket;
}
