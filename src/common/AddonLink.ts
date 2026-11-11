import { validParrot, type ParrotState } from './ParrotState';
import { validWallEar, type WallEarState } from './WallEarState';
import type { HeroTransformState } from './HeroTransformState';
import { validHeroTransform } from './HeroTransformState';
import type { InterviewState } from './InterviewState';
import { validInterview } from './InterviewState';
import type { VoiceJammingState } from './VoiceJammingState';
import { validVoiceJamming } from './VoiceJammingState';
import type { MegaphoneState } from './MegaphoneState';
import type { DyingVoiceState } from './DyingVoiceState';
import type { HeroSpeechPlayer } from './HeroSpeech';

export interface AddonChannels {
	parrots?: ParrotState[];
	ears?: WallEarState[];
	heroes: HeroTransformState[];
	portable: { playerId: number; extraRange: number }[];
	megaphones: MegaphoneState[];
	dying: DyingVoiceState[];
	interviews: InterviewState[];
	jamming: VoiceJammingState[];
	echoes: { playerId: number; unixMs: number }[];
	muted: number[];
	speech: HeroSpeechPlayer[];
}
export interface AddonProfile {
	kind: 'state';
	protocol: 1;
	pid: number;
	session: string;
	sequence: number;
	unixMs: number;
	phase: 'lobby' | 'tasks' | 'meeting';
	localPlayer: number;
	host: boolean;
	channels: AddonChannels;
}
export function addonLinkPort(value: unknown): number | undefined {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) return;
	return ((value as number) & 0xffff0000) === 0x54420000 && ((value as number) & 65535) > 0
		? (value as number) & 65535
		: undefined;
}
const id = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
const range = (v: unknown, min: number, max: number): boolean =>
	typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const time = (v: unknown, max: number): boolean => Number.isSafeInteger(v) && range(v, 0, max);
const optionalBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
function unique<T>(v: unknown, valid: (entry: T) => boolean, key: (entry: T) => unknown, max = 24): v is T[] {
	if (!Array.isArray(v) || v.length > max || !v.every((e) => e && valid(e))) return false;
	return new Set(v.map(key)).size === v.length;
}
function speechValid(p: HeroSpeechPlayer, now: number): boolean {
	return (
		id(p.playerId) &&
		['hero', 'ng', 'stone'].includes(p.kind) &&
		Number.isInteger(p.request) &&
		range(p.request, 0, 2147483647) &&
		time(p.expires, now + 16000) &&
		Array.isArray(p.words) &&
		p.words.length <= 3 &&
		p.words.every((w) => typeof w === 'string' && w.length >= 2 && w.length <= 32) &&
		(p.kind !== 'ng' || (p.request > 0 && p.words.length > 0)) &&
		(p.kind !== 'stone' || (p.words.length === 0 && Number.isInteger(p.maxCharacters) && range(p.maxCharacters, 1, 12)))
	);
}
export function validAddonChannels(v: unknown, now: number): v is AddonChannels {
	if (!v || typeof v !== 'object') return false;
	const c = v as AddonChannels;
	const key = (p: { playerId: number }) => p.playerId;
	return (
		(c.parrots === undefined ||
			unique<ParrotState>(
				c.parrots,
				(p) => validParrot(p, now),
				(p) => `${p.ownerId}|${p.birdId}`,
				120
			)) &&
		(c.ears === undefined || unique<WallEarState>(c.ears, validWallEar, key)) &&
		unique<HeroTransformState>(c.heroes, validHeroTransform, key) &&
		unique<AddonChannels['portable'][number]>(c.portable, (p) => id(p.playerId) && range(p.extraRange, 0, 30), key) &&
		unique<MegaphoneState>(
			c.megaphones,
			(p) =>
				id(p.playerId) &&
				range(p.energy, 0, 1) &&
				range(p.range, 2, 40) &&
				optionalBool(p.voiceEffect) &&
				(p.phase === undefined ||
					((p.phase === 'charging' || p.phase === 'firing') &&
						Number.isSafeInteger(p.shotId) &&
						range(p.shotId, 1, Number.MAX_SAFE_INTEGER))),
			key
		) &&
		unique<DyingVoiceState>(
			c.dying,
			(p) =>
				id(p.playerId) &&
				time(p.started, now + 100) &&
				p.started > 0 &&
				range(p.seconds, 1, 30) &&
				range(p.range, 0.5, 10) &&
				optionalBool(p.loop) &&
				range(p.x, -10000, 10000) &&
				range(p.y, -10000, 10000),
			key
		) &&
		unique<InterviewState>(c.interviews, (p) => validInterview(p, now), key) &&
		unique<VoiceJammingState>(c.jamming, validVoiceJamming, key) &&
		unique<AddonChannels['echoes'][number]>(c.echoes, (p) => id(p.playerId) && time(p.unixMs, now + 100), key) &&
		Array.isArray(c.muted) &&
		c.muted.length <= 24 &&
		c.muted.every(id) &&
		new Set(c.muted).size === c.muted.length &&
		unique<HeroSpeechPlayer>(
			c.speech,
			(p) => speechValid(p, now),
			(p) => `${p.playerId}|${p.kind}`,
			72
		)
	);
}
export function validAddonProfile(
	v: unknown,
	pid: number,
	session: string,
	previous: number,
	now: number
): v is AddonProfile {
	if (!v || typeof v !== 'object') return false;
	const p = v as AddonProfile;
	return (
		p.kind === 'state' &&
		p.protocol === 1 &&
		p.pid === pid &&
		p.session === session &&
		Number.isSafeInteger(p.sequence) &&
		p.sequence > previous &&
		time(p.unixMs, now + 100) &&
		now - p.unixMs <= 700 &&
		['lobby', 'tasks', 'meeting'].includes(p.phase) &&
		id(p.localPlayer) &&
		typeof p.host === 'boolean' &&
		validAddonChannels(p.channels, now)
	);
}
