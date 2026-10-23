/** Keep speech audible when reducing the amount of convolution reverb. */
export function reverbLevels(strength = 100): { dry: number; wet: number } {
	const wet = Number.isFinite(strength) ? Math.max(0, Math.min(100, strength)) / 100 : 1;
	return { dry: 1 - wet, wet };
}

export function createReverbMix(context: AudioContext) {
	return { dry: context.createGain(), wet: context.createGain(), output: context.createGain() };
}

export function connectReverbMix(input: AudioNode, reverb: ConvolverNode, mix: ReturnType<typeof createReverbMix>) {
	input.connect(reverb);
	input.connect(mix.dry);
	reverb.connect(mix.wet);
	mix.dry.connect(mix.output);
	mix.wet.connect(mix.output);
	return mix.output;
}
