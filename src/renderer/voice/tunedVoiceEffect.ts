import { VoiceEffectTuning, voicePitchRatio } from '../../common/VoiceEffectTuning';
import {
	createBerserkerEffect,
	disconnectBerserkerEffect,
	updateBerserkerEffect,
	BerserkerEffect,
} from './berserkerEffect';
import {
	createSourceFilterEffect,
	disconnectProcessingEffect,
	updateSourceFilterEffect,
	SourceFilterEffect,
} from './sourceFilterEffect';
import { connectReverbMix, createReverbMix, reverbLevels } from './reverbMix';
import { setEffectGain } from './effectGain';
import { createVoicePeakGuard } from './voicePeakGuard';

export interface TuningEcho {
	input: GainNode;
	output: GainNode;
	dry: GainNode;
	wet: GainNode;
	delay: DelayNode;
	feedback: GainNode;
}

export function createTuningEcho(context: AudioContext): TuningEcho {
	const input = context.createGain(),
		output = context.createGain(),
		dry = context.createGain(),
		wet = context.createGain();
	const delay = context.createDelay(0.5),
		feedback = context.createGain();
	delay.delayTime.value = 0.18;
	feedback.gain.value = 0.22;
	dry.gain.value = 1;
	input.connect(dry);
	dry.connect(output);
	input.connect(delay);
	delay.connect(feedback);
	feedback.connect(delay);
	delay.connect(wet);
	wet.connect(output);
	return { input, output, dry, wet, delay, feedback };
}

export function disconnectTuningEcho(effect: TuningEcho): void {
	for (const node of Object.values(effect)) node.disconnect();
}

/** Pitch and echo are shared by all active role tunings; reverb uses the peer's existing convolver. */
export interface TunedVoiceEffect {
	kind: 'tuned';
	input: GainNode;
	output: GainNode;
	pitch?: SourceFilterEffect;
	berserker?: BerserkerEffect;
	echo?: TuningEcho;
	update: (tuning: VoiceEffectTuning, berserkerStrength?: number, pitchReady?: boolean) => void;
	disconnect: () => void;
}

export function createTunedVoiceEffect(context: AudioContext, bibiriPreview = false): TunedVoiceEffect {
	const input = context.createGain(),
		output = context.createGain();
	input.connect(output);
	const effect: TunedVoiceEffect = {
		kind: 'tuned',
		input,
		output,
		update(tuning, berserkerStrength = 0, pitchReady = true) {
			const previousPitch = effect.pitch,
				previousBerserker = effect.berserker,
				previousEcho = effect.echo;
			if (tuning.pitch !== 0 && pitchReady) {
				effect.pitch ??= createSourceFilterEffect(context);
				updateSourceFilterEffect(effect.pitch, { pitch: voicePitchRatio(tuning.pitch), formant: 1, squash: 0 });
			} else if (effect.pitch) {
				disconnectProcessingEffect(effect.pitch);
				effect.pitch = undefined;
			}
			if (berserkerStrength > 0) {
				effect.berserker ??= createBerserkerEffect(context);
				updateBerserkerEffect(effect.berserker, berserkerStrength);
			} else if (effect.berserker) {
				disconnectBerserkerEffect(effect.berserker);
				effect.berserker = undefined;
			}
			if (tuning.echo > 0) {
				effect.echo ??= createTuningEcho(context);
				setEffectGain(effect.echo.wet, ((bibiriPreview ? 0.65 : 0.12) * tuning.echo) / 100);
				if (bibiriPreview) {
					effect.echo.delay.delayTime.value = 0.3;
					setEffectGain(effect.echo.feedback, (0.56 * tuning.echo) / 100);
				}
			} else if (effect.echo) {
				disconnectTuningEcho(effect.echo);
				effect.echo = undefined;
			}
			if (previousPitch === effect.pitch && previousBerserker === effect.berserker && previousEcho === effect.echo)
				return;
			input.disconnect();
			let current: AudioNode = input;
			for (const node of [effect.pitch, effect.berserker, effect.echo]) {
				if (!node) continue;
				node.output.disconnect();
				current.connect(node.input);
				current = node.output;
			}
			current.connect(output);
		},
		disconnect() {
			input.disconnect();
			output.disconnect();
			if (effect.pitch) disconnectProcessingEffect(effect.pitch);
			if (effect.berserker) disconnectBerserkerEffect(effect.berserker);
			if (effect.echo) disconnectTuningEcho(effect.echo);
		},
	};
	return effect;
}

/** A standalone playback/preview path, using the same pitch and tail controls as live peers. */
export function createTunedPlayback(context: AudioContext, bibiriPreview = false) {
	const processing = createTunedVoiceEffect(context, bibiriPreview),
		output = context.createGain();
	let reverb: ConvolverNode | undefined,
		mix: ReturnType<typeof createReverbMix> | undefined,
		peakGuard: ReturnType<typeof createVoicePeakGuard> | undefined,
		connected = false;
	processing.output.connect(output);
	return {
		input: processing.input,
		output,
		processing,
		update(tuning: VoiceEffectTuning, buffer: AudioBuffer | null, pitchReady = true, berserkerStrength = 0) {
			processing.update(tuning, berserkerStrength, pitchReady);
			const wantReverb = tuning.reverb > 0 && !!buffer;
			if (wantReverb) {
				reverb ??= context.createConvolver();
				if (reverb.buffer !== buffer) reverb.buffer = buffer;
				mix ??= createReverbMix(context);
				const levels = reverbLevels(tuning.reverb);
				setEffectGain(mix.dry, levels.dry);
				setEffectGain(mix.wet, levels.wet);
			}
			const wantGuard = wantReverb || !!(processing.pitch || processing.berserker || processing.echo);
			if (wantReverb === connected && wantGuard === !!peakGuard) return;
			processing.output.disconnect();
			reverb?.disconnect();
			peakGuard?.output.disconnect();
			if (mix) for (const node of Object.values(mix)) node.disconnect();
			let current: AudioNode = processing.output;
			if (wantReverb && reverb && mix) current = connectReverbMix(current, reverb, mix);
			else {
				reverb = undefined;
				mix = undefined;
			}
			if (wantGuard) {
				peakGuard ??= createVoicePeakGuard(context);
				current.connect(peakGuard.input);
				peakGuard.output.connect(output);
			} else {
				peakGuard?.disconnect();
				peakGuard = undefined;
				current.connect(output);
			}
			connected = wantReverb;
		},
		disconnect() {
			processing.disconnect();
			output.disconnect();
			peakGuard?.disconnect();
			reverb?.disconnect();
			if (mix) for (const node of Object.values(mix)) node.disconnect();
		},
	};
}
