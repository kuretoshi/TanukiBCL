export interface RokuroVoiceSettings {
	headVolume: number;
	bodyVolume: number;
	bodyEcho: number;
}

export const defaultRokuroVoice: RokuroVoiceSettings = { headVolume: 100, bodyVolume: 35, bodyEcho: 50 };

export function getRokuroVoice(value?: Partial<RokuroVoiceSettings>): RokuroVoiceSettings {
	const level = (key: keyof RokuroVoiceSettings) =>
		typeof value?.[key] === 'number' && Number.isFinite(value[key])
			? Math.max(0, Math.min(100, value[key]!))
			: defaultRokuroVoice[key];
	return { headVolume: level('headVolume'), bodyVolume: level('bodyVolume'), bodyEcho: level('bodyEcho') };
}
