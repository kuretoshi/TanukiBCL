import { VoiceEffectId, VoiceEffectTuning, normalizeVoiceEffectTuning } from '../../common/VoiceEffectTuning';
import { prepareSourceFilter } from '../voice/sourceFilterEffect';
import { createTunedPlayback } from '../voice/tunedVoiceEffect';

export type VoiceEffectPreviewKind = VoiceEffectId;
export interface VoiceEffectPreview {
	input: AudioNode;
	output: AudioNode;
	update: (tuning: VoiceEffectTuning) => void;
	dispose: () => void;
}
export async function createVoiceEffectPreview(
	context: AudioContext,
	kind: VoiceEffectId,
	tuning: VoiceEffectTuning
): Promise<VoiceEffectPreview> {
	let pitchReady = false,
		buffer: AudioBuffer | null = null,
		disposed = false,
		pitchPreparation: Promise<void> | undefined;
	let latest = normalizeVoiceEffectTuning(tuning);
	const preparePitch = () =>
		(pitchPreparation ??= prepareSourceFilter(context)
			.then(() => {
				pitchReady = true;
			})
			.catch(() => {
				/* Keep pitch-neutral tails available without worklet support. */
			}));
	if (latest.pitch !== 0) await preparePitch();
	try {
		const url = import.meta.env.DEV ? `${window.location.origin}/sounds/reverb.ogx` : 'app://bundle/sounds/reverb.ogx';
		buffer = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
	} catch {
		/* A missing impulse must leave speech on the dry path. */
	}
	const effect = createTunedPlayback(context, kind === 'nosBibiri');
	const apply = () => {
		if (disposed) return;
		const next = latest;
		const grit = kind === 'nosBerserker' ? Math.max(Math.abs(next.pitch), next.reverb, next.echo) : 0;
		effect.update(next, buffer, pitchReady, grit);
	};
	const update = (value: VoiceEffectTuning) => {
		latest = normalizeVoiceEffectTuning(value);
		apply();
		if (latest.pitch !== 0 && !pitchPreparation) void preparePitch().then(apply);
	};
	update(tuning);
	return {
		input: effect.input,
		output: effect.output,
		update,
		dispose: () => {
			disposed = true;
			effect.disconnect();
		},
	};
}
