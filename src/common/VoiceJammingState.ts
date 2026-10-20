import { GameState, type AmongUsState } from './AmongUsState';

export interface VoiceJammingState {
	playerId: number;
	muted: boolean;
	lowpass: boolean;
	pitch: number;
}

export function validVoiceJamming(value: VoiceJammingState): boolean {
	return (
		!!value &&
		Number.isInteger(value.playerId) &&
		value.playerId >= 0 &&
		value.playerId <= 255 &&
		typeof value.muted === 'boolean' &&
		typeof value.lowpass === 'boolean' &&
		Number.isFinite(value.pitch) &&
		value.pitch >= 0.5 &&
		value.pitch <= 2
	);
}

export function voiceJammingFor(state: AmongUsState, id: number): VoiceJammingState | undefined {
	if (state.mod !== 'NoS' || state.gameState !== GameState.DISCUSSION) return undefined;
	return Array.isArray(state.nosVoiceJamming)
		? state.nosVoiceJamming.find((entry) => validVoiceJamming(entry) && entry.playerId === id)
		: undefined;
}

export function applyVoiceJamming(
	state: AmongUsState,
	id: number,
	audio: { gain: number; muffle: false | null | { type: BiquadFilterType; frequency: number; q: number } }
): void {
	const effect = voiceJammingFor(state, id);
	if (effect?.muted) audio.gain = 0;
	if (effect?.lowpass) audio.muffle = { type: 'lowpass', frequency: 1200, q: Math.SQRT1_2 };
}
