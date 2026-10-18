import type { DyingVoiceState } from '../../common/DyingVoiceState';

export function inDyingVoiceRange(
	entry: DyingVoiceState | undefined,
	listener: { isDead: boolean; disconnected: boolean; x: number; y: number },
	duringTasks: boolean
): boolean {
	return (
		!!entry &&
		duringTasks &&
		!listener.isDead &&
		!listener.disconnected &&
		Math.hypot(listener.x - entry.x, listener.y - entry.y) <= entry.range
	);
}

// Buffer the source before proximity attenuation. Playback alone bypasses the
// normal ghost/living attenuation, and only for the authenticated role state.
export function createDyingVoiceRecording(context: AudioContext, source: AudioNode, destination: AudioNode) {
	const processor = context.createScriptProcessor(2048, 1, 1);
	const silent = context.createGain();
	silent.gain.value = 0;
	source.connect(processor);
	processor.connect(silent);
	silent.connect(destination);
	const output = context.createGain();
	output.gain.value = 0;
	output.connect(destination);
	let entry: DyingVoiceState | undefined;
	let chunks: Float32Array[] = [],
		samples = 0,
		recording = false,
		inside = false;
	let complete = false;
	let recordUntil = 0;
	let playback: AudioBufferSourceNode | undefined;
	let filters: BiquadFilterNode[] = [];
	function stop() {
		if (playback) playback.onended = null;
		try {
			playback?.stop();
		} catch {
			/* already ended */
		}
		playback?.disconnect();
		playback = undefined;
		for (const filter of filters) filter.disconnect();
		filters = [];
	}
	function cancel() {
		stop();
		entry = undefined;
		chunks = [];
		samples = 0;
		recording = false;
		inside = false;
		complete = false;
	}
	processor.onaudioprocess = (event) => {
		if (!recording || !entry) return;
		const remaining = Math.min(
			Math.floor(context.sampleRate * entry.seconds) - samples,
			Math.max(0, Math.floor((recordUntil - context.currentTime) * context.sampleRate))
		);
		if (remaining <= 0) return;
		const input = event.inputBuffer.getChannelData(0);
		const chunk = new Float32Array(input.subarray(0, remaining));
		chunks.push(chunk);
		samples += chunk.length;
	};
	function play() {
		if (!samples || playback) return;
		const buffer = context.createBuffer(1, samples, context.sampleRate);
		const data = buffer.getChannelData(0);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}
		playback = context.createBufferSource();
		playback.buffer = buffer;
		playback.loop = entry?.loop === true;
		const high = context.createBiquadFilter();
		high.type = 'highpass';
		high.frequency.value = 400;
		const low = context.createBiquadFilter();
		low.type = 'lowpass';
		low.frequency.value = 3000;
		playback.connect(high);
		high.connect(low);
		low.connect(output);
		filters = [high, low];
		playback.onended = () => {
			playback?.disconnect();
			playback = undefined;
			for (const filter of filters) filter.disconnect();
			filters = [];
		};
		playback.start();
	}
	return {
		update(next: DyingVoiceState | undefined, enabled: boolean, near: boolean, now = Date.now()) {
			if (!enabled || !next) {
				cancel();
				return;
			}
			if (entry?.started !== next.started || entry.playerId !== next.playerId) {
				cancel();
				entry = next;
				// A late listener must not save subsequent ghost conversation.
				complete = now >= next.started + next.seconds * 1000;
				recordUntil = context.currentTime + Math.max(0, (next.started + next.seconds * 1000 - now) / 1000);
			}
			if (!complete && now < next.started + next.seconds * 1000) recording = true;
			else {
				recording = false;
				complete = true;
			}
			if (!near) {
				inside = false;
				stop();
				return;
			}
			if (complete && !inside) {
				inside = true;
				play();
			}
		},
		setVolume(volume: number) {
			output.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 0;
			if (output.gain.value === 0) stop();
		},
		cancel,
		disconnect() {
			cancel();
			processor.onaudioprocess = null;
			try {
				source.disconnect(processor);
			} catch {
				/* already disconnected */
			}
			processor.disconnect();
			silent.disconnect();
			output.disconnect();
		},
	};
}
