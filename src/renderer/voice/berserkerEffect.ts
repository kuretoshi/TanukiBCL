/** Close, gritty overload and a short room tail, distinct from the ghost convolver. */
export interface BerserkerEffect {
	kind: 'berserker';
	input: GainNode;
	output: GainNode;
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
		wet = context.createGain();
	dry.gain.value = 0.8;
	grit.gain.value = 0.12;
	wet.gain.value = 0.06;
	const preDelay = context.createDelay(0.1);
	preDelay.delayTime.value = 0.012;
	const room = context.createConvolver();
	const impulse = context.createBuffer(1, Math.floor(context.sampleRate * 0.22), context.sampleRate);
	const data = impulse.getChannelData(0);
	let seed = 12345;
	for (let i = 0; i < data.length; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		data[i] = ((seed / 0xffffffff) * 2 - 1) * Math.pow(1 - i / data.length, 3);
	}
	room.buffer = impulse;
	const mix = context.createGain(),
		compressor = context.createDynamicsCompressor();
	compressor.threshold.value = -14;
	compressor.knee.value = 12;
	compressor.ratio.value = 3;
	compressor.attack.value = 0.005;
	compressor.release.value = 0.08;
	output.gain.value = 0.78;
	input.connect(highpass);
	highpass.connect(dry);
	dry.connect(mix);
	highpass.connect(shape);
	shape.connect(lowpass);
	lowpass.connect(grit);
	grit.connect(mix);
	lowpass.connect(preDelay);
	preDelay.connect(room);
	room.connect(wet);
	wet.connect(mix);
	mix.connect(compressor);
	compressor.connect(output);
	return {
		kind: 'berserker',
		input,
		output,
		nodes: [highpass, shape, lowpass, dry, grit, wet, preDelay, room, mix, compressor],
	};
}

export function disconnectBerserkerEffect(effect: BerserkerEffect) {
	effect.input.disconnect();
	effect.output.disconnect();
	for (const node of effect.nodes) node.disconnect();
}
