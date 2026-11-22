import { StonePcm } from './VoiceStoneAudio';

/** Short overlapping utterances. The native worker performs the actual Silero VAD.
 * The energy gate here only avoids submitting silence and never decides a word. */
export class LiveSpeechAudio {
	private chunks: { at: number; samples: Float32Array; rate: number }[] = [];
	private started = 0;
	private voiced = 0;
	private submitted = 0;
	private dirty = false;
	append(samples: Float32Array, rate: number, at: number): void {
		if (!samples.length || rate < 16000 || !Number.isFinite(rate)) return;
		const end = at + (samples.length * 1000) / rate;
		if (this.chunks.length && at - this.chunks[this.chunks.length - 1].at > 500) this.reset();
		let energy = 0;
		for (const s of samples) if (Number.isFinite(s)) energy += s * s;
		this.chunks.push({ at, samples: samples.slice(), rate });
		this.chunks = this.chunks.filter((c) => c.at + (c.samples.length * 1000) / c.rate > end - 8000);
		if (energy / samples.length >= 0.000001) {
			if (!this.started) this.started = at;
			this.voiced = end;
			this.dirty = true;
		}
		if (!this.started) this.chunks = this.chunks.filter((c) => c.at > end - 300);
	}
	take(now: number): Uint8Array | undefined {
		if (
			!this.started ||
			!this.dirty ||
			now - this.started < 150 ||
			(now - this.voiced < 350 && now - Math.max(this.started, this.submitted) < 1200)
		)
			return;
		const pcm = new StonePcm();
		for (const c of this.chunks) pcm.append(c.samples, c.rate);
		this.submitted = now;
		this.dirty = false;
		const wav = pcm.wav();
		if (now - this.voiced >= 350) this.reset();
		return wav;
	}
	reset(): void {
		this.chunks = [];
		this.started = this.voiced = this.submitted = 0;
		this.dirty = false;
	}
}
