/** Listener-side controls; existing strength settings remain intact for older clients. */
export const voiceEffectDefinitions = {
	disguise: { strengthKey: 'voiceEffectStrength', pitchSign: -1, reverb: false, echo: false },
	snrJumbo: { strengthKey: 'snrJumboVoiceEffectStrength', pitchSign: -1, reverb: false, echo: false },
	snrPush: { strengthKey: 'snrPushReverbStrength', pitchSign: 0, reverb: true, echo: false },
	nosSize: { strengthKey: 'nosSizeVoiceEffectStrength', pitchSign: -1, reverb: false, echo: false },
	nosRokurokubi: { strengthKey: 'nosRokurokubiVoiceEffectStrength', pitchSign: 1, reverb: false, echo: false },
	nosBerserker: { strengthKey: 'nosBerserkerVoiceEffectStrength', pitchSign: 0, reverb: true, echo: true },
	nosCitrus: { strengthKey: 'nosCitrusVoiceEffectStrength', pitchSign: 1, reverb: false, echo: false },
	nosRainbowStar: { strengthKey: 'nosRainbowStarEchoStrength', pitchSign: 0, reverb: true, echo: false },
	nosVoiceJamming: { strengthKey: 'nosVoiceJammingEffectStrength', pitchSign: -1, reverb: false, echo: false },
	nosMegaphone: { strengthKey: 'nosMegaphoneEffectStrength', pitchSign: -1, reverb: false, echo: false },
	nosBibiri: { strengthKey: 'nosBibiriEchoStrength', pitchSign: 0, reverb: false, echo: true },
} as const;

export type VoiceEffectId = keyof typeof voiceEffectDefinitions;
export type VoiceEffectStrengthKey = (typeof voiceEffectDefinitions)[VoiceEffectId]['strengthKey'];

export interface VoiceEffectTuning {
	/** -100: one octave lower; 0: original pitch; +100: one octave higher. */
	pitch: number;
	reverb: number;
	echo: number;
}

export type VoiceEffectTunings = Partial<Record<VoiceEffectId, Partial<VoiceEffectTuning>>>;
export type VoiceEffectTuningSettings = Partial<Record<VoiceEffectStrengthKey, number>> & {
	voiceEffectTunings?: VoiceEffectTunings;
};

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

export function normalizeVoiceEffectTuning(
	value: Partial<VoiceEffectTuning> | undefined,
	fallback: VoiceEffectTuning = { pitch: 0, reverb: 0, echo: 0 }
): VoiceEffectTuning {
	return {
		pitch: bounded(value?.pitch, -100, 100, fallback.pitch),
		reverb: bounded(value?.reverb, 0, 100, fallback.reverb),
		echo: bounded(value?.echo, 0, 100, fallback.echo),
	};
}

/** Derive unsaved presets without rewriting the user's legacy settings. */
export function getVoiceEffectTuning(settings: VoiceEffectTuningSettings, id: VoiceEffectId): VoiceEffectTuning {
	const definition = voiceEffectDefinitions[id];
	const strength = bounded(settings[definition.strengthKey], 0, 100, 100);
	return normalizeVoiceEffectTuning(settings.voiceEffectTunings?.[id], {
		pitch: strength === 0 ? 0 : definition.pitchSign * strength,
		reverb: definition.reverb ? strength : 0,
		echo: definition.echo ? strength : 0,
	});
}

export function voicePitchRatio(pitch: number): number {
	return 2 ** (bounded(pitch, -100, 100, 0) / 100);
}

/** Simultaneous role/modifier effects share one tail, rather than duplicating audio paths. */
export function combineVoiceEffectTunings(tunings: readonly VoiceEffectTuning[]): VoiceEffectTuning {
	const combined = tunings.reduce<VoiceEffectTuning>(
		(mix, tuning) => ({
			pitch: mix.pitch + tuning.pitch,
			reverb: Math.max(mix.reverb, tuning.reverb),
			echo: Math.max(mix.echo, tuning.echo),
		}),
		{ pitch: 0, reverb: 0, echo: 0 }
	);
	return { ...combined, pitch: bounded(combined.pitch, -100, 100, 0) };
}

export function isNeutralVoiceEffectTuning(tuning: VoiceEffectTuning): boolean {
	return tuning.pitch === 0 && tuning.reverb === 0 && tuning.echo === 0;
}
