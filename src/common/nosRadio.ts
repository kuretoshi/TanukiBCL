import type { ILobbySettings } from './ISettings';
import type { NosRadioData } from './NosSnapshot';

type RadioSettings = Pick<ILobbySettings, 'impostorRadioEnabled' | 'impostorRadioOnlyMode' | 'jackalRadioEnabled'>;

export const NOS_IMPOSTOR_RADIO_KIND = 0;
export const NOS_JACKAL_RADIO_KIND = 1;

function isValidPlayerId(playerId: number): boolean {
	return Number.isInteger(playerId) && playerId >= 0 && playerId < 32;
}

function hasListenerBit(radio: NosRadioData, playerId: number): boolean {
	return ((radio.hearableMask >>> playerId) & 1) !== 0;
}

/** Channel settings apply equally to transmitting, receiving and the radio indicator. */
export function isNosRadioEnabled(kind: number, settings: RadioSettings): boolean {
	switch (kind) {
		case NOS_IMPOSTOR_RADIO_KIND:
			return settings.impostorRadioEnabled || settings.impostorRadioOnlyMode;
		case NOS_JACKAL_RADIO_KIND:
			return settings.jackalRadioEnabled && !settings.impostorRadioOnlyMode;
		default:
			return false;
	}
}

/** The sender can transmit without its own bit being present in the mask. */
export function canUseNosRadio(radios: readonly NosRadioData[] | undefined, settings: RadioSettings): boolean {
	return radios?.some((radio) => isNosRadioEnabled(radio.kind, settings)) ?? false;
}

/** Reception uses the sender's mask and the listener's PlayerId, never the reverse direction. */
export function canReceiveNosRadio(
	radios: readonly NosRadioData[] | undefined,
	playerId: number,
	settings: RadioSettings
): boolean {
	if (!isValidPlayerId(playerId)) return false;
	return radios?.some((radio) => isNosRadioEnabled(radio.kind, settings) && hasListenerBit(radio, playerId)) ?? false;
}

export function canHearNosRadio(radios: readonly NosRadioData[] | undefined, playerId: number, kind: number): boolean {
	if (!isValidPlayerId(playerId)) return false;
	return radios?.some((radio) => radio.kind === kind && hasListenerBit(radio, playerId)) ?? false;
}

export function canHearNosImpostorRadio(radios: readonly NosRadioData[] | undefined, playerId: number): boolean {
	return canHearNosRadio(radios, playerId, NOS_IMPOSTOR_RADIO_KIND);
}

export function canHearNosJackalRadio(radios: readonly NosRadioData[] | undefined, playerId: number): boolean {
	return canHearNosRadio(radios, playerId, NOS_JACKAL_RADIO_KIND);
}

/** Legacy senders are accepted only when their channel is unambiguous. */
export function resolveNosRadioKind(
	radios: readonly NosRadioData[] | undefined,
	selected: number | undefined
): number | undefined {
	if (selected !== undefined) return selected;
	const kinds = new Set(radios?.filter((radio) => radio.kind === 0 || radio.kind === 1).map((radio) => radio.kind));
	return kinds.size === 1 ? kinds.values().next().value : undefined;
}

/** Key repeats do not change priority; releasing one key preserves the other held channel. */
export class HeldNosRadio {
	private held: number[] = [];
	get kind(): number | undefined {
		return this.held[this.held.length - 1];
	}
	set(kind: number, pressed: boolean): void {
		if (pressed) {
			if (!this.held.includes(kind)) this.held.push(kind);
		} else this.held = this.held.filter((value) => value !== kind);
	}
	clear(): void {
		this.held = [];
	}
}
