import { AmongUsState, Client, GameState, Player } from './AmongUsState';

export interface VoiceRoleIdentity {
	lobbyCode: string;
	playerId: number;
	clientId: number;
}
export interface VoiceRoleRequest extends VoiceRoleIdentity {
	protocol: 1;
	code: string;
	session: string;
}
export interface VoiceRoleAck extends VoiceRoleIdentity {
	protocol: 1;
	session: string;
	lease: string;
	revoked?: boolean;
}
export interface VoiceRoleSample extends VoiceRoleIdentity {
	protocol: 1;
	session: string;
	lease: string;
	sequence: number;
	rms: number;
	active: boolean;
}

export function voiceRoleIdentity(
	state: AmongUsState | undefined,
	player: Player | undefined
): VoiceRoleIdentity | undefined {
	if (
		state?.mod !== 'NoS' ||
		!player ||
		player.disconnected ||
		![GameState.LOBBY, GameState.TASKS, GameState.DISCUSSION].includes(state.gameState)
	)
		return;
	return { lobbyCode: state.lobbyCode, playerId: player.id, clientId: player.clientId };
}

export function sameVoiceRoleIdentity(a: VoiceRoleIdentity, b: VoiceRoleIdentity): boolean {
	return a.lobbyCode === b.lobbyCode && a.playerId === b.playerId && a.clientId === b.clientId;
}

export function validVoiceRoleSample(value: unknown): value is VoiceRoleSample {
	if (!value || typeof value !== 'object') return false;
	const s = value as VoiceRoleSample;
	return (
		s.protocol === 1 &&
		typeof s.session === 'string' &&
		/^[a-f0-9]{32}$/.test(s.session) &&
		typeof s.lease === 'string' &&
		/^[a-f0-9]{32}$/.test(s.lease) &&
		Number.isSafeInteger(s.sequence) &&
		s.sequence > 0 &&
		typeof s.rms === 'number' &&
		Number.isFinite(s.rms) &&
		s.rms >= 0 &&
		s.rms <= 1 &&
		typeof s.active === 'boolean'
	);
}

/** Only the explicitly paired socket may supply this PC's local player's microphone. */
export class RemoteVoiceRoleInput {
	code = '';
	private identity?: VoiceRoleIdentity;
	private peer = '';
	private session = '';
	private leases = new Map<string, number>();
	private sequence = 0;
	private receivedAt = -Infinity;
	private acceptedAt = -Infinity;

	enable(identity: VoiceRoleIdentity, code: string): void {
		this.clear();
		this.identity = identity;
		this.code = code;
	}
	clear(): void {
		this.code = '';
		this.identity = undefined;
		this.peer = '';
		this.session = '';
		this.leases.clear();
		this.sequence = 0;
		this.receivedAt = -Infinity;
		this.acceptedAt = -Infinity;
	}
	sync(identity: VoiceRoleIdentity | undefined): void {
		if (this.identity && (!identity || !sameVoiceRoleIdentity(this.identity, identity))) this.clear();
	}
	get connected(): boolean {
		return Date.now() - this.receivedAt < 1000;
	}
	get pairedPeer(): string {
		return this.peer;
	}
	get revocation(): VoiceRoleAck | undefined {
		const lease = [...this.leases.keys()].at(-1);
		return this.identity && lease
			? { ...this.identity, protocol: 1, session: this.session, lease, revoked: true }
			: undefined;
	}
	release(from: string, client: Client | undefined, value: unknown, now = Date.now()): boolean {
		if (!value || typeof value !== 'object' || !this.identity || from !== this.peer) return false;
		const release = value as VoiceRoleAck;
		return (
			release.protocol === 1 &&
			release.session === this.session &&
			sameVoiceRoleIdentity(release, this.identity) &&
			client?.playerId === this.identity.playerId &&
			client.clientId === this.identity.clientId &&
			now - (this.leases.get(release.lease) ?? -Infinity) <= 2000
		);
	}
	request(
		from: string,
		client: Client | undefined,
		value: unknown,
		lease: string,
		now = Date.now()
	): VoiceRoleAck | undefined {
		if (!this.identity || !value || typeof value !== 'object') return;
		const request = value as VoiceRoleRequest;
		if (
			request.protocol !== 1 ||
			request.code !== this.code ||
			!sameVoiceRoleIdentity(request, this.identity) ||
			client?.playerId !== this.identity.playerId ||
			client.clientId !== this.identity.clientId ||
			typeof request.session !== 'string' ||
			!/^[a-f0-9]{32}$/.test(request.session) ||
			(this.peer && (this.peer !== from || this.session !== request.session) && now - this.acceptedAt < 3000)
		)
			return;
		if (this.peer !== from || this.session !== request.session) {
			this.sequence = 0;
			this.leases.clear();
			this.receivedAt = -Infinity;
		}
		this.peer = from;
		this.session = request.session;
		this.acceptedAt = now;
		for (const [key, time] of this.leases) if (now - time > 2000) this.leases.delete(key);
		this.leases.set(lease, now);
		return { ...this.identity, protocol: 1, session: this.session, lease };
	}
	sample(from: string, client: Client | undefined, value: unknown, now = Date.now()): VoiceRoleSample | undefined {
		if (
			!this.identity ||
			from !== this.peer ||
			!validVoiceRoleSample(value) ||
			value.session !== this.session ||
			!sameVoiceRoleIdentity(value, this.identity) ||
			client?.playerId !== this.identity.playerId ||
			client.clientId !== this.identity.clientId ||
			value.sequence <= this.sequence ||
			now - (this.leases.get(value.lease) ?? -Infinity) > 2000 ||
			now - this.receivedAt < 30
		)
			return;
		this.sequence = value.sequence;
		this.receivedAt = now;
		return value;
	}
}
