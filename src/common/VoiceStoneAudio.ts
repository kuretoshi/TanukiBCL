/** Bounded, in-memory 16 kHz mono recording. Never writes microphone audio to disk. */
export class StonePcm {
	private pcm = new Int16Array(160000);
	private count = 0;
	private phase = 0;
	private sum = 0;
	private frames = 0;
	private energy = 0;
	append(samples: Float32Array, sampleRate: number): void {
		if (!Number.isFinite(sampleRate) || sampleRate < 16000) return;
		for (const sample of samples) {
			if (this.count === this.pcm.length) break;
			this.sum += Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
			this.frames++;
			this.phase += 16000;
			if (this.phase < sampleRate) continue;
			const value = this.sum / this.frames;
			this.pcm[this.count++] = Math.round(value * 32767);
			this.energy += value * value;
			this.phase -= sampleRate;
			this.sum = 0;
			this.frames = 0;
		}
	}
	wav(): Uint8Array | undefined {
		if (this.count < 1600 || this.energy / this.count < 0.000001) return;
		const buffer = new ArrayBuffer(44 + this.count * 2),
			view = new DataView(buffer);
		const tag = (offset: number, text: string) =>
			[...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
		tag(0, 'RIFF');
		view.setUint32(4, 36 + this.count * 2, true);
		tag(8, 'WAVE');
		tag(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 16000, true);
		view.setUint32(28, 32000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		tag(36, 'data');
		view.setUint32(40, this.count * 2, true);
		for (let i = 0; i < this.count; i++) view.setInt16(44 + i * 2, this.pcm[i], true);
		return new Uint8Array(buffer);
	}
}

export function stoneAudioWindow(
	samples: Float32Array,
	rate: number,
	at: number,
	started: number,
	until: number
): Float32Array {
	const start = Math.max(0, Math.ceil(((started - at) * rate) / 1000));
	const end = Math.min(samples.length, Math.floor(((until - at) * rate) / 1000));
	return end > start ? samples.subarray(start, end) : samples.subarray(0, 0);
}
