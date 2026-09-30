export interface VoiceEffectNodes {
	filter: BiquadFilterNode;
	dryGain: GainNode;
	wetGain: GainNode;
}

export interface VoiceDisguiseEffect {
	jumbo?: boolean;
	squashing?: boolean;
	directPitch?: boolean;
	input: GainNode;
	output: GainNode;
	dryGain: GainNode;
	filter: BiquadFilterNode;
	toneFilter: BiquadFilterNode;
	pitchDelayA: DelayNode;
	pitchDelayB: DelayNode;
	pitchDownDelayA: DelayNode;
	pitchDownDelayB: DelayNode;
	delayModA: AudioBufferSourceNode;
	delayModB: AudioBufferSourceNode;
	delayDownModA: AudioBufferSourceNode;
	delayDownModB: AudioBufferSourceNode;
	fadeModA: AudioBufferSourceNode;
	fadeModB: AudioBufferSourceNode;
	fadeDownModA: AudioBufferSourceNode;
	fadeDownModB: AudioBufferSourceNode;
	pitchGainA: GainNode;
	pitchGainB: GainNode;
	pitchDownGainA: GainNode;
	pitchDownGainB: GainNode;
	reverb?: ConvolverNode;
	wetGain: GainNode;
	pitchUpWetGain: GainNode;
	pitchDownWetGain: GainNode;
}

const clampStrength = (strength: number) => Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : 0));
export type PitchShiftDirection = 'up' | 'down';

export function updateVoiceEffectStrength(nodes: VoiceEffectNodes, strength: number) {
	const normalizedStrength = clampStrength(strength) / 100;

	configureVoiceEffectFilter(nodes.filter, strength);
	nodes.dryGain.gain.value = 1 - normalizedStrength * 0.9;
	nodes.wetGain.gain.value = normalizedStrength * 1.6;
}

export function configureVoiceEffectFilter(filter: BiquadFilterNode, strength: number, formantScale = 1) {
	const normalizedStrength = clampStrength(strength) / 100;
	const normalizedFormantScale = Math.min(1.7, Math.max(0.55, Number.isFinite(formantScale) ? formantScale : 1));

	filter.type = 'bandpass';
	filter.frequency.value = (1200 - normalizedStrength * 350) * normalizedFormantScale;
	filter.Q.value = 1 + normalizedStrength * 8;
}

function createDelayTimeBuffer(context: AudioContext, delayTime: number, pitchUp: boolean, offset = 0) {
	const sampleRate = context.sampleRate;
	const buffer = context.createBuffer(1, Math.floor(delayTime * sampleRate), sampleRate);
	const data = buffer.getChannelData(0);

	for (let i = 0; i < data.length; i++) {
		const phase = (i / data.length + offset) % 1;
		data[i] = pitchUp ? delayTime * (1 - phase) : delayTime * phase;
	}

	return buffer;
}

function createFadeBuffer(context: AudioContext, delayTime: number, offset: number, squared = false) {
	const sampleRate = context.sampleRate;
	const buffer = context.createBuffer(1, Math.floor(delayTime * sampleRate), sampleRate);
	const data = buffer.getChannelData(0);

	for (let i = 0; i < data.length; i++) {
		const phase = (i / data.length + offset) % 1;
		const fade = Math.sin(Math.PI * phase);
		data[i] = squared ? fade * fade : fade;
	}

	return buffer;
}

function createLoopingBufferSource(context: AudioContext, buffer: AudioBuffer) {
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	source.start(0);
	return source;
}

