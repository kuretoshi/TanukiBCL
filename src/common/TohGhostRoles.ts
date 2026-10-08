import { ILobbySettings } from './ISettings';
import { TohRole, TohRoleDefinition } from './TohRole';

function tohGhostRoleTeams() {
	return [
		{ label: '第三陣営', type: 'Neutral' },
		{ label: 'アニマルズ', type: 'Animals' },
	] as const;
}

export function tohGhostRoleGroups(catalog: readonly TohRoleDefinition[]) {
	return tohGhostRoleTeams().map(({ label, type }) => ({
		label,
		type,
		roles: catalog.filter((role) => role.customRoleType === type && role.isKiller === true),
	}));
}

export function tohGhostRoleEnabled(settings: ILobbySettings, key: string): boolean {
	if (settings.tohGhostRoles !== undefined) return settings.tohGhostRoles[key] === true;
	return settings.tohNeutralKillerHaunting === true;
}

export function setTohGhostRole(
	settings: ILobbySettings,
	key: string,
	checked: boolean,
	catalog: readonly TohRoleDefinition[]
): Partial<ILobbySettings> {
	const displayed = tohGhostRoleGroups(catalog).flatMap((group) => group.roles);
	if (!displayed.some((role) => role.roleName === key)) return {};
	const roles = Object.fromEntries(
		displayed.map((role) => [role.roleName, tohGhostRoleEnabled(settings, role.roleName)])
	);
	return { tohGhostRoles: { ...settings.tohGhostRoles, ...roles, [key]: checked } };
}

export function setTohGhostRoleGroup(
	settings: ILobbySettings,
	type: 'Neutral' | 'Animals',
	checked: boolean,
	catalog: readonly TohRoleDefinition[]
): Partial<ILobbySettings> {
	const groups = tohGhostRoleGroups(catalog);
	const selected = groups.find((group) => group.type === type)?.roles ?? [];
	if (!selected.length) return {};
	const defaults = Object.fromEntries(
		groups.flatMap((group) => group.roles).map((role) => [role.roleName, tohGhostRoleEnabled(settings, role.roleName)])
	);
	const changed = Object.fromEntries(selected.map((role) => [role.roleName, checked]));
	return { tohGhostRoles: { ...settings.tohGhostRoles, ...defaults, ...changed } };
}

export function isTohImpostor(vanillaIsImpostor: boolean, role: TohRole | undefined): boolean {
	return vanillaIsImpostor === true && role?.customRoleType === 'Impostor';
}

export function canTohHearGhosts(
	settings: ILobbySettings,
	role: TohRole | undefined,
	vanillaIsImpostor = false
): boolean {
	if (!role?.roleName || role.roleName === 'NotAssigned') return false;
	if (role.customRoleType === 'Impostor') return isTohImpostor(vanillaIsImpostor, role) && settings.haunting === true;
	if (role.customRoleType !== 'Neutral' && role.customRoleType !== 'Animals') return false;
	if (role.isKiller !== true) return false;
	return tohGhostRoleEnabled(settings, role.roleName);
}
