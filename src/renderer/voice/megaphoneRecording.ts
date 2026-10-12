import type { MegaphoneState } from '../../common/MegaphoneState';

// Each listener buffers the incoming WebRTC audio before proximity attenuation.
// Nothing is written to disk or sent to a new service.
export function createMegaphoneRecording(
	context: AudioContext,
	source: AudioNode,
	destination: AudioNode,
	canRecord = () => true
) {
	const processor = context.createScriptProcessor(2048, 1, 1);
	const silent = context.createGain();
	silent.gain.value = 0;
	source.connect(processor);
	processor.connect(silent);
	silent.connect(destination);
	const output = context.createGain();
	output.connect(destination);
	let recording = false;
	let shot = 0;
	let fired = 0;
	let samples = 0;
	let chunks: Float32Array[] = [];
	let playback: AudioBufferSourceNode | undefined;
	let graph: AudioNode[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const maxSamples = context.sampleRate * 10;
	processor.onaudioprocess = (event) => {
		if (!recording || samples >= maxSamples) return;
		const input = event.inputBuffer.getChannelData(0);
		const chunk = new Float32Array(Math.min(input.length, maxSamples - samples));
		if (canRecord()) chunk.set(input.subarray(0, chunk.length));
		chunks.push(chunk);
		samples += chunk.length;
	};
	function stopPlayback() {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try {
			playback?.stop();
		} catch {
			/* already ended */
		}
		playback?.disconnect();
		playback = undefined;
		for (const node of graph) node.disconnect();
		graph = [];
	}
	function cancel() {
		recording = false;
		chunks = [];
		samples = 0;
		stopPlayback();
	}
	function update(entry: MegaphoneState | undefined, active: boolean, volume = 1) {
		output.gain.value = Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 0));
		if (!active) {
			cancel();
			return;
		}
		if (!entry?.phase || !entry.shotId) {
			recording = false;
			chunks = [];
			samples = 0;
			return; // A completed shot can finish playing after the beam disappears.
		}
		if (entry.shotId !== shot) {
			cancel();
			shot = entry.shotId;
		}
		if (entry.phase === 'charging') {
			recording = fired !== shot;
			return;
		}
		if (fired === shot) return;
		fired = shot;
		recording = false;
		if (!samples) return; // Joining after firing must not replay an old charge.
		const buffer = context.createBuffer(1, samples, context.sampleRate);
		const data = buffer.getChannelData(0);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}
		chunks = [];
		samples = 0;
		playback = context.createBufferSource();
		playback.buffer = buffer;
		const dry = context.createGain();
		dry.gain.value = 0.7;
		playback.connect(dry);
		dry.connect(output);
		graph = [dry];
		const tail = entry.voiceEffect === false ? 0 : 2.4;
		if (tail) {
			const delay = context.createDelay(0.5);
			delay.delayTime.value = 0.24;
			const feedback = context.createGain();
			feedback.gain.value = 0.48;
			const wet = context.createGain();
			wet.gain.value = 0.3;
			const filter = context.createBiquadFilter();
			filter.type = 'lowpass';
			filter.frequency.value = 3500;
			playback.connect(delay);
			delay.connect(filter);
			filter.connect(feedback);
			feedback.connect(delay);
			filter.connect(wet);
			wet.connect(output);
			wet.gain.setValueAtTime(0.3, context.currentTime + buffer.duration);
			wet.gain.exponentialRampToValueAtTime(0.001, context.currentTime + buffer.duration + tail);
			graph.push(delay, feedback, wet, filter);
		}
		playback.start();
		timer = setTimeout(stopPlayback, (buffer.duration + tail + 0.1) * 1000);
	}
	return {
		update,
		cancel,
		setVolume(volume: number) {
			output.gain.value = Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 0));
		},
		disconnect() {
			cancel();
			processor.onaudioprocess = null;
			try {
				source.disconnect(processor);
			} catch {
				/* source already disconnected */
			}
			processor.disconnect();
			silent.disconnect();
			output.disconnect();
		},
	};
}
