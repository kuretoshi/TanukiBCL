import type { AmongUsState } from './AmongUsState';

/** Only the detected addon may activate Tanuki-don integrations. */
export function hasTanukiAddon(state: Pick<AmongUsState, 'mod' | 'nosAddonIds'> | undefined): boolean {
	return state?.mod === 'NoS' && state.nosAddonIds?.includes('tanuki.bcl.roles') === true;
}
