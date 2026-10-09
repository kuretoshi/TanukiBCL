import type { ILobbySettings } from './ISettings';

/** Enabling either Fixer mode disables the other in the same settings update. */
export function changeNosFixerMode(mode: 'block' | 'lowpass', enabled: boolean): Partial<ILobbySettings> {
	return mode === 'block'
		? { nosFixerJammingVoiceBlock: enabled, ...(enabled ? { nosFixerJammingLowpass: false } : {}) }
		: { nosFixerJammingLowpass: enabled, ...(enabled ? { nosFixerJammingVoiceBlock: false } : {}) };
}
