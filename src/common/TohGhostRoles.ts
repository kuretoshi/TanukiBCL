import { ILobbySettings } from './ISettings';
import { TohRole } from './TohRole';

// TOH4E_EM RoleInfo / IKiller implementations, checked against upstream main.
// Use enum names rather than numeric IDs, which can differ between DLL versions.
export const tohGhostRoleGroups: readonly { label: string; roles: readonly (readonly [string, string])[] }[] = [
	{
		label: '第三陣営',
		roles: [
			['Arsonist', 'アーソニスト'],
			['BAKURETSUKI', '頭のおかしい爆裂船員'],
			['DarkGameMaster', '運営者'],
			['DarkHide', 'ダークハイド'],
			['Egoist', 'エゴイスト'],
			['Gizoku', '義賊'],
			['Jackal', 'ジャッカル'],
			['Oniichan', 'ヤンデレ'],
			['Opportunist', 'オポチュニスト'],
			['OtakuPrincess', '姫'],
			['OwnerChef', 'オーナーシェフ'],
			['PlagueDoctor', 'ペスト医師'],
			['PlatonicLover', '純愛者'],
			['Renegade', 'レネゲイド'],
			['Totocalcio', 'トトカルチョ'],
		],
	},
	{
		label: 'アニマルズ',
		roles: [
			['Braki', 'ブラキディオス'],
			['Chicken', 'チキン'],
			['Coyote', 'コヨーテ'],
			['Kraken', 'クラーケン'],
			['Leopard', 'ヒョウ'],
			['Nyaoha', 'クサネコ'],
			['RedPanda', 'レッサーパンダ'],
		],
	},
];

export const tohImpostorRoles = new Set([
	'Impostor',
	'Shapeshifter',
	'Phantom',
	'Viper',
	'NormalImpostor',
	'NormalShapeshifter',
	'NormalPhantom',
	'NormalViper',
	'Ambitioner',
	'AntiAdminer',
	'BountyHunter',
	'RemoteCharger',
	'Cinderella',
	'CursedWolf',
	'Detonator',
	'Eraser',
	'EvilBalancer',
	'EvilDiviner',
	'EvilGuesser',
	'EvilHacker',
	'EvilNekomata',
	'EvilTracker',
	'EvilWatcher',
	'FireWorks',
	'Greedier',
	'Insider',
	'JapPup',
	'Mafia',
	'Mare',
	'NekoKabocha',
	'Penguin',
	'Puppeteer',
	'Scavenger',
	'SerialKiller',
	'ShapeKiller',
	'ShapeMaster',
	'Sniper',
	'Stealth',
	'StrayWolf',
	'SuicideBomber',
	'Talktive',
	'Telepathisters',
	'Teleporter',
	'TimeThief',
	'Vampire',
	'Warlock',
	'Witch',
]);
const individualRoles = new Set<string>(tohGhostRoleGroups.flatMap((group) => group.roles.map(([key]) => key)));

export function tohGhostRoleEnabled(settings: ILobbySettings, key: string): boolean {
	if (settings.tohGhostRoles !== undefined) return settings.tohGhostRoles[key] === true;
	return settings.tohNeutralKillerHaunting === true;
}

export function setTohGhostRole(settings: ILobbySettings, key: string, checked: boolean): Partial<ILobbySettings> {
	// Snapshot all displayed legacy defaults on the first edit, preserving other toggles.
	const roles = Object.fromEntries(
		tohGhostRoleGroups.flatMap((group) => group.roles.map(([name]) => [name, tohGhostRoleEnabled(settings, name)]))
	);
	return { tohGhostRoles: { ...roles, [key]: checked } };
}

export function isTohImpostor(vanillaIsImpostor: boolean, role: TohRole | undefined): boolean {
	return vanillaIsImpostor === true && !!role?.roleName && tohImpostorRoles.has(role.roleName);
}

export function canTohHearGhosts(
	settings: ILobbySettings,
	role: TohRole | undefined,
	vanillaIsImpostor = false
): boolean {
	if (!role?.roleName || role.roleName === 'NotAssigned') return false;
	const name = role.roleName;
	if (tohImpostorRoles.has(name)) return isTohImpostor(vanillaIsImpostor, role) && settings.haunting === true;
	if (role.isKiller !== true) return false;
	// Preserve the old switch for saved settings / older hosts until the first individual edit.
	if (settings.tohGhostRoles === undefined) return settings.tohNeutralKillerHaunting === true;
	return individualRoles.has(name) && tohGhostRoleEnabled(settings, name);
}
