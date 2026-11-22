import { nosAddonLink } from './nosAddonLink';
import { localSpeechStatus, localStoneWorker } from './localStoneSpeech';
import { validStoneWav } from './voiceStoneAudio';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket, type Socket } from 'node:dgram';
import type { IpcMain } from 'electron';
import { GameState, type AmongUsState } from '../common/AmongUsState';
import type { HeroSpeechPlayer } from '../common/HeroSpeech';
import { heardTransformation, heardForbiddenWord } from '../common/HeroSpeech';
import { hasTanukiAddon } from '../common/tanukiAddon';
import { validStoneWord } from '../common/VoiceStoneSpeech';
interface Descriptor {
	unified?: boolean;
	protocol: 2;
	pid: number;
	port: number;
	token: string;
	updated: number;
	players: HeroSpeechPlayer[];
}
export function validHeroSpeechDescriptor(value: unknown, pid: number, now: number): value is Descriptor {
	if (!value || typeof value !== 'object') return false;
	const d = value as Descriptor;
	if (
		d.protocol !== 2 ||
		d.pid !== pid ||
		!Number.isInteger(d.port) ||
		d.port < 1 ||
		d.port > 65535 ||
		!Number.isFinite(d.updated) ||
		now - d.updated > 1500 ||
		d.updated - now > 100 ||
		typeof d.token !== 'string' ||
		!/^[a-f0-9]{32}$/.test(d.token) ||
		!Array.isArray(d.players) ||
		d.players.length < 1 ||
		d.players.length > 72
	)
		return false;
	const ids = new Set<string>();
	return d.players.every((p) => {
		if (
			!p ||
			!Number.isInteger(p.playerId) ||
			p.playerId < 0 ||
			p.playerId > 255 ||
			!['hero', 'ng', 'stone'].includes(p.kind) ||
			ids.has(`${p.playerId}|${p.kind}`) ||
			!Number.isInteger(p.request) ||
			p.request < 0 ||
			p.request > 2147483647 ||
			!Array.isArray(p.words) ||
			p.words.length > 3 ||
			!p.words.every((w) => typeof w === 'string' && w.length >= 2 && w.length <= 32) ||
			(p.kind === 'ng' && (p.request === 0 || p.words.length === 0)) ||
			(p.kind === 'stone' &&
				(p.words.length !== 0 || !Number.isInteger(p.maxCharacters) || p.maxCharacters < 1 || p.maxCharacters > 12)) ||
			(p.recognizer !== undefined &&
				p.recognizer !== 'local' &&
				!(p.kind === 'stone' && p.recognizer === 'local-neural')) ||
			(p.recognizer === 'local-neural' &&
				(!Number.isSafeInteger(p.recordUntil) ||
					p.recordUntil! > now + 11000 ||
					(p.request > 0 &&
						(!Number.isSafeInteger(p.recordStarted) ||
							p.recordUntil! - p.recordStarted! < 1000 ||
							p.recordUntil! - p.recordStarted! > 10000 ||
							p.expires - p.recordUntil! !== 20000)))) ||
			!Number.isSafeInteger(p.expires) ||
			(p.request > 0 && (p.expires < now - 100 || p.expires > now + (p.recognizer === 'local-neural' ? 31000 : 16000)))
		)
			return false;
		ids.add(`${p.playerId}|${p.kind}`);
		return true;
	});
}
export function registerHeroSpeechBridge(
	ipc: IpcMain,
	getContext: () => { pid: number; state?: AmongUsState },
	isMainRenderer: (id: number) => boolean
): () => void {
	let udp: Socket | undefined;
	const localPending = new Map<string, AbortController>();
	const localSubmitted = new Set<string>();
	let localSession = '';
	const livePending = new Map<number, { controller: AbortController; jobs: HeroSpeechPlayer[] }>();
	const liveHandled = new Set<string>();
	const liveLastClip = new Map<number, number>();
	const identity = (p: HeroSpeechPlayer) => JSON.stringify([p.playerId, p.kind, p.request, p.words]);
	function sameJob(a: HeroSpeechPlayer, b: HeroSpeechPlayer): boolean {
		return identity(a) === identity(b) && b.request > 0 && b.expires > Date.now();
	}
	function cancelLocal(): void {
		for (const p of livePending.values()) p.controller.abort();
		livePending.clear();
		liveHandled.clear();
		liveLastClip.clear();
		for (const controller of localPending.values()) controller.abort();
		localPending.clear();
		localSubmitted.clear();
		localSession = '';
	}
	function close(): void {
		const current = udp;
		udp = undefined;
		current?.close();
	}
	function send(payload: string, port: number): void {
		if (!udp) {
			udp = createSocket('udp4');
			udp.on('error', () => {});
			udp.unref();
		}
		udp.send(payload, port, '127.0.0.1');
	}
	function descriptor(): Descriptor | undefined {
		const { pid, state } = getContext();
		if (
			!hasTanukiAddon(state) ||
			![GameState.TASKS, GameState.DISCUSSION].includes(state.gameState) ||
			!pid ||
			!process.env.LOCALAPPDATA
		) {
			close();
			return;
		}
		const profile = nosAddonLink.current(pid);
		if (profile) {
			const players = profile.channels.speech.filter((p) => p.request === 0 || p.expires > Date.now());
			return players.length
				? {
						protocol: 2,
						pid,
						port: nosAddonLink.endpoint(),
						token: profile.session,
						updated: profile.unixMs,
						players,
						unified: true,
					}
				: undefined;
		}
		try {
			const path = join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS', `hero-speech-${pid}.json`);
			if (statSync(path).size > 32768) return;
			const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
			if (validHeroSpeechDescriptor(data, pid, Date.now())) return data;
		} catch {
			/* No armed hero or an in-progress heartbeat write. */
		}
	}
	ipc.handle('NOS_HERO_SPEECH_STATE', (event) => {
		if (!isMainRenderer(event.sender.id)) return null;
		localStoneWorker.idle();
		const d = descriptor();
		if (!d || localSession !== d.token || !localSpeechStatus().enabled) cancelLocal();
		if (!d) localStoneWorker.close();
		localSession = d?.token ?? '';
		for (const [id, controller] of localPending) {
			if (
				!d?.players.some(
					(p) =>
						`${d.token}|${p.playerId}|${p.request}` === id && p.recognizer === 'local-neural' && p.expires > Date.now()
				)
			) {
				controller.abort();
				localPending.delete(id);
			}
		}
		for (const [player, p] of livePending) {
			if (!permitted(player) || !p.jobs.some((j) => d?.players.some((live) => sameJob(j, live)))) {
				p.controller.abort();
				livePending.delete(player);
			}
		}
		return d
			? { pid: d.pid, session: d.token, players: d.players, localNeuralConfigured: localSpeechStatus().enabled }
			: null;
	});
	ipc.on('NOS_HERO_SPEECH_STOP', (event) => {
		if (!isMainRenderer(event.sender.id)) return;
		cancelLocal();
		localStoneWorker.close();
	});
	ipc.handle(
		'HERO_SPEECH_LOCAL_TRANSCRIBE',
		async (event, session: unknown, player: unknown, refs: unknown, capturedAt: unknown, bytes: unknown) => {
			if (
				!isMainRenderer(event.sender.id) ||
				!localSpeechStatus().enabled ||
				!permitted(player) ||
				typeof player !== 'number' ||
				typeof capturedAt !== 'number' ||
				!Number.isSafeInteger(capturedAt) ||
				Date.now() - capturedAt > 5000 ||
				capturedAt > Date.now() + 100 ||
				!(bytes instanceof Uint8Array) ||
				!validStoneWav(bytes) ||
				!Array.isArray(refs) ||
				refs.length < 1 ||
				refs.length > 2
			)
				return false;
			const d = descriptor();
			if (!d || d.token !== session) return false;
			const jobs = d.players.filter(
				(p) =>
					p.playerId === player &&
					p.kind !== 'stone' &&
					p.request > 0 &&
					p.expires > Date.now() &&
					refs.some((r) => r?.kind === p.kind && r?.request === p.request)
			);
			if (
				jobs.length !== refs.length ||
				livePending.has(player) ||
				livePending.size + localPending.size >= 4 ||
				(liveLastClip.get(player) ?? 0) >= capturedAt ||
				liveHandled.size >= 1024
			)
				return false;
			liveLastClip.set(player, capturedAt);
			const controller = new AbortController(),
				entry = { controller, jobs };
			livePending.set(player, entry);
			const timer = setTimeout(() => controller.abort(), 18000);
			try {
				const text = await localStoneWorker.transcribeText(bytes, controller.signal);
				const live = descriptor();
				if (
					!text ||
					controller.signal.aborted ||
					!localSpeechStatus().enabled ||
					!permitted(player) ||
					live?.token !== session ||
					Date.now() - capturedAt > 5000
				)
					return false;
				let sent = false;
				for (const job of jobs) {
					const key = identity(job);
					if (
						liveHandled.has(key) ||
						!live.players.some((p) => sameJob(job, p)) ||
						!(job.kind === 'ng'
							? heardForbiddenWord(text, job.words, true)
							: heardTransformation(text, job.words, true))
					)
						continue;
					liveHandled.add(key);
					if (live.unified)
						sent =
							nosAddonLink.sendCommand(live.pid, 'word', {
								playerId: player,
								request: job.request,
								speechKind: job.kind,
							}) || sent;
					else {
						send(
							`TBCLHS2|${live.token}|word|${Date.now()}|${player}|${job.request}|${job.kind === 'ng' ? 'ng' : 'henshin'}`,
							live.port
						);
						sent = true;
					}
				}
				return sent;
			} finally {
				clearTimeout(timer);
				if (livePending.get(player) === entry) livePending.delete(player);
			}
		}
	);
	ipc.handle(
		'VOICE_STONE_LOCAL_TRANSCRIBE',
		async (event, session: unknown, player: unknown, request: unknown, bytes: unknown) => {
			if (
				!isMainRenderer(event.sender.id) ||
				!localSpeechStatus().enabled ||
				!(bytes instanceof Uint8Array) ||
				!validStoneWav(bytes) ||
				!permitted(player)
			)
				return false;
			const d = descriptor();
			const job = d?.players.find(
				(p) =>
					p.kind === 'stone' &&
					p.recognizer === 'local-neural' &&
					p.playerId === player &&
					p.request === request &&
					p.request > 0
			);
			if (!d || d.token !== session || !job || job.expires <= Date.now() || job.recordUntil! > Date.now() + 100)
				return false;
			const id = `${session}|${player}|${request}`;
			if (localSubmitted.has(id) || localPending.size >= 4 || localSubmitted.size >= 1024) return false;
			localSubmitted.add(id);
			const controller = new AbortController();
			localPending.set(id, controller);
			const timer = setTimeout(() => controller.abort(), Math.min(18000, job.expires - Date.now()));
			try {
				const word = await localStoneWorker.transcribe(bytes, job.maxCharacters!, controller.signal);
				const live = descriptor();
				if (
					!word ||
					controller.signal.aborted ||
					!localSpeechStatus().enabled ||
					live?.token !== session ||
					!live.players.some(
						(p) =>
							p.playerId === player &&
							p.kind === 'stone' &&
							p.recognizer === 'local-neural' &&
							p.request === request &&
							p.expires > Date.now()
					)
				)
					return false;
				if (!live.unified) return false;
				return nosAddonLink.sendCommand(live.pid, 'word', { playerId: player, request, speechKind: 'stone', word });
			} finally {
				clearTimeout(timer);
				localPending.delete(id);
			}
		}
	);
	ipc.on('NOS_HERO_SPEECH_READY', (event, session: unknown, ready: unknown, neural: unknown = []) => {
		if (!isMainRenderer(event.sender.id) || !Array.isArray(ready) || ready.length > 24) return;
		const d = descriptor();
		if (!d || session !== d.token) return;
		const allowed = ready.filter((id) => d.players.some((p) => p.playerId === id) && permitted(id));
		if (d.unified) {
			nosAddonLink.sendCommand(d.pid, 'ready', {
				players: allowed,
				neural: localSpeechStatus().enabled && Array.isArray(neural) ? allowed.filter((id) => neural.includes(id)) : [],
			});
			return;
		}
		for (const id of allowed) {
			if (!d.players.some((p) => p.playerId === id) || !permitted(id)) continue;
			send(`TBCLHS2|${d.token}|ready|${Date.now()}|${id}|1`, d.port);
		}
	});
	function permitted(id: unknown): boolean {
		const state = getContext().state;
		return !!state && (state.isHost || state.players.some((p) => p.isLocal && p.id === id));
	}
	ipc.on(
		'NOS_HERO_SPEECH_WORD',
		(event, session: unknown, player: unknown, request: unknown, kind: unknown, word: unknown) => {
			if (!isMainRenderer(event.sender.id)) return;
			const d = descriptor();
			const armed = d?.players.find(
				(p) => p.playerId === player && p.request === request && p.kind === kind && p.request > 0
			);
			if (!d || session !== d.token || !armed || armed.expires <= Date.now() || !permitted(player)) return;
			if (kind === 'stone' && !validStoneWord(word, armed.maxCharacters)) return;
			if (d.unified) {
				nosAddonLink.sendCommand(d.pid, 'word', {
					playerId: armed.playerId,
					request: armed.request,
					speechKind: kind,
					...(kind === 'stone' ? { word } : {}),
				});
				return;
			}
			const payload =
				kind === 'stone'
					? `stone|${Buffer.from(word as string, 'utf8').toString('base64')}`
					: kind === 'ng'
						? 'ng'
						: 'henshin';
			send(`TBCLHS2|${d.token}|word|${Date.now()}|${armed.playerId}|${armed.request}|${payload}`, d.port);
		}
	);
	return () => {
		close();
		cancelLocal();
		localStoneWorker.close();
	};
}
