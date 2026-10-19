import { validInterview, type InterviewState } from '../../common/InterviewState';

interface Slot {
	entry: InterviewState;
	data: Float32Array;
	start: number;
	end: number;
	handled: number;
	playback?: AudioBufferSourceNode;
}
interface Input {
	source: AudioNode;
	processor: ScriptProcessorNode;
	silent: GainNode;
	id: number;
	allowed: () => boolean;
}

// One mixed, time-aligned recording per interviewer, including the local mic.
// Only the owner's current visibility mask can admit a voice into the recording.
export function createInterviewerRecording(context: AudioContext, destination: AudioNode) {
	const slots = new Map<number, Slot>();
	const inputs = new Map<string, Input>();
	const output = context.createGain();
	output.gain.value = 0;
	output.connect(destination);
	function stop(slot: Slot) {
		if (!slot.playback) return;
		slot.playback.onended = null;
		try {
			slot.playback.stop();
		} catch {
			/* already finished */
		}
		slot.playback.disconnect();
		slot.playback = undefined;
	}
	function remove(key: string) {
		const input = inputs.get(key);
		if (!input) return;
		input.processor.onaudioprocess = null;
		try {
			input.source.disconnect(input.processor);
		} catch {
			/* source already removed */
		}
		input.processor.disconnect();
		input.silent.disconnect();
		inputs.delete(key);
	}
	function record(input: Input, event: AudioProcessingEvent) {
		if (!input.allowed()) return;
		const data = event.inputBuffer.getChannelData(0);
		const at = context.currentTime - data.length / context.sampleRate;
		for (const slot of slots.values()) capture(slot, input.id, data, at);
	}
	function capture(slot: Slot, id: number, data: Float32Array, at: number) {
		if (!slot.entry.visible.includes(id) || at >= slot.end) return;
		const offset = Math.round((at - slot.start) * context.sampleRate);
		const limit = Math.min(slot.data.length, Math.floor((slot.end - slot.start) * context.sampleRate));
		const first = Math.max(0, -offset),
			last = Math.min(data.length, limit - offset);
		for (let i = first; i < last; i++) slot.data[offset + i] += data[i];
	}
	function play(slot: Slot, now: number) {
		const entry = slot.entry;
		if (!entry.playStarted || entry.playStarted === slot.handled) return;
		slot.handled = entry.playStarted;
		stop(slot);
		const duration = (entry.stopped - entry.started) / 1000;
		const offset = Math.max(0, (now - entry.playStarted) / 1000);
		if (offset >= duration || duration <= 0) return;
		const count = Math.min(slot.data.length, Math.floor(duration * context.sampleRate));
		const buffer = context.createBuffer(1, Math.max(1, count), context.sampleRate);
		const data = buffer.getChannelData(0);
		let peak = 1;
		for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(slot.data[i]));
		for (let i = 0; i < count; i++) data[i] = slot.data[i] / peak;
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(output);
		source.onended = () => {
			source.disconnect();
			if (slot.playback === source) slot.playback = undefined;
		};
		slot.playback = source;
		source.start(0, offset);
	}
	function updateEntry(entry: InterviewState, meeting: boolean, now: number) {
		let slot = slots.get(entry.playerId);
		if (!slot || slot.entry.started !== entry.started) {
			if (slot) stop(slot);
			const start = context.currentTime - (now - entry.started) / 1000;
			slot = {
				entry,
				data: new Float32Array(Math.ceil(entry.seconds * context.sampleRate)),
				start,
				end: start + entry.seconds,
				handled: entry.playStarted,
			};
			slots.set(entry.playerId, slot);
		}
		slot.entry = entry;
		slot.end = slot.start + (entry.stopped ? (entry.stopped - entry.started) / 1000 : entry.seconds);
		if (meeting) play(slot, now);
		else {
			stop(slot);
			slot.handled = entry.playStarted;
		}
	}
	return {
		setInput(key: string, source: AudioNode, id: number, allowed: () => boolean) {
			const old = inputs.get(key);
			if (old?.source === source) {
				old.id = id;
				old.allowed = allowed;
				return;
			}
			remove(key);
			const processor = context.createScriptProcessor(2048, 1, 1);
			const silent = context.createGain();
			silent.gain.value = 0;
			const input = { source, processor, silent, id, allowed };
			processor.onaudioprocess = (event) => record(input, event);
			source.connect(processor);
			processor.connect(silent);
			silent.connect(destination);
			inputs.set(key, input);
		},
		removeInput: remove,
		update(entries: readonly InterviewState[], active: boolean, meeting: boolean, volume: number, now = Date.now()) {
			output.gain.value = Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 0;
			const valid =
				active && Number.isFinite(now) && Array.isArray(entries)
					? entries.filter((entry) => validInterview(entry, now)).slice(0, 32)
					: [];
			const retained = new Set(valid.map((entry) => entry.playerId));
			for (const [id, slot] of slots) {
				if (retained.has(id)) continue;
				stop(slot);
				slots.delete(id);
			}
			for (const entry of valid) updateEntry(entry, meeting, now);
			if (output.gain.value === 0) for (const slot of slots.values()) stop(slot);
		},
		clear() {
			for (const slot of slots.values()) stop(slot);
			slots.clear();
		},
		silence() {
			output.gain.value = 0;
			for (const slot of slots.values()) stop(slot);
		},
		disconnect() {
			for (const slot of slots.values()) stop(slot);
			slots.clear();
			for (const key of Array.from(inputs.keys())) remove(key);
			output.disconnect();
		},
	};
}
