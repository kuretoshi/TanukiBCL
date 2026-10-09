export interface NosRole {
	roleId: number | null;
	roleName: string | null;
	displayName: string | null;
	runtimeClass: string;
	bodyType?: number;
	isBerserking?: boolean;
	isRainbowStar?: boolean | null;
}

export interface NosPlayerRole {
	playerId: number;
	role: NosRole;
}

export function isNosPlayerRoles(value: unknown): value is NosPlayerRole[] {
	if (!Array.isArray(value) || value.length > 64) return false;
	const ids = new Set<number>();
	return value.every((row) => {
		if (!row || typeof row !== 'object') return false;
		const { playerId, role } = row;
		if (!Number.isInteger(playerId) || playerId < 0 || playerId > 255 || ids.has(playerId) || !role) return false;
		ids.add(playerId);
		return (
			(role.roleId === null || (Number.isInteger(role.roleId) && role.roleId >= 0)) &&
			[role.roleName, role.displayName].every(
				(name) => name === null || (typeof name === 'string' && name.length <= 512)
			) &&
			typeof role.runtimeClass === 'string' &&
			role.runtimeClass.length > 0 &&
			role.runtimeClass.length <= 1024 &&
			(role.isRainbowStar == null || typeof role.isRainbowStar === 'boolean')
		);
	});
}

export function formatNosRole(role: NosRole): string {
	return `NoS: ${role.displayName || role.roleName || '役職名未取得'}`;
}
