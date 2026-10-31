import { disconnectBerserkerEffect, type BerserkerEffect } from './berserkerEffect';
import { registerSourceFilterProcessor } from './sourceFilterProcessor';
import { disconnectVoiceDisguiseEffect, type VoiceDisguiseEffect } from '../voiceEffect';
import type { TunedVoiceEffect } from './tunedVoiceEffect';

export interface SourceFilterParameters {
	pitch: number;
	formant: number;
	squash: number;
}

export interface SourceFilterEffect {
	kind: 'source-filter';
	input: GainNode;
	output: GainNode;
	node: AudioWorkletNode;
	dry: GainNode;
	wet: GainNode;
}

const registrations = new WeakMap<BaseAudioContext, Promise<void>>();
export function prepareSourceFilter(context: BaseAudioContext): Promise<void> {
	let ready = registrations.get(context);
	if (!ready) {
		ready = (async () => {
			const url = URL.createObjectURL(
				new Blob([`(${registerSourceFilterProcessor.toString()})();`], { type: 'text/javascript' })
			);
			try {
				await context.audioWorklet.addModule(url);
			} finally {
				URL.revokeObjectURL(url);
			}
		})();
		registrations.set(context, ready);
	}
	return ready;
}

export function createSourceFilterEffect(context: AudioContext): SourceFilterEffect {
	const input = context.createGain(),
		output = context.createGain(),
		dry = context.createGain(),
		wet = context.createGain();
	const node = new AudioWorkletNode(context, 'nos-source-filter', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [1],
		channelCount: 1,
		channelCountMode: 'explicit',
	});
	input.connect(node);
	input.connect(dry);
	dry.connect(output);
	node.connect(wet);
	wet.connect(output);
	// The STFT has a 2048-sample startup window. Keep speech on the dry path
	// until that window is full, then crossfade instead of replacing it with silence.
	const ready = context.currentTime + 2048 / context.sampleRate;
	dry.gain.setValueAtTime(1, ready);
	dry.gain.linearRampToValueAtTime(0, ready + 0.01);
	wet.gain.setValueAtTime(0, context.currentTime);
	wet.gain.setValueAtTime(0, ready);
	wet.gain.linearRampToValueAtTime(1, ready + 0.01);
	return { kind: 'source-filter', input, output, node, dry, wet };
}

export function updateSourceFilterEffect(effect: SourceFilterEffect, parameters: SourceFilterParameters) {
	for (const [name, value] of Object.entries(parameters)) {
		const param = effect.node.parameters.get(name);
		if (param) param.value = value;
	}
}

export type VoiceProcessingEffect = SourceFilterEffect | VoiceDisguiseEffect | BerserkerEffect | TunedVoiceEffect;

export function disconnectProcessingEffect(effect: VoiceProcessingEffect) {
	if ('kind' in effect && effect.kind === 'tuned') {
		effect.disconnect();
	} else if ('kind' in effect && effect.kind === 'berserker') {
		disconnectBerserkerEffect(effect);
	} else if ('kind' in effect) {
		effect.node.port.postMessage('stop');
		effect.node.port.close();
		effect.input.disconnect();
		effect.node.disconnect();
		effect.dry.disconnect();
		effect.wet.disconnect();
		effect.output.disconnect();
	} else disconnectVoiceDisguiseEffect(effect);
}
