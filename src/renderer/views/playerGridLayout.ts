export interface PlayerGridLayout {
	columns: number;
	avatarSize: number;
}

const gridGap = 8;
const avatarChrome = 6; // Avatar's circular border extends beyond its sized wrapper.

export function getPlayerGridLayout(width: number, height: number, playerCount: number): PlayerGridLayout {
	if (playerCount <= 0) return { columns: 1, avatarSize: 100 };

	let bestColumns = 1;
	let bestRows = playerCount;
	let bestSize = 0;
	for (let columns = 1; columns <= playerCount; columns++) {
		const rows = Math.ceil(playerCount / columns);
		const size = Math.min(
			100,
			(width - gridGap * (columns - 1)) / columns - avatarChrome,
			(height - gridGap * (rows - 1)) / rows - avatarChrome
		);
		if (size > bestSize || (size === bestSize && rows < bestRows)) {
			bestColumns = columns;
			bestRows = rows;
			bestSize = size;
		}
	}

	return { columns: bestColumns, avatarSize: Math.max(1, Math.floor(bestSize)) };
}

export const playerGridGap = gridGap;
export const playerAvatarChrome = avatarChrome;
