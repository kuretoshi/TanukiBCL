import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SnrCosmeticPart = 'hat-front' | 'hat-back' | 'visor' | 'skin';

const suffixes: Record<SnrCosmeticPart, string[]> = {
	'hat-front': ['_front.png'],
	'hat-back': ['_back.png'],
	visor: ['_idle.png', '_front.png'],
	skin: ['_front.png', '_idle.png'],
};

function sanitizeFileName(value: string): string {
	return Array.from(value.replace(/\.\.\./g, '.').replace(/[<>:"/\\|?*]/g, ''))
		.filter((character) => character.charCodeAt(0) >= 32)
		.join('');
}

export function findSnrCosmeticFile(
	gameExecutable: string,
	productId: string,
	part: SnrCosmeticPart
): string | undefined {
	if (!productId.startsWith('Modded_')) return undefined;
	const plainProductId = productId.replace(/<[^>]*>/g, '');
	const root = join(dirname(gameExecutable), 'SuperNewRolesNext', 'CustomCosmetics');
	if (!existsSync(root)) return undefined;

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.toLowerCase().endsWith('.bundle')) continue;
		const prefix = `Modded_${entry.name}_`;
		if (!plainProductId.startsWith(prefix)) continue;
		const cosmeticName = sanitizeFileName(plainProductId.slice(prefix.length));
		for (const suffix of suffixes[part]) {
			const candidate = join(root, entry.name, cosmeticName + suffix);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}
