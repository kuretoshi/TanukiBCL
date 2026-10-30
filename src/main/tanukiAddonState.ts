import { join } from 'node:path';
import { GameState, type AmongUsState } from '../common/AmongUsState';
import { hasTanukiAddon } from '../common/tanukiAddon';
import { parseBibiriEchoState } from './bibiriEchoState';
import { parseDyingVoiceState } from './dyingVoiceState';
import { parseHeroTransformState } from './heroTransformState';
import { parseInterviewState } from './interviewState';
import { parseMegaphoneState } from './megaphoneState';
import { parsePortableMegaphoneState } from './portableMegaphoneState';
import { parseVoiceJammingState } from './voiceJammingState';
import { readRoleStateFile } from './roleStateFile';

export async function readTanukiAddonState(
	pid: number,
	state: Pick<AmongUsState, 'mod' | 'nosAddonIds' | 'gameState'>
): Promise<Partial<AmongUsState>> {
	if (!hasTanukiAddon(state) || !process.env.LOCALAPPDATA) return {};
	const phase = state.gameState;
	const tasks = phase === GameState.TASKS;
	const meeting = phase === GameState.DISCUSSION;
	if (!tasks && !meeting) return {};
	const root = join(process.env.LOCALAPPDATA, 'TanukiBCL', 'NoS');
	const files = [
		['nosBibiriEchoes', tasks || meeting, 'bibiri-echo.json', 16384, parseBibiriEchoState],
		['nosMegaphones', tasks, `megaphone-state-${pid}.json`, 16384, parseMegaphoneState],
		['nosInterviews', tasks || meeting, `interviews-${pid}.json`, 65536, parseInterviewState],
		['nosVoiceJamming', meeting, `voice-jamming-${pid}.json`, 65536, parseVoiceJammingState],
		['nosHeroTransforms', tasks, `hero-transforms-${pid}.json`, 8192, parseHeroTransformState],
		['nosDyingVoices', tasks || meeting, `dying-voice-${pid}.json`, 32768, parseDyingVoiceState],
		['nosPortableMegaphones', tasks, 'portable-megaphone.json', 16384, parsePortableMegaphoneState],
	] as const;
	const texts: (string | undefined)[] = [];
	const reads = files.map(async ([key, enabled, file, limit], index) => {
		if (!enabled) return;
		texts[index] = await readRoleStateFile(
			join(root, file),
			limit,
			key === 'nosMegaphones' ? join(root, 'megaphone-state.json') : undefined
		);
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// A delayed file must not hold up game polling or retain expired effects.
		await Promise.race([
			Promise.all(reads),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 100);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	if (!hasTanukiAddon(state) || state.gameState !== phase) return {};
	const now = Date.now();
	return Object.fromEntries(
		files.map(([key, enabled, , , parse], index) => [key, enabled ? parse(texts[index], pid, now) : undefined])
	);
}
