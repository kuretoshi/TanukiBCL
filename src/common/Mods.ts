// prettier-ignore
export type ModsType =
	| 'NONE'
	| 'SUPER_NEW_ROLES'
	| 'TOWN_OF_US_MIRA'
	| 'TOWN_OF_US'
	| 'THE_OTHER_ROLES'
	| 'LAS_MONJAS'
	| 'NoS'
	| 'TOH4E'
	| 'OTHER';

export interface AmongusMod {
	id: ModsType;
	label: string;
	dllStartsWith?: string;
}

export const modList: AmongusMod[] = [
	// recieve this later from git?
	{
		id: 'NONE',
		label: 'None',
	},
	{ id: 'TOH4E', label: 'TOH4E / TOH4E_EM', dllStartsWith: 'TownOfHost_ForE' },
	{
		id: 'SUPER_NEW_ROLES',
		label: 'SuperNewRoles',
		dllStartsWith: 'SuperNewRoles',
	},
	{
		id: 'TOWN_OF_US_MIRA',
		label: 'Town of Us: Mira',
		dllStartsWith: 'TownOfUsMira',
	},
	{
		id: 'TOWN_OF_US',
		label: 'Town of Us: Reactivated',
		dllStartsWith: 'TownOfUs',
	},
	{
		id: 'THE_OTHER_ROLES',
		label: 'The Other Roles',
		dllStartsWith: 'TheOtherRoles',
	},
	// {
	// 	id: 'TOWN_OF_HOSTS',
	// 	label: 'Town of Hosts',
	// 	dllStartsWith: 'TownOfHost',
	// },
	{
		id: 'LAS_MONJAS',
		label: 'Las Monjas',
		dllStartsWith: 'LasMonjas',
	},
	{
		id: 'NoS',
		label: 'Nebula on the Ship',
		dllStartsWith: 'Nebula',
	},
	{
		id: 'OTHER',
		label: 'Other',
	},
];

export function isToh4eHostName(name: string | undefined): boolean {
	return /town\s+of\s+host\s+for\s+e\b/i.test(
		(name ?? '').replace(/<[^>]*>/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '')
	);
}

export function displayHostName(name: string): string {
	const marker = name.toLowerCase().indexOf('town of host for e');
	return marker >= 0 ? name.slice(0, marker).trimEnd() : name;
}
