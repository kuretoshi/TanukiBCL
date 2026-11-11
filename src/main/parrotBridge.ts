import type { IpcMain } from 'electron';
import { AmongUsState, GameState } from '../common/AmongUsState';
import { nosAddonLink } from './nosAddonLink';

export function registerParrotBridge(
	ipc: IpcMain,
	getContext: () => { pid: number; state?: AmongUsState },
	isMainRenderer: (id: number) => boolean
): void {
	ipc.on('NOS_PARROT_CAPTURE', (event, owner: unknown, bird: unknown, source: unknown) => {
		if (!isMainRenderer(event.sender.id)) return;
		const { pid, state } = getContext();
		if (state?.mod !== 'NoS' || state.gameState !== GameState.TASKS || !state.isHost) return;
		const profile = nosAddonLink.current(pid);
		if (!profile?.host || !profile.channels.parrots?.some((p) => p.ownerId === owner && p.birdId === bird)) return;
		if (!Number.isInteger(source) || (source as number) < 0 || (source as number) > 255) return;
		nosAddonLink.sendCommand(pid, 'parrot', { ownerId: owner, birdId: bird, sourceId: source });
	});
}
