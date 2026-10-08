export type TohCustomRoleType = 'Impostor' | 'Madmate' | 'Crewmate' | 'Neutral' | 'Animals';

export interface TohRoleDefinition {
	roleId: number;
	roleName: string;
	displayName: string;
	customRoleType: TohCustomRoleType;
	isKiller: boolean | null;
}

export function isTohCustomRoleType(value: unknown): value is TohCustomRoleType {
	return ['Impostor', 'Madmate', 'Crewmate', 'Neutral', 'Animals'].includes(value as string);
}

export function isTohRoleCatalog(value: unknown): value is TohRoleDefinition[] {
	if (!Array.isArray(value) || value.length > 1024) return false;
	const ids = new Set<number>();
	const names = new Set<string>();
	for (const role of value) {
		if (!role || typeof role !== 'object') return false;
		if (
			!Number.isInteger(role.roleId) ||
			typeof role.roleName !== 'string' ||
			!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(role.roleName) ||
			typeof role.displayName !== 'string' ||
			!role.displayName.trim() ||
			role.displayName.length > 256 ||
			!isTohCustomRoleType(role.customRoleType) ||
			(role.isKiller !== null && typeof role.isKiller !== 'boolean') ||
			ids.has(role.roleId) ||
			names.has(role.roleName)
		)
			return false;
		ids.add(role.roleId);
		names.add(role.roleName);
	}
	return true;
}

export interface TohRole {
	roleId: number;
	roleName: string | null;
	isNeutralKiller: boolean | null;
	/** Actual active role class implements IKiller (including inherited interfaces). */
	isKiller: boolean | null;
	/** Loaded DLL's SimpleRoleInfo.CustomRoleType; unknown metadata grants no faction permission. */
	customRoleType?: TohCustomRoleType | null;
	opportunistCanKill?: boolean;
}

export function isTohRole(value: unknown): value is TohRole {
	if (!value || typeof value !== 'object') return false;
	const role = value as TohRole;
	return (
		Number.isInteger(role.roleId) &&
		(role.roleName === null || typeof role.roleName === 'string') &&
		(role.isKiller === null || typeof role.isKiller === 'boolean') &&
		(role.isNeutralKiller === null || typeof role.isNeutralKiller === 'boolean') &&
		(role.customRoleType == null || isTohCustomRoleType(role.customRoleType)) &&
		(role.opportunistCanKill === undefined || typeof role.opportunistCanKill === 'boolean')
	);
}

/** Mirrors TOH4E and TOH4E_EM ExtendedPlayerControl.IsNeutralKiller, not vanilla RoleTeam. */
export function tohNeutralKiller(name: string | null, opportunistCanKill?: boolean): boolean | null {
	if (!name || name === 'NotAssigned') return null;
	if (name === 'Opportunist') return opportunistCanKill ?? null;
	return ['Egoist', 'Jackal', 'Gizoku', 'Oniichan', 'DarkHide'].includes(name);
}
