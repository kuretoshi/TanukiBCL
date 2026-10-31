import {
	VoiceEffectTuning,
	isNeutralVoiceEffectTuning,
	normalizeVoiceEffectTuning,
} from '../../common/VoiceEffectTuning';
import { createTunedPlayback } from './tunedVoiceEffect';
import { createVoicePeakGuard } from './voicePeakGuard';

// Retain a short live audio tail without saving a recording.
export function createBibiriEcho(context: AudioContext, source: AudioNode, destination: AudioNode) {
	const input = context.createGain();
	const delay = context.createDelay(0.5);
	const feedback = context.createGain();
	const output = context.createGain();
	const playback = createTunedPlayback(context);
	delay.delayTime.value = 0.3;
	feedback.gain.value = 0.56;
	output.gain.value = 0;
	source.connect(input);
	input.connect(delay);
	delay.connect(feedback);
	feedback.connect(delay);
	delay.connect(playback.input);
	playback.output.connect(output);
	output.connect(destination);
	return {
		input,
		delay,
		feedback,
		output,
		playback,
		destination,
		peakGuard: undefined as ReturnType<typeof createVoicePeakGuard> | undefined,
		seen: 0,
		wasAlive: false,
		until: 0,
	};
}

export function updateBibiriEcho(
	effect: ReturnType<typeof createBibiriEcho>,
	active: boolean,
	dead: boolean,
	event: number | undefined,
	now = Date.now(),
	strength: number | VoiceEffectTuning = 100,
	buffer: AudioBuffer | null = null,
	pitchReady = true
): void {
	const time = effect.output.context.currentTime;
	const tuning = normalizeVoiceEffectTuning(typeof strength === 'number' ? { echo: strength } : strength);
	if (!active || isNeutralVoiceEffectTuning(tuning)) {
		stopBibiriEcho(effect);
		effect.wasAlive = false;
		return;
	}
	if (dead && effect.until > 0 && effect.until <= time) {
		stopBibiriEcho(effect);
		return;
	}
	if (dead && effect.wasAlive && event && event !== effect.seen && now - event <= 1500 && now >= event - 100) {
		if (!effect.peakGuard) {
			effect.peakGuard = createVoicePeakGuard(effect.output.context);
			effect.output.disconnect();
			effect.output.connect(effect.peakGuard.input);
			effect.peakGuard.output.connect(effect.destination);
		}
		effect.seen = event;
		effect.until = time + 2.4;
		effect.input.gain.value = 0;
		effect.output.gain.cancelScheduledValues(time);
		effect.output.gain.setValueAtTime(0.65, time);
		effect.output.gain.exponentialRampToValueAtTime(0.001, effect.until);
		effect.output.gain.setValueAtTime(0, effect.until);
	}
	effect.playback.update(
		effect.until > time ? { ...tuning, echo: 0 } : { pitch: 0, reverb: 0, echo: 0 },
		buffer,
		pitchReady
	);
	// Retain the last fragment until the death RPC arrives; echo0 then releases it only once.
	effect.feedback.gain.value = effect.until > time ? (0.56 * tuning.echo) / 100 : 0.56;
	if (!dead) effect.wasAlive = true;
	if (dead) effect.input.gain.value = 0;
	else if (effect.until <= time) effect.input.gain.value = 1;
}

export function stopBibiriEcho(effect: ReturnType<typeof createBibiriEcho>): void {
	const time = effect.output.context.currentTime;
	effect.output.gain.cancelScheduledValues(time);
	effect.output.gain.setValueAtTime(0, time);
	effect.input.gain.value = 0;
	effect.feedback.gain.value = 0;
	effect.until = 0;
	effect.playback.update({ pitch: 0, reverb: 0, echo: 0 }, null);
	if (effect.peakGuard) {
		effect.output.disconnect();
		effect.peakGuard.disconnect();
		effect.peakGuard = undefined;
		effect.output.connect(effect.destination);
	}
}

export function disconnectBibiriEcho(effect: ReturnType<typeof createBibiriEcho>): void {
	for (const node of [effect.input, effect.delay, effect.feedback, effect.output]) node.disconnect();
	effect.peakGuard?.disconnect();
	effect.playback.disconnect();
}
