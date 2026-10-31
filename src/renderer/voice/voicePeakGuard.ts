/** Leave ordinary speech unchanged and round only peaks approaching full scale. */
export function limitVoicePeak(sample: number): number {
	if (!Number.isFinite(sample)) return 0;
	const magnitude = Math.abs(sample);
	return magnitude <= 0.8 ? sample : Math.sign(sample) * (0.8 + 0.18 * Math.tanh((magnitude - 0.8) / 0.18));
}

let curve: Float32Array<ArrayBuffer> | undefined;

/** No buffering or compressor lookahead; the curve covers input levels from -4 to +4. */
export function createVoicePeakGuard(context: BaseAudioContext) {
	if (!curve) {
		curve = new Float32Array(65537);
		for (let index = 0; index < curve.length; index++)
			curve[index] = limitVoicePeak((index / (curve.length - 1)) * 8 - 4);
	}
	const input = context.createGain(),
		output = context.createWaveShaper();
	input.gain.value = 0.25;
	output.curve = curve;
	input.connect(output);
	return {
		input,
		output,
		disconnect() {
			input.disconnect();
			output.disconnect();
		},
	};
}