export function createVoiceDisguiseEffect(
	context: AudioContext,
	reverbBuffer: AudioBuffer | null,
	strength: number
): VoiceDisguiseEffect {
	const input = context.createGain();
	const output = context.createGain();
	const dryGain = context.createGain();
	const filter = context.createBiquadFilter();
	const toneFilter = context.createBiquadFilter();
	toneFilter.type = 'lowshelf';
	toneFilter.frequency.value = 400;
	toneFilter.gain.value = 0;
	const pitchDelayA = context.createDelay(0.12);
	const pitchDelayB = context.createDelay(0.12);
	const pitchDownDelayA = context.createDelay(0.12);
	const pitchDownDelayB = context.createDelay(0.12);
	const pitchGainA = context.createGain();
	const pitchGainB = context.createGain();
	const pitchDownGainA = context.createGain();
	const pitchDownGainB = context.createGain();
	const wetGain = context.createGain();
	const pitchUpWetGain = context.createGain();
	const pitchDownWetGain = context.createGain();
	const delayTime = 0.035;
	const delayUpBuffer = createDelayTimeBuffer(context, delayTime, true);
	const downDelayTime = 0.08;
	const delayDownBuffer = createDelayTimeBuffer(context, downDelayTime, false);
	const fadeBufferA = createFadeBuffer(context, delayTime, 0);
	const fadeBufferB = createFadeBuffer(context, delayTime, 0.5);
	const delayModA = createLoopingBufferSource(context, delayUpBuffer);
	const delayModB = createLoopingBufferSource(context, delayUpBuffer);
	const delayDownModA = createLoopingBufferSource(context, delayDownBuffer);
	const delayDownModB = createLoopingBufferSource(context, createDelayTimeBuffer(context, downDelayTime, false, 0.5));
	const fadeModA = createLoopingBufferSource(context, fadeBufferA);
	const fadeModB = createLoopingBufferSource(context, fadeBufferB);
	const fadeDownModA = createLoopingBufferSource(context, createFadeBuffer(context, downDelayTime, 0, true));
	const fadeDownModB = createLoopingBufferSource(context, createFadeBuffer(context, downDelayTime, 0.5, true));
	// Modulation supplies the entire window; an intrinsic gain of 1 would leak delay resets.
	pitchDownGainA.gain.value = 0;
	pitchDownGainB.gain.value = 0;

	delayModA.connect(pitchDelayA.delayTime);
	delayModB.connect(pitchDelayB.delayTime);
	delayDownModA.connect(pitchDownDelayA.delayTime);
	delayDownModB.connect(pitchDownDelayB.delayTime);
	fadeModA.connect(pitchGainA.gain);
	fadeModB.connect(pitchGainB.gain);
	fadeDownModA.connect(pitchDownGainA.gain);
	fadeDownModB.connect(pitchDownGainB.gain);

	input.connect(dryGain);
	dryGain.connect(toneFilter);
	input.connect(filter);
	filter.connect(pitchDelayA);
	filter.connect(pitchDelayB);
	filter.connect(pitchDownDelayA);
	filter.connect(pitchDownDelayB);
	pitchDelayA.connect(pitchGainA);
	pitchDelayB.connect(pitchGainB);
	pitchDownDelayA.connect(pitchDownGainA);
	pitchDownDelayB.connect(pitchDownGainB);
	pitchGainA.connect(pitchUpWetGain);
	pitchGainB.connect(pitchUpWetGain);
	pitchDownGainA.connect(pitchDownWetGain);
	pitchDownGainB.connect(pitchDownWetGain);
	pitchUpWetGain.connect(wetGain);
	pitchDownWetGain.connect(wetGain);

	let reverb: ConvolverNode | undefined;
	if (reverbBuffer) {
		reverb = context.createConvolver();
		reverb.buffer = reverbBuffer;
		wetGain.connect(reverb);
		reverb.connect(toneFilter);
	} else {
		wetGain.connect(toneFilter);
	}
	toneFilter.connect(output);

	const effect = {
		input,
		output,
		dryGain,
		filter,
		toneFilter,
		pitchDelayA,
		pitchDelayB,
		pitchDownDelayA,
		pitchDownDelayB,
		delayModA,
		delayModB,
		delayDownModA,
		delayDownModB,
		fadeModA,
		fadeModB,
		fadeDownModA,
		fadeDownModB,
		pitchGainA,
		pitchGainB,
		pitchDownGainA,
		pitchDownGainB,
		reverb,
		wetGain,
		pitchUpWetGain,
		pitchDownWetGain,
	};
	updateVoiceDisguiseEffect(effect, strength);
	return effect;
}

