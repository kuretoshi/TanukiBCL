import { createVoiceDisguiseEffect, disconnectVoiceDisguiseEffect, updateVoiceDisguiseEffect } from '../voiceEffect';
import { createBerserkerEffect, disconnectBerserkerEffect, updateBerserkerEffect } from '../voice/berserkerEffect';
import { createSourceFilterEffect, disconnectProcessingEffect, prepareSourceFilter, updateSourceFilterEffect } from '../voice/sourceFilterEffect';
import type { SourceFilterParameters } from '../voice/sourceFilterEffect';

export type VoiceEffectPreviewKind =
	| 'voiceEffectStrength'
	| 'snrJumboVoiceEffectStrength'
	| 'nosSizeVoiceEffectStrength'
	| 'nosRokurokubiVoiceEffectStrength'
	| 'nosBerserkerVoiceEffectStrength'
	| 'nosCitrusVoiceEffectStrength'
	| 'nosRainbowStarEchoStrength'
	| 'nosVoiceJammingEffectStrength'
	| 'nosMegaphoneEffectStrength'
	| 'nosBibiriEchoStrength';

export interface VoiceEffectPreview {
	input: AudioNode;
	output: AudioNode;
	update: (strength: number) => void;
	dispose: () => void;
}

const filterSamples: Partial<Record<VoiceEffectPreviewKind, SourceFilterParameters>> = {
	snrJumboVoiceEffectStrength: { pitch: 0.4, formant: 0.55, squash: 0 },
	nosSizeVoiceEffectStrength: { pitch: 1.3, formant: 1.25, squash: 0 },
	nosRokurokubiVoiceEffectStrength: { pitch: 2, formant: 1.25, squash: 0 },
	nosVoiceJammingEffectStrength: { pitch: 0.7, formant: 1, squash: 0 },
	nosMegaphoneEffectStrength: { pitch: 0.85, formant: 0.75, squash: 0.65 },
};

function echoPreview(context: AudioContext, kind: VoiceEffectPreviewKind): VoiceEffectPreview {
	const input = context.createGain();
	const output = context.createGain();
	const dry = context.createGain();
	const wet = context.createGain();
	const delay = context.createDelay(0.5);
	const feedback = context.createGain();
	const rainbow = kind === 'nosRainbowStarEchoStrength';
	delay.delayTime.value = rainbow ? 0.075 : 0.3;
	feedback.gain.value = rainbow ? 0.08 : 0.56;
	input.connect(dry);
	dry.connect(output);
	input.connect(delay);
	delay.connect(wet);
	wet.connect(output);
	delay.connect(feedback);
	feedback.connect(delay);
	return {
		input,
		output,
		update: (strength) => {
			const amount = Math.min(1, Math.max(0, strength / 100));
			dry.gain.value = rainbow ? 1 - 0.06 * amount : 1;
			wet.gain.value = rainbow ? 0.08 * amount : 0.65 * amount;
		},
		dispose: () => [input, output, dry, wet, delay, feedback].forEach((node) => node.disconnect()),
	};
}

export async function createVoiceEffectPreview(
	context: AudioContext,
	kind: VoiceEffectPreviewKind,
	strength: number
): Promise<VoiceEffectPreview> {
	let preview: VoiceEffectPreview;
	const filter = filterSamples[kind];
	if (filter) {
		await prepareSourceFilter(context);
		const effect = createSourceFilterEffect(context);
		preview = {
			input: effect.input,
			output: effect.output,
			update: (value) => {
				const amount = Math.min(1, Math.max(0, value / 100));
				updateSourceFilterEffect(effect, {
					pitch: 1 + (filter.pitch - 1) * amount,
					formant: 1 + (filter.formant - 1) * amount,
					squash: filter.squash * amount,
				});
			},
			dispose: () => disconnectProcessingEffect(effect),
		};
	} else if (kind === 'nosBerserkerVoiceEffectStrength') {
		const effect = createBerserkerEffect(context);
		preview = {
			input: effect.input,
			output: effect.output,
			update: (value) => updateBerserkerEffect(effect, value),
			dispose: () => disconnectBerserkerEffect(effect),
		};
	} else if (kind === 'nosRainbowStarEchoStrength' || kind === 'nosBibiriEchoStrength') {
		preview = echoPreview(context, kind);
	} else {
		const effect = createVoiceDisguiseEffect(context, null, strength);
		preview = {
			input: effect.input,
			output: effect.output,
			update: (value) => updateVoiceDisguiseEffect(effect, value),
			dispose: () => disconnectVoiceDisguiseEffect(effect),
		};
	}
	preview.update(strength);
	return preview;
}
