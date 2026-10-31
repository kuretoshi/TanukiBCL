import { GameState } from '../../common/AmongUsState';
import { getRokuroVoice } from '../../common/RokuroVoice';
import { applyVoiceJamming } from '../../common/VoiceJammingState';
import { calculateVoiceAudio, type VoiceAudioInput } from './spatialAudio';
import { setEffectGain } from './effectGain';
import { createVoicePeakGuard } from './voicePeakGuard';

export function calculateRokuroVoice(input: VoiceAudioInput) {
	const { state, me, other, activeLobbySettings: lobby } = input;
	const speaker = other.nosPlayer;
	const radios = input.impostorRadioClientIds ?? [input.impostorRadioClientId];
	if (
		state.mod !== 'NoS' ||
		state.gameState !== GameState.TASKS ||
		me.isDead ||
		other.isDead ||
		other.disconnected ||
		other.isDummy ||
		lobby.nosRokurokubiVoiceEffect === false ||
		speaker?.bodyType !== 3 ||
		!Number.isFinite(speaker.neckLength) ||
		speaker.neckLength <= 0 ||
		![other.x, other.y, speaker.speakerPositionX, speaker.speakerPositionY].every(Number.isFinite) ||
		Math.hypot(other.x - speaker.speakerPositionX, other.y - speaker.speakerPositionY) < 0.05 ||
		radios.includes(other.clientId) ||
		state.airshipMeetingByOutfit ||
		input.airshipSpawnFallback
	)
		return undefined;
	const body = calculateVoiceAudio({ ...input, rokuroBodyOrigin: true });
	applyVoiceJamming(state, other.id, body);
	return { body, settings: getRokuroVoice(input.settings.rokuroVoice) };
}

/** A lazy second positional source. Both sources share one final peak guard and listener volume gate. */
export function createRokuroVoice(context: AudioContext, source: AudioNode, destination: AudioNode) {
	const pan = context.createPanner();
	pan.panningModel = 'equalpower';
	pan.distanceModel = 'linear';
	pan.refDistance = 0.1;
	pan.rolloffFactor = 1;
	const filter = context.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = 1800;
	filter.Q.value = Math.SQRT1_2;
	const gain = context.createGain();
	setEffectGain(gain, 0);
	const dry = context.createGain(),
		wet = context.createGain(),
		feedback = context.createGain();
	const delay = context.createDelay(0.5);
	delay.delayTime.value = 0.18;
	const mix = context.createGain(),
		output = context.createGain();
	output.gain.value = 0;
	const guard = createVoicePeakGuard(context);
	source.connect(pan);
	pan.connect(filter);
	filter.connect(gain);
	gain.connect(dry);
	dry.connect(mix);
	gain.connect(delay);
	delay.connect(wet);
	wet.connect(mix);
	delay.connect(feedback);
	feedback.connect(delay);
	mix.connect(guard.input);
	guard.output.connect(output);
	output.connect(destination);
	let headWeight = 1,
		bodyWeight = 0,
		lastCutoff = 1800;
	return {
		mix,
		configure(
			head: number,
			body: number,
			position: [number, number] | null,
			maxDistance: number,
			echo: number,
			cutoff = 1800
		) {
			const total = Math.max(head, body);
			headWeight = total > 0 ? head / total : 0;
			bodyWeight = total > 0 ? body / total : 0;
			pan.maxDistance = maxDistance;
			const at = context.currentTime;
			pan.positionX.setValueAtTime(position?.[0] ?? 0, at);
			pan.positionY.setValueAtTime(position?.[1] ?? 0, at);
			pan.positionZ.setValueAtTime(-0.5, at);
			const nextCutoff = Math.min(1800, cutoff);
			if (nextCutoff !== lastCutoff) {
				filter.frequency.setTargetAtTime(nextCutoff, at, 0.01);
				lastCutoff = nextCutoff;
			}
			const strength = Math.max(0, Math.min(100, echo)) / 100;
			setEffectGain(dry, 1 - 0.35 * strength);
			setEffectGain(wet, 0.5 * strength);
			setEffectGain(feedback, 0.3 * strength);
			return total;
		},
		setGain(value: number) {
			// Mute after the delay/guard too, so a queued tail cannot bypass deafen or player mute.
			setEffectGain(gain, value * bodyWeight);
			output.gain.value = value > 0 ? 1 : 0;
			return value * headWeight;
		},
		disconnect() {
			try {
				source.disconnect(pan);
			} catch {
				/* source already removed */
			}
			for (const node of [pan, filter, gain, dry, wet, feedback, delay, mix, output]) node.disconnect();
			guard.disconnect();
		},
	};
}