export function updateVoiceDisguiseEffect(
	effect: VoiceDisguiseEffect,
	strength: number,
	direction: PitchShiftDirection = 'up',
	formantScale = 1,
	jumbo = false,
	squash = 0,
	toneRate = 1,
	directPitch = false
) {
	const normalizedStrength = clampStrength(strength) / 100;
	const safeToneRate = Number.isFinite(toneRate) && toneRate > 0 ? toneRate : 1;
	effect.toneFilter.gain.value = Math.min(6, Math.max(-6, (Math.log(safeToneRate) / Math.log(5)) * 6));
	if (squash > 0) {
		const progress = Math.min(1, Math.max(0, squash));
		const now = effect.input.context.currentTime;
		effect.jumbo = false;
		effect.squashing = true;
		if (effect.directPitch) {
			for (const source of [effect.delayModA, effect.delayModB, effect.fadeModA, effect.fadeModB]) {
				source.playbackRate.cancelScheduledValues(now);
				source.playbackRate.value = 1;
			}
		}
		effect.directPitch = false;
		for (const param of [effect.filter.frequency, effect.dryGain.gain, effect.wetGain.gain, effect.output.gain])
			param.cancelScheduledValues(now);
		effect.filter.type = 'lowpass';
		effect.filter.frequency.setTargetAtTime(6000 - progress * 5200, now, 0.04);
		effect.filter.Q.value = Math.SQRT1_2;
		effect.dryGain.gain.setTargetAtTime(1 - progress, now, 0.04);
		effect.wetGain.gain.setTargetAtTime(progress * 0.45, now, 0.04);
		effect.pitchUpWetGain.gain.value = 1;
		effect.pitchDownWetGain.gain.value = 0;
		effect.output.gain.setTargetAtTime(1 - progress * 0.75, now, 0.04);
		return;
	}
	if (effect.squashing) {
		const now = effect.input.context.currentTime;
		for (const param of [effect.filter.frequency, effect.dryGain.gain, effect.wetGain.gain, effect.output.gain])
			param.cancelScheduledValues(now);
	}
	effect.squashing = false;
	effect.output.gain.value = 1;
	if (effect.directPitch && !directPitch) {
		const now = effect.input.context.currentTime;
		for (const source of [effect.delayModA, effect.delayModB, effect.fadeModA, effect.fadeModB]) {
			source.playbackRate.cancelScheduledValues(now);
			source.playbackRate.value = 1;
		}
	}
	effect.directPitch = directPitch;
	if (jumbo) {
		// Delay slope sets pitch: 1.0 at zero growth, down to 0.4 at maximum size.
		// Keep both windows phase locked while smoothing changes in the growth value.
		const now = effect.input.context.currentTime;
		for (const source of [effect.delayDownModA, effect.delayDownModB, effect.fadeDownModA, effect.fadeDownModB]) {
			if (!effect.jumbo) {
				source.playbackRate.cancelScheduledValues(now);
				source.playbackRate.value = normalizedStrength * 0.6;
			}
			source.playbackRate.setTargetAtTime(normalizedStrength * 0.6, now, 0.06);
		}
		effect.filter.type = 'lowpass';
		effect.filter.frequency.setTargetAtTime(12000 - normalizedStrength * 8500, now, 0.06);
		effect.filter.Q.value = Math.SQRT1_2;
		effect.dryGain.gain.value = normalizedStrength === 0 ? 1 : 0;
		effect.wetGain.gain.value = normalizedStrength === 0 ? 0 : 1;
		effect.pitchUpWetGain.gain.value = 0;
		effect.pitchDownWetGain.gain.value = 1;
		effect.jumbo = true;
		return;
	}
	if (effect.jumbo) effect.filter.frequency.cancelScheduledValues(effect.input.context.currentTime);
	effect.jumbo = false;
	if (directPitch) {
		const now = effect.input.context.currentTime;
		for (const source of [effect.delayModA, effect.delayModB, effect.fadeModA, effect.fadeModB]) {
			source.playbackRate.cancelScheduledValues(now);
			source.playbackRate.value = normalizedStrength;
		}
		effect.filter.type = 'lowpass';
		effect.filter.frequency.value = 12000;
		effect.filter.Q.value = Math.SQRT1_2;
		effect.dryGain.gain.value = normalizedStrength === 0 ? 1 : 0;
		effect.wetGain.gain.value = normalizedStrength === 0 ? 0 : 1;
		effect.pitchUpWetGain.gain.value = 1;
		effect.pitchDownWetGain.gain.value = 0;
		return;
	}

	configureVoiceEffectFilter(effect.filter, strength, formantScale);
	effect.dryGain.gain.value = 1 - normalizedStrength * 0.95;
	effect.wetGain.gain.value = normalizedStrength * 1.45;
	effect.pitchUpWetGain.gain.value = direction === 'up' ? 1 : 0;
	effect.pitchDownWetGain.gain.value = direction === 'down' ? 1 : 0;
}

export function disconnectVoiceDisguiseEffect(effect: VoiceDisguiseEffect) {
	effect.delayModA.stop();
	effect.delayModB.stop();
	effect.delayDownModA.stop();
	effect.delayDownModB.stop();
	effect.fadeModA.stop();
	effect.fadeModB.stop();
	effect.fadeDownModA.stop();
	effect.fadeDownModB.stop();
	effect.delayModA.disconnect();
	effect.delayModB.disconnect();
	effect.delayDownModA.disconnect();
	effect.delayDownModB.disconnect();
	effect.fadeModA.disconnect();
	effect.fadeModB.disconnect();
	effect.fadeDownModA.disconnect();
	effect.fadeDownModB.disconnect();
	effect.input.disconnect();
	effect.dryGain.disconnect();
	effect.filter.disconnect();
	effect.toneFilter.disconnect();
	effect.pitchDelayA.disconnect();
	effect.pitchDelayB.disconnect();
	effect.pitchDownDelayA.disconnect();
	effect.pitchDownDelayB.disconnect();
	effect.pitchGainA.disconnect();
	effect.pitchGainB.disconnect();
	effect.pitchDownGainA.disconnect();
	effect.pitchDownGainB.disconnect();
	effect.pitchUpWetGain.disconnect();
	effect.pitchDownWetGain.disconnect();
	effect.wetGain.disconnect();
	effect.reverb?.disconnect();
	effect.output.disconnect();
}

export function connectVoiceEffect(
	context: AudioContext,
	source: AudioNode,
	destination: AudioNode,
	strength: number
): VoiceEffectNodes {
	const filter = context.createBiquadFilter();
	const dryGain = context.createGain();
	const wetGain = context.createGain();

	source.connect(dryGain);
	dryGain.connect(destination);
	source.connect(filter);
	filter.connect(wetGain);
	wetGain.connect(destination);

	const nodes = { filter, dryGain, wetGain };
	updateVoiceEffectStrength(nodes, strength);
	return nodes;
}

export function disconnectVoiceEffect(nodes: VoiceEffectNodes) {
	nodes.filter.disconnect();
	nodes.dryGain.disconnect();
	nodes.wetGain.disconnect();
}
