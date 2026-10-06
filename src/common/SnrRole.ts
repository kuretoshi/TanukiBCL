export interface SnrEnumValue {
	value: number;
	name: string | null;
}

export interface SnrLiveRole {
	role: SnrEnumValue;
	modifier: SnrEnumValue | null;
	ghostRole: SnrEnumValue | null;
	isNeutral?: boolean;
	canKill?: boolean;
	assignedTeam?: SnrEnumValue | null;
	winnerTeam?: SnrEnumValue | null;
	teamTag?: SnrEnumValue | null;
	jumbo?: { currentSize: number; maxSize: number };
	hat2Id?: string;
	visor2Id?: string;
}

const jackalRoles = new Set(['Jackal', 'WaveCannonJackal']);
const sidekickRoles = new Set(['Sidekick', 'SidekickWaveCannon']);

export function isSnrJackal(role?: SnrLiveRole): boolean {
	return !!role?.role.name && jackalRoles.has(role.role.name);
}

export function isSnrNeutralKiller(role?: SnrLiveRole): boolean {
	return isSnrJackal(role) || (role?.isNeutral === true && role.canKill === true);
}

export function isSnrSidekick(role?: SnrLiveRole): boolean {
	return !!role?.role.name && sidekickRoles.has(role.role.name);
}

export function isSnrJackalTeam(role?: SnrLiveRole): boolean {
	return isSnrJackal(role) || isSnrSidekick(role);
}

export function hasSnrJumbo(role?: SnrLiveRole): boolean {
	return role?.modifier?.name?.split(' | ').includes('JumboModifier') ?? false;
}

export function formatSnrRole(role: SnrLiveRole): string {
	const label = role.role.name || `RoleId(${role.role.value})`;
	const modifier = role.modifier;
	return modifier && modifier.value !== 0
		? `${label} + ${modifier.name || `ModifierRoleId(${modifier.value})`}`
		: label;
}
