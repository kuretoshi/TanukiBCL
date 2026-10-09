// Self-contained so the same DSP runs in AudioWorklet and offline tests.
// STFT source/filter separation: cepstral envelope -> whitened excitation ->
// independently transposed excitation and warped envelope -> overlap-add.
export function registerSourceFilterProcessor() {
	const scope = globalThis as unknown as {
		sampleRate: number;
		AudioWorkletProcessor: new () => { port: MessagePort };
		registerProcessor: (name: string, processor: unknown) => void;
	};
	class SourceFilterProcessor extends scope.AudioWorkletProcessor {
		static get parameterDescriptors() {
			return [
				{ name: 'pitch', defaultValue: 1, minValue: 0.4, maxValue: 2, automationRate: 'k-rate' },
				{ name: 'formant', defaultValue: 1, minValue: 0.55, maxValue: 1.7, automationRate: 'k-rate' },
				{ name: 'squash', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
			];
		}
		n = 2048;
		hop = 512;
		input = new Float64Array(this.n);
		output = new Float64Array(this.n);
		window = new Float64Array(this.n);
		re = new Float64Array(this.n);
		im = new Float64Array(this.n);
		cepRe = new Float64Array(this.n);
		cepIm = new Float64Array(this.n);
		magnitude = new Float64Array(this.n / 2 + 1);
		logMagnitude = new Float64Array(this.n / 2 + 1);
		envelope = new Float64Array(this.n / 2 + 1);
		lastPhase = new Float64Array(this.n / 2 + 1);
		phase = new Float64Array(this.n / 2 + 1);
		weights = new Float64Array(this.n / 2 + 1);
		frequencies = new Float64Array(this.n / 2 + 1);
		excitation = new Float64Array(this.n / 2 + 1);
		cursor = 0;
		frames = 0;
		pitch = 1;
		formant = 1;
		squash = 0;
		stopped = false;
		constructor() {
			super();
			for (let i = 0; i < this.n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n);
			this.port.onmessage = (event) => {
				if (event.data === 'stop') this.stopped = true;
			};
		}
		fft(re: Float64Array, im: Float64Array, inverse = false) {
			const n = re.length;
			for (let i = 1, j = 0; i < n; i++) {
				let bit = n >> 1;
				for (; j & bit; bit >>= 1) j ^= bit;
				j ^= bit;
				if (i < j) {
					[re[i], re[j]] = [re[j], re[i]];
					[im[i], im[j]] = [im[j], im[i]];
				}
			}
			for (let size = 2; size <= n; size *= 2) {
				const angle = ((inverse ? 2 : -2) * Math.PI) / size;
				const stepRe = Math.cos(angle),
					stepIm = Math.sin(angle);
				for (let start = 0; start < n; start += size) {
					let wr = 1,
						wi = 0;
					for (let j = 0; j < size / 2; j++) {
						const a = start + j,
							b = a + size / 2;
						const br = re[b] * wr - im[b] * wi,
							bi = re[b] * wi + im[b] * wr;
						re[b] = re[a] - br;
						im[b] = im[a] - bi;
						re[a] += br;
						im[a] += bi;
						const next = wr * stepRe - wi * stepIm;
						wi = wr * stepIm + wi * stepRe;
						wr = next;
					}
				}
			}
			if (inverse)
				for (let i = 0; i < n; i++) {
					re[i] /= n;
					im[i] /= n;
				}
		}
		interpolate(data: Float64Array, position: number) {
			if (position < 0 || position >= data.length - 1)
				return data[Math.min(data.length - 1, Math.max(0, Math.floor(position)))];
			const lo = Math.floor(position),
				fraction = position - lo;
			return data[lo] * (1 - fraction) + data[lo + 1] * fraction;
		}
		raiseCepstralEnvelope(half: number) {
			for (let k = 0; k <= half; k++) {
				this.cepRe[k] = Math.max(this.logMagnitude[k], this.cepRe[k]);
				this.cepIm[k] = 0;
				if (k > 0 && k < half) {
					this.cepRe[this.n - k] = this.cepRe[k];
					this.cepIm[this.n - k] = 0;
				}
			}
		}
		frame() {
			const n = this.n,
				half = n / 2,
				step = (2 * Math.PI * this.hop) / n;
			for (let i = 0; i < n; i++) {
				this.re[i] = this.input[i] * this.window[i];
				this.im[i] = 0;
			}
			this.fft(this.re, this.im);
			for (let k = 0; k <= half; k++) {
				this.magnitude[k] = Math.hypot(this.re[k], this.im[k]);
				this.logMagnitude[k] = Math.log(Math.max(1e-6, this.magnitude[k]));
				this.cepRe[k] = this.logMagnitude[k];
				this.cepIm[k] = 0;
				if (k > 0 && k < half) {
					this.cepRe[n - k] = this.cepRe[k];
					this.cepIm[n - k] = 0;
				}
			}
			// Iterative cepstral upper envelope avoids treating gaps between harmonics
			// as vocal-tract notches (a limited-iteration true-envelope estimate).
			const limit = Math.min(half, Math.round(scope.sampleRate * 0.003));
			for (let iteration = 0; iteration < 4; iteration++) {
				if (iteration > 0) this.raiseCepstralEnvelope(half);
				this.fft(this.cepRe, this.cepIm, true);
				for (let i = 1; i < n; i++) {
					const distance = Math.min(i, n - i);
					const gain =
						distance <= limit * 0.75
							? 1
							: distance < limit
								? 0.5 + 0.5 * Math.cos((Math.PI * (distance / limit - 0.75)) / 0.25)
								: 0;
					this.cepRe[i] *= gain;
					this.cepIm[i] = 0;
				}
				this.fft(this.cepRe, this.cepIm);
			}
			for (let k = 0; k <= half; k++) this.envelope[k] = Math.exp(Math.max(-14, Math.min(14, this.cepRe[k])));
			this.weights.fill(0);
			this.frequencies.fill(0);
			this.excitation.fill(0);
			for (let k = 0; k <= half; k++) {
				const phase = Math.atan2(this.im[k], this.re[k]);
				let delta = phase - this.lastPhase[k] - k * step;
				delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
				this.lastPhase[k] = phase;
				if (Math.abs(this.pitch - 1) < 1e-4) continue;
				const target = Math.round(k * this.pitch);
				if (target > half) continue;
				// Excitation is the spectrum divided by its estimated filter envelope.
				const weight = this.magnitude[k];
				this.excitation[target] += weight / Math.max(1e-6, this.envelope[k]);
				this.weights[target] += weight;
				this.frequencies[target] += (k + delta / step) * this.pitch * weight;
			}
			let before = 0,
				after = 0;
			const cutoff = 12000 * Math.pow(900 / 12000, this.squash);
			for (let k = 0; k <= half; k++) {
				const originalPhase = this.lastPhase[k];
				const filter = this.interpolate(this.envelope, k / this.formant);
				let magnitude: number;
				if (Math.abs(this.pitch - 1) < 1e-4) {
					magnitude = this.magnitude[k] * Math.min(32, filter / Math.max(1e-6, this.envelope[k]));
					this.phase[k] = originalPhase;
				} else {
					const frequency = this.weights[k] > 1e-9 ? this.frequencies[k] / this.weights[k] : k;
					this.phase[k] += frequency * step;
					this.phase[k] %= 2 * Math.PI;
					magnitude = this.excitation[k] * filter;
					// Limit envelope correction around spectral nulls to avoid bursts.
					const reference = this.interpolate(this.magnitude, k / this.pitch);
					magnitude = Math.min(magnitude, reference * 32);
				}
				before += this.magnitude[k] ** 2;
				after += magnitude ** 2;
				const muffle = this.squash > 0 ? 1 / Math.sqrt(1 + Math.pow((k * scope.sampleRate) / n / cutoff, 4)) : 1;
				const amplitude = magnitude * muffle;
				this.re[k] = amplitude * Math.cos(this.phase[k]);
				this.im[k] = amplitude * Math.sin(this.phase[k]);
				if (k > 0 && k < half) {
					this.re[n - k] = this.re[k];
					this.im[n - k] = -this.im[k];
				}
			}
			this.im[0] = 0;
			this.im[half] = 0;
			// Prevent envelope warping from increasing overall power, without boosting silence.
			const gain = Math.min(1, Math.sqrt(before / Math.max(1e-12, after))) * (1 - 0.3 * this.squash);
			this.fft(this.re, this.im, true);
			for (let i = 0; i < n; i++)
				this.output[i] += (this.re[i] * this.window[i] * gain) / ((this.n / this.hop) * 0.375);
			this.input.copyWithin(0, this.hop);
			this.input.fill(0, n - this.hop);
			this.frames++;
		}
		process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
			if (this.stopped) return false;
			const source = inputs[0]?.[0],
				target = outputs[0]?.[0];
			if (!target) return true;
			for (let i = 0; i < target.length; i++) {
				const sample = source?.[i] ?? 0;
				this.input[this.n - this.hop + this.cursor] = Number.isFinite(sample) ? sample : 0;
				const out = this.output[this.cursor];
				target[i] = Number.isFinite(out) ? Math.max(-1, Math.min(1, out)) : 0;
				this.cursor++;
				if (this.cursor === this.hop) {
					this.output.copyWithin(0, this.hop);
					this.output.fill(0, this.n - this.hop);
					const smoothing = 1 - Math.exp(-this.hop / (scope.sampleRate * 0.04));
					if (this.frames === 0) {
						this.pitch = parameters.pitch[0];
						this.formant = parameters.formant[0];
						this.squash = parameters.squash[0];
					} else {
						this.pitch += smoothing * (parameters.pitch[0] - this.pitch);
						this.formant += smoothing * (parameters.formant[0] - this.formant);
						this.squash += smoothing * (parameters.squash[0] - this.squash);
					}
					this.frame();
					this.cursor = 0;
				}
			}
			return true;
		}
	}
	scope.registerProcessor('nos-source-filter', SourceFilterProcessor);
}
