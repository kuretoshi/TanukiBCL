/** Small per-peer sample/hold quantizer; no recorded audio or network round-trip. */
export class BitVoiceKernel {
	private readonly rates = [4000, 6000, 8000, 16000, 32000, 44100];
	private readonly levels = [7, 31, 127, 2047, 32767, 8388607];
	private readonly logScale = Math.log(256);
	private phase = 0;
	private held = 0;
	private previous = -1;
	process(input: Float32Array, output: Float32Array, rate: number, stage: number): void {
		const valid = Number.isInteger(stage) && stage >= 0 && stage < this.rates.length;
		if (stage !== this.previous) {
			this.phase = 0;
			this.held = 0;
			this.previous = stage;
		}
		const target = valid ? this.rates[stage] : rate;
		const levels = valid ? this.levels[stage] : 1;
		for (let i = 0; i < output.length; i++) {
			const sample = Number.isFinite(input[i]) ? Math.max(-1, Math.min(1, input[i])) : 0;
			if (!valid) {
				output[i] = sample;
				continue;
			}
			if (this.phase <= 0) {
				// Companding keeps quiet voices intelligible at the coarsest stages.
				const compressed = (Math.sign(sample) * Math.log1p(255 * Math.abs(sample))) / this.logScale;
				const quantized = Math.round(compressed * levels) / levels;
				this.held = (Math.sign(quantized) * Math.expm1(Math.abs(quantized) * this.logScale)) / 255;
				this.phase += rate / Math.min(rate, target);
			}
			output[i] = this.held;
			this.phase--;
		}
	}
}

const registrations = new WeakMap<BaseAudioContext, Promise<void>>();
function prepare(context: BaseAudioContext): Promise<void> {
	let ready = registrations.get(context);
	if (ready) return ready;
	const code = `const Kernel=${BitVoiceKernel.toString()};
class BitVoiceProcessor extends AudioWorkletProcessor {
 constructor(){super();this.kernel=new Kernel();this.stage=-1;this.stopped=false;
 this.port.onmessage=e=>{if(e.data==='stop')this.stopped=true;else this.stage=e.data;};}
 process(inputs,outputs){if(this.stopped)return false;const out=outputs[0]?.[0];if(!out)return true;
 const input=inputs[0]?.[0];if(input)this.kernel.process(input,out,sampleRate,this.stage);else out.fill(0);return true;}
} registerProcessor('tanuki-bit-voice',BitVoiceProcessor);`;
	ready = (async () => {
		const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
		try {
			await context.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
	})();
	registrations.set(context, ready);
	return ready;
}
export function createBitVoiceEffect(context: BaseAudioContext) {
	const input = context.createGain(),
		output = context.createGain();
	input.connect(output);
	let node: AudioWorkletNode | undefined,
		stage = -1,
		disposed = false;
	void prepare(context)
		.then(() => {
			if (disposed || context.state === 'closed') return;
			node = new AudioWorkletNode(context, 'tanuki-bit-voice', {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [1],
				channelCount: 1,
				channelCountMode: 'explicit',
			});
			node.port.postMessage(stage);
			input.disconnect(output);
			input.connect(node);
			node.connect(output);
		})
		.catch((error) => console.warn('Bit voice effect unavailable', error));
	return {
		input,
		output,
		update(next: number) {
			if (stage === next) return;
			stage = next;
			node?.port.postMessage(next);
		},
		disconnect() {
			disposed = true;
			node?.port.postMessage('stop');
			node?.port.close();
			node?.disconnect();
			input.disconnect();
			output.disconnect();
		},
	};
}

interface BitVoicePeer {
	source: AudioNode;
	pan: AudioNode;
	bitVoice?: ReturnType<typeof createBitVoiceEffect>;
	rokuroVoice?: { disconnect(): void };
	rokuroDestinationChanged?: boolean;
}
/** Recorders keep the raw source; both live head/body playback paths use this output. */
export function syncBitVoice(peer: BitVoicePeer, stage: number): AudioNode {
	const active = stage >= 0 && stage < 6;
	const changed = active !== !!peer.bitVoice;
	if (active && !peer.bitVoice) {
		peer.source.disconnect(peer.pan);
		peer.bitVoice = createBitVoiceEffect(peer.source.context);
		peer.source.connect(peer.bitVoice.input);
		peer.bitVoice.output.connect(peer.pan);
	} else if (!active && peer.bitVoice) {
		peer.source.disconnect(peer.bitVoice.input);
		peer.bitVoice.disconnect();
		peer.bitVoice = undefined;
		peer.source.connect(peer.pan);
	}
	if (changed) {
		peer.rokuroVoice?.disconnect();
		peer.rokuroVoice = undefined;
		peer.rokuroDestinationChanged = true;
	}
	peer.bitVoice?.update(stage);
	return peer.bitVoice?.output ?? peer.source;
}
