import { ipcMain } from 'electron';
import { localSpeechStatus, setLocalSpeech } from './localStoneSpeech';
export function registerLocalSpeechIpc(trusted: (id: number) => boolean): void {
	ipcMain.handle('VOICE_STONE_LOCAL_STATUS', (e) => (trusted(e.sender.id) ? localSpeechStatus() : null));
	ipcMain.handle('VOICE_STONE_LOCAL_SET', (e, enabled: unknown) => trusted(e.sender.id) && setLocalSpeech(enabled));
}
