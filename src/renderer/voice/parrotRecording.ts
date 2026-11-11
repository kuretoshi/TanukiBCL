import { AmongUsState, GameState, Player } from '../../common/AmongUsState';
import { ParrotState, parrotNear, parrotSeconds, parrotsActive, validParrot } from '../../common/ParrotState';

const RATE = 16000,
	HISTORY = 4800,
	PRE = 0.15;
interface Clip {
	buffer: AudioBuffer;
	sourceId: number;
	start: number;
}
interface Slot {
	entry: ParrotState;
	clips: Map<number, Clip>;
	handled: number;
	requested: number;
	playback?: AudioBufferSourceNode;
	gain?: GainNode;
	pan?: StereoPannerNode;
	playingSource?: number;
	playbackStarted?: number;
	playbackOffset?: number;
}
interface Input {
	source: AudioNode;
	processor: ScriptProcessorNode;
	silent: GainNode;
	id: number;
	allowed: () => boolean;
	history: Float32Array;
	end: number;
}

// Capture only raw microphone/peer streams. Playback is never connected to these inputs.
export function createParrotRecording(
	context: AudioContext,
	destination: AudioNode,
	request?: (owner: number, bird: number, source: number) => void
) {
	const slots = new Map<string, Slot>(),
		inputs = new Map<string, Input>(),
		volumes = new Map<string, number>();
	const output = context.createGain();
	output.connect(destination);
	let state: AmongUsState | undefined,
		listener: Player | undefined,
		tasks = false,
		volume = 0;
	function stop(slot: Slot) {
		if (slot.playback) {
			slot.playback.onended = null;
			try {
				slot.playback.stop();
			} catch {
				/* already ended */
			}
			slot.playback.disconnect();
			slot.playback = undefined;
		}
		slot.gain?.disconnect();
		slot.pan?.disconnect();
		slot.gain = undefined;
		slot.pan = undefined;
	}
	function sourceVolume(id: number) {
		for (const [key, input] of inputs) if (input.id === id) return volumes.get(key) ?? 1;
		return 0;
	}
	function updateGain(slot: Slot) {
		if (!slot.gain || !state) return;
		const near = tasks && parrotNear(slot.entry, listener, state);
		const distance = listener ? Math.hypot(slot.entry.x - listener.x, slot.entry.y - listener.y) : Infinity;
		slot.gain.gain.value = near
			? volume * sourceVolume(slot.playingSource ?? -1) * Math.max(0, 1 - distance / slot.entry.range)
			: 0;
		if (slot.pan && listener)
			slot.pan.pan.value = Math.max(-1, Math.min(1, (slot.entry.x - listener.x) / slot.entry.range));
	}
	function write(clip: Clip, data: Float32Array, rate: number, at: number) {
		const target = clip.buffer.getChannelData(0);
		const first = Math.max(0, Math.ceil((at - clip.start) * RATE));
		const last = Math.min(target.length, Math.floor((at + data.length / rate - clip.start) * RATE));
		for (let i = first; i < last; i++)
			target[i] = data[Math.min(data.length - 1, Math.max(0, Math.floor((clip.start + i / RATE - at) * rate)))];
	}
	function seed(clip: Clip) {
		for (const input of inputs.values()) {
			if (input.id !== clip.sourceId || !input.allowed()) continue;
			const ordered = new Float32Array(HISTORY);
			for (let i = 0; i < HISTORY; i++) ordered[i] = input.history[(input.end + i) % HISTORY];
			write(clip, ordered, RATE, input.end / RATE - HISTORY / RATE);
		}
	}
	function detect(slot: Slot, input: Input, rms: number) {
		if (slot.entry.mode === 'clone') return;
		if (!request || !state?.isHost || !tasks || rms < 0.008 || context.currentTime < slot.requested) return;
		const player = state.players.find((p) => p.id === input.id);
		if (player?.isDead || !parrotNear(slot.entry, player, state)) return;
		if (
			slot.entry.recordId > 0 &&
			context.currentTime < (slot.clips.get(slot.entry.recordId)?.start ?? -Infinity) + parrotSeconds(slot.entry) + PRE
		)
			return;
		slot.requested = context.currentTime + parrotSeconds(slot.entry) + 0.2;
		request(slot.entry.ownerId, slot.entry.birdId, input.id);
	}
	function record(input: Input, event: AudioProcessingEvent) {
		if (!tasks || volume <= 0 || !input.allowed()) {
			input.history.fill(0);
			return;
		}
		const data = event.inputBuffer.getChannelData(0),
			rate = event.inputBuffer.sampleRate || context.sampleRate;
		const at = context.currentTime - data.length / rate;
		let energy = 0;
		for (const sample of data) energy += sample * sample;
		const begin = Math.ceil(at * RATE),
			end = Math.floor(context.currentTime * RATE);
		for (let i = begin; i < end; i++)
			input.history[((i % HISTORY) + HISTORY) % HISTORY] =
				data[Math.min(data.length - 1, Math.floor((i / RATE - at) * rate))];
		input.end = end;
		for (const slot of slots.values()) recordSlot(slot, input, data, rate, at, Math.sqrt(energy / data.length));
	}
	function recordSlot(slot: Slot, input: Input, data: Float32Array, rate: number, at: number, rms: number) {
		detect(slot, input, rms);
		const clip = slot.clips.get(slot.entry.recordId);
		if (clip?.sourceId !== input.id || !state) return;
		const player = state.players.find((p) => p.id === input.id);
		if (player && !player.isDead && (slot.entry.mode === 'clone' || parrotNear(slot.entry, player, state)))
			write(clip, data, rate, at);
	}
	function play(slot: Slot, now: number) {
		const looping = slot.entry.mode === 'clone';
		if (slot.handled === slot.entry.playId && (!looping || slot.playback || !tasks || volume <= 0)) return;
		slot.handled = slot.entry.playId;
		stop(slot);
		const clip = slot.clips.get(slot.entry.playClip),
			elapsed = Math.max(0, (now - slot.entry.playStarted) / 1000),
			offset = looping ? elapsed % parrotSeconds(slot.entry) : elapsed;
		if (
			!tasks ||
			volume <= 0 ||
			!clip ||
			!slot.entry.playId ||
			offset >= clip.buffer.length / RATE ||
			!state ||
			(!looping && !parrotNear(slot.entry, listener, state))
		)
			return;
		const source = context.createBufferSource(),
			gain = context.createGain(),
			pan = context.createStereoPanner();
		source.buffer = clip.buffer;
		source.loop = looping;
		source.connect(gain);
		gain.connect(pan);
		pan.connect(output);
		slot.playback = source;
		slot.gain = gain;
		slot.pan = pan;
		slot.playingSource = clip.sourceId;
		slot.playbackStarted = context.currentTime;
		slot.playbackOffset = offset;
		updateGain(slot);
		source.onended = () => stop(slot);
		source.start(0, offset);
	}
	function updateSlot(entry: ParrotState, now: number) {
		const key = `${entry.ownerId}|${entry.birdId}`;
		let slot = slots.get(key);
		if (!slot) {
			slot = { entry, clips: new Map(), handled: 0, requested: 0 };
			slots.set(key, slot);
		}
		slot.entry = entry;
		const keep = new Set(entry.clips);
		if (tasks && entry.recordId) keep.add(entry.recordId);
		for (const id of slot.clips.keys()) if (!keep.has(id)) slot.clips.delete(id);
		if (
			tasks &&
			entry.recordId &&
			!slot.clips.has(entry.recordId) &&
			now < entry.started + parrotSeconds(entry) * 1000
		) {
			const clip = {
				buffer: context.createBuffer(1, Math.ceil(parrotSeconds(entry) * RATE), RATE),
				sourceId: entry.sourceId,
				start: context.currentTime - (now - entry.started) / 1000 - (entry.mode === 'clone' ? 0 : PRE),
			};
			slot.clips.set(entry.recordId, clip);
			seed(clip);
		}
		if (!tasks) stop(slot);
		play(slot, now);
		updateGain(slot);
	}
	// Inspect the actual loop cursor, without copying PCM or sending network VAD.
	function cloneSpeaking(slot: Slot): boolean {
		if (
			!tasks ||
			slot.entry.mode !== 'clone' ||
			slot.entry.spoofTalking !== true ||
			!slot.playback ||
			!slot.playback.buffer ||
			!(slot.gain && slot.gain.gain.value > 0) ||
			(context.state && context.state !== 'running')
		)
			return false;
		const data = slot.playback.buffer.getChannelData(0);
		const elapsed = Math.max(0, context.currentTime - (slot.playbackStarted ?? context.currentTime));
		const end = Math.floor(((slot.playbackOffset ?? 0) + elapsed) * RATE);
		const count = Math.min(1920, Math.floor(elapsed * RATE), data.length);
		let energy = 0;
		for (let i = 0; i < count; i++) {
			const sample = data[(((end - 1 - i) % data.length) + data.length) % data.length];
			energy += sample * sample;
		}
		return count > 0 && energy / count >= 0.008 ** 2;
	}
	function remove(key: string) {
		const input = inputs.get(key);
		if (!input) return;
		input.processor.onaudioprocess = null;
		try {
			input.source.disconnect(input.processor);
		} catch {
			/* source removed */
		}
		input.processor.disconnect();
		input.silent.disconnect();
		inputs.delete(key);
		volumes.delete(key);
	}
	return {
		setInput(key: string, source: AudioNode, id: number, allowed: () => boolean) {
			const old = inputs.get(key);
			if (old?.source === source) {
				if (old.id !== id) old.history.fill(0);
				old.id = id;
				old.allowed = allowed;
				return;
			}
			remove(key);
			const processor = context.createScriptProcessor(2048, 1, 1),
				silent = context.createGain();
			silent.gain.value = 0;
			const input: Input = { source, processor, silent, id, allowed, history: new Float32Array(HISTORY), end: 0 };
			processor.onaudioprocess = (event) => record(input, event);
			source.connect(processor);
			processor.connect(silent);
			silent.connect(destination);
			inputs.set(key, input);
		},
		removeInput: remove,
		isCloneTalking(id: number): boolean {
			const slot = slots.get(`${id}|${1000000 + id}`);
			return !!slot && cloneSpeaking(slot);
		},
		setVolume(key: string, value: number) {
			volumes.set(key, Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0);
			for (const slot of slots.values()) updateGain(slot);
		},
		update(entries: readonly ParrotState[], next: AmongUsState, me: Player | undefined, gain: number, now: number) {
			state = next;
			listener = me;
			tasks = next.gameState === GameState.TASKS && parrotsActive(next);
			volume = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 0;
			const valid =
				parrotsActive(next) && Number.isFinite(now) && Array.isArray(entries) && entries.length <= 120
					? entries.filter((e) => validParrot(e, now))
					: [];
			const keys = new Set(valid.map((e) => `${e.ownerId}|${e.birdId}`));
			for (const [key, slot] of slots)
				if (!keys.has(key)) {
					stop(slot);
					slots.delete(key);
				}
			for (const entry of valid) updateSlot(entry, now);
			if (!valid.length) for (const key of Array.from(inputs.keys())) remove(key);
			if (!tasks) for (const input of inputs.values()) input.history.fill(0);
		},
		clear() {
			tasks = false;
			for (const slot of slots.values()) stop(slot);
			slots.clear();
			for (const input of inputs.values()) input.history.fill(0);
		},
		silence() {
			volume = 0;
			for (const slot of slots.values()) stop(slot);
		},
		disconnect() {
			this.clear();
			for (const key of Array.from(inputs.keys())) remove(key);
			output.disconnect();
		},
	};
}
