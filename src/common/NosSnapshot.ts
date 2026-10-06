/** NoS TBCLFields data; deliberately separate from SNR RoleId/ModifierRoleId. */
export interface NosPlayerData {
	skin?: { name: string };
	hat?: { name: string };
	visor?: { name: string };
	playerId: number;
	name: string;
	isKiller: boolean;
	isImpostor: boolean;
	isCrewmate: boolean;
	isNeutral: boolean;
	isImpostorlike: boolean;
	isJammed?: boolean;
	speakerPositionX: number;
	speakerPositionY: number;
	bodyRateX?: number;
	bodyRateY?: number;
	colorR: number;
	colorG: number;
	colorB: number;
}

export interface NosRadioData {
	/** One channel this client can speak on; NoS has already selected its team. */
	kind: number;
	/** Player IDs that can hear this client's speech on this channel. */
	hearableMask: number;
	nameLength: number;
	name: string;
}

export const NOS_JACKAL_RADIO_KIND = 1;

export function canHearNosJackalRadio(radios: readonly NosRadioData[] | undefined, playerId: number): boolean {
	return (
		Number.isInteger(playerId) &&
		playerId >= 0 &&
		playerId < 32 &&
		(radios?.some((radio) => radio.kind === NOS_JACKAL_RADIO_KIND && ((radio.hearableMask >>> playerId) & 1) !== 0) ??
			false)
	);
}

export function isNosRadioData(value: unknown): value is NosRadioData {
	if (!value || typeof value !== 'object') return false;
	const radio = value as Partial<NosRadioData>;
	return (
		Number.isInteger(radio.kind) &&
		Number.isInteger(radio.hearableMask) &&
		(radio.hearableMask as number) >= -0x80000000 &&
		(radio.hearableMask as number) <= 0x7fffffff &&
		Number.isInteger(radio.nameLength) &&
		(radio.nameLength as number) >= 0 &&
		(radio.nameLength as number) <= 32 &&
		typeof radio.name === 'string' &&
		radio.name.length === radio.nameLength
	);
}

export interface NosSnapshot {
	localMicPosition: { x: number; y: number };
	players: NosPlayerData[];
	radios: NosRadioData[];
}

export function formatNosTeam(player: NosPlayerData): string {
	const teams = [
		player.isImpostor && 'Impostor',
		player.isCrewmate && 'Crewmate',
		player.isNeutral && 'Neutral',
	].filter(Boolean);
	return `NoS: ${teams.join(' / ') || 'Unknown'}`;
}

export function nosColorHex(player?: Pick<NosPlayerData, 'colorR' | 'colorG' | 'colorB'>): string | undefined {
	if (!player) return undefined;
	const rgb = [player.colorR, player.colorG, player.colorB];
	if (!rgb.every(Number.isFinite)) return undefined;
	return (
		'#' +
		rgb
			.map((value) =>
				Math.round(Math.max(0, Math.min(1, value)) * 255)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

/** Match the published color to the generated avatar palette, allowing byte rounding. */
export function findNosColorIndex(player: NosPlayerData | undefined, palette: string[][]): number {
	const hex = nosColorHex(player);
	if (!hex) return -1;
	const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
	return palette.findIndex(
		([color]) =>
			/^#[0-9a-f]{6}$/i.test(color) &&
			rgb.every((value, i) => Math.abs(value - parseInt(color.slice(1 + i * 2, 3 + i * 2), 16)) <= 1)
	);
}
