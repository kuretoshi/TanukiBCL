export interface TohRole {
	roleId: number;
	roleName: string | null;
	isNeutralKiller: boolean | null;
	/** Actual active role class implements IKiller (including inherited interfaces). */
	isKiller: boolean | null;
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
		(role.opportunistCanKill === undefined || typeof role.opportunistCanKill === 'boolean')
	);
}

/** Mirrors TOH4E and TOH4E_EM ExtendedPlayerControl.IsNeutralKiller, not vanilla RoleTeam. */
export function tohNeutralKiller(name: string | null, opportunistCanKill?: boolean): boolean | null {
	if (!name || name === 'NotAssigned') return null;
	if (name === 'Opportunist') return opportunistCanKill ?? null;
	return ['Egoist', 'Jackal', 'Gizoku', 'Oniichan', 'DarkHide'].includes(name);
}
