/** NoS TBCLFields data; deliberately separate from SNR RoleId/ModifierRoleId. */
export interface NosPlayerData {
	playerId: number;
	name: string;
	isKiller: boolean;
	isImpostor: boolean;
	isCrewmate: boolean;
	isNeutral: boolean;
	isImpostorlike: boolean;
	speakerPositionX: number;
	speakerPositionY: number;
	colorR: number;
	colorG: number;
	colorB: number;
}

export interface NosSnapshot {
	localMicPosition: { x: number; y: number };
	players: NosPlayerData[];
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
