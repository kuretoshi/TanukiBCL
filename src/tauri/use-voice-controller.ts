import { useEffect, useSyncExternalStore } from 'react';
import { VoiceController } from '../renderer/voice/VoiceController';
import type { VoiceSnapshot } from '../renderer/voice/types';
import { NativeVoiceController } from './native-voice-controller';

// Keep the pinned Electron controller intact. Native mode never constructs it
// (and therefore never opens a browser microphone, AudioContext or WebRTC peer).
export const voiceController =
	new URLSearchParams(location.search).get('nativeVoice') === '1' ? new NativeVoiceController() : new VoiceController();

export function useVoiceSnapshot(): VoiceSnapshot {
	return useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
}

export function useVoiceEngine() {
	useEffect(() => {
		void voiceController.start();
		return () => voiceController.stop();
	}, []);
	return { voice: useVoiceSnapshot(), controller: voiceController };
}
