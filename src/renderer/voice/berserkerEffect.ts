import { setEffectGain } from './effectGain';

/** The Berserker's gritty voice profile. Pitch and tails use the shared tuning graph. */
export interface BerserkerEffect {
	kind: 'berserker';
	input: GainNode;
	output: GainNode;
	bypass: GainNode;
	processed: GainNode;
	nodes: AudioNode[];
}
export function createBerserkerEffect(context: AudioContext): BerserkerEffect {
	const input = context.createGain(),
		output = context.createGain();
	const highpass = context.createBiquadFilter();
	highpass.type = 'highpass';
	highpass.frequency.value = 80;
	highpass.Q.value = Math.SQRT1_2;
	const shape = context.createWaveShaper();
	const curve = new Float32Array(4096);
	for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(5 * ((2 * i) / (curve.length - 1) - 1)) / Math.tanh(5);
	shape.curve = curve;
	shape.oversample = '4x';
	const lowpass = context.createBiquadFilter();
	lowpass.type = 'lowpass';
	lowpass.frequency.value = 4200;
	lowpass.Q.value = Math.SQRT1_2;
	const dry = context.createGain(),
		grit = context.createGain(),
		mix = context.createGain(),
		compressor = context.createDynamicsCompressor();
	dry.gain.value = 0.8;
	grit.gain.value = 0.12;
	compressor.threshold.value = -14;
	compressor.knee.value = 12;
	compressor.ratio.value = 3;
	compressor.attack.value = 0.005;
	compressor.release.value = 0.08;
	const bypass = context.createGain(),
		processed = context.createGain();
	input.connect(bypass);
	bypass.connect(output);
	input.connect(highpass);
	highpass.connect(dry);
	dry.connect(mix);
	highpass.connect(shape);
	shape.connect(lowpass);
	lowpass.connect(grit);
	grit.connect(mix);
	mix.connect(compressor);
	compressor.connect(processed);
	processed.connect(output);
	bypass.gain.value = 0;
	processed.gain.value = 0.78;
	return {
		kind: 'berserker',
		input,
		output,
		bypass,
		processed,
		nodes: [highpass, shape, lowpass, dry, grit, mix, compressor, bypass, processed],
	};
}
export function updateBerserkerEffect(effect: Pick<BerserkerEffect, 'bypass' | 'processed'>, strength: number): void {
	const amount = Math.min(1, Math.max(0, strength / 100));
	setEffectGain(effect.bypass, 1 - amount);
	setEffectGain(effect.processed, 0.78 * amount);
}
export function disconnectBerserkerEffect(effect: BerserkerEffect): void {
	effect.input.disconnect();
	effect.output.disconnect();
	for (const node of effect.nodes) node.disconnect();
}
