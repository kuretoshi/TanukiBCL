export interface PlayerGridLayout {
	columns: number;
	avatarSize: number;
}

const gridGap = 8;
const avatarChrome = 6; // Avatar's circular border extends beyond its sized wrapper.
const groupHeaderHeight = 18;

export function getPlayerGridLayout(
	width: number,
	height: number,
	playerCount: number,
	splitAfter?: number
): PlayerGridLayout {
	if (playerCount <= 0) return { columns: 1, avatarSize: 100 };

	// Grouped players use the same maximum size as the local player's avatar.
	const maxAvatarSize = splitAfter === undefined ? 100 : 80;
	const aliveCount = splitAfter === undefined ? playerCount : Math.max(0, Math.min(playerCount, splitAfter));
	const ghostCount = playerCount - aliveCount;
	const headerRows = splitAfter === undefined ? 0 : Number(aliveCount > 0) + Number(ghostCount > 0);
	let bestColumns = 1;
	let bestRows = playerCount;
	let bestSize = 0;
	let fiveColumnSize = 0;
	for (let columns = 1; columns <= playerCount; columns++) {
		const rows = Math.ceil(aliveCount / columns) + Math.ceil(ghostCount / columns);
		const size = Math.min(
			maxAvatarSize,
			(width - gridGap * (columns - 1)) / columns - avatarChrome,
			(height - groupHeaderHeight * headerRows - gridGap * (rows + headerRows - 1)) / rows - avatarChrome
		);
		if (columns === 5) fiveColumnSize = size;
		if (size > bestSize || (size === bestSize && rows < bestRows)) {
			bestColumns = columns;
			bestRows = rows;
			bestSize = size;
		}
	}

	const minimumFiveColumnSize = splitAfter === undefined ? 30 : 20;
	if (playerCount >= 12 && bestColumns < 5 && fiveColumnSize >= Math.max(minimumFiveColumnSize, bestSize * 0.85)) {
		return { columns: 5, avatarSize: Math.floor(fiveColumnSize) };
	}

	return { columns: bestColumns, avatarSize: Math.max(1, Math.floor(bestSize)) };
}

export const playerGridGap = gridGap;
export const playerAvatarChrome = avatarChrome;
export const playerGroupHeaderHeight = groupHeaderHeight;
