import { GameState, type AmongUsState } from '../common/AmongUsState';
import { hasTanukiAddon } from '../common/tanukiAddon';
import { readBibiriEchoState } from './bibiriEchoState';
import { readDyingVoiceState } from './dyingVoiceState';
import { readHeroTransformState } from './heroTransformState';
import { readInterviewState } from './interviewState';
import { readMegaphoneState } from './megaphoneState';
import { readPortableMegaphoneState } from './portableMegaphoneState';
import { readVoiceJammingState } from './voiceJammingState';

export function readTanukiAddonState(
	pid: number,
	state: Pick<AmongUsState, 'mod' | 'nosAddonIds' | 'gameState'>
): Partial<AmongUsState> {
	if (!hasTanukiAddon(state)) return {};
	const tasks = state.gameState === GameState.TASKS;
	const meeting = state.gameState === GameState.DISCUSSION;
	return {
		nosBibiriEchoes: tasks || meeting ? readBibiriEchoState(pid) : undefined,
		nosMegaphones: tasks ? readMegaphoneState(pid) : undefined,
		nosInterviews: tasks || meeting ? readInterviewState(pid) : undefined,
		nosVoiceJamming: meeting ? readVoiceJammingState(pid) : undefined,
		nosHeroTransforms: tasks ? readHeroTransformState(pid) : undefined,
		nosDyingVoices: tasks || meeting ? readDyingVoiceState(pid) : undefined,
		nosPortableMegaphones: tasks ? readPortableMegaphoneState(pid) : undefined,
	};
}
