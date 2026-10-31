import React, { useEffect, useRef, useState } from 'react';
import { captureMicrophone } from '../lib/captureMicrophone';
import Button from '@mui/material/Button';

import { ExtendedAudioElement } from '../voice/types';
import { createVoiceEffectPreview, VoiceEffectPreview } from './voiceEffectPreview';
import type { VoiceEffectId, VoiceEffectTuning } from '../../common/VoiceEffectTuning';

interface TestVoiceEffectButtonProps {
	t: (key: string) => string;
	microphone: string;
	speaker: string;
	tuning: VoiceEffectTuning;
	effectKind?: VoiceEffectId;
}

const TestVoiceEffectButton: React.FC<TestVoiceEffectButtonProps> = ({
	t,
	microphone,
	speaker,
	tuning,
	effectKind = 'disguise',
}: TestVoiceEffectButtonProps) => {
	const [playing, setPlaying] = useState(false);
	const cleanupRef = useRef<(() => void) | undefined>(undefined);
	const effectNodesRef = useRef<VoiceEffectPreview | undefined>(undefined);
	const tuningRef = useRef(tuning);
	tuningRef.current = tuning;
	const playingRef = useRef(false);
	const stopRequestedRef = useRef(false);

	const stopTest = () => {
		stopRequestedRef.current = true;
		cleanupRef.current?.();
		cleanupRef.current = undefined;
		effectNodesRef.current = undefined;
		playingRef.current = false;
		setPlaying(false);
	};

	useEffect(() => stopTest, []);

	useEffect(() => {
		if (effectNodesRef.current) {
			effectNodesRef.current.update(tuning);
		}
	}, [tuning]);

	const testVoiceEffect = async () => {
		if (playingRef.current) {
			stopTest();
			return;
		}

		stopRequestedRef.current = false;
		playingRef.current = true;
		setPlaying(true);
		let pendingStream: MediaStream | undefined;
		let pendingContext: AudioContext | undefined;

		try {
			const audioOptions: MediaTrackConstraints & Record<string, unknown> = {
				autoGainControl: false,
				echoCancellation: false,
				noiseSuppression: false,
				googEchoCancellation: false,
				googAutoGainControl2: false,
				googNoiseSuppression: false,
				googHighpassFilter: false,
				googTypingNoiseDetection: false,
			};
			const { stream } = await captureMicrophone(audioOptions, microphone);
			pendingStream = stream;
			if (stopRequestedRef.current) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			const context = new AudioContext();
			pendingContext = context;
			const source = context.createMediaStreamSource(stream);
			const destination = context.createMediaStreamDestination();
			const effectNodes = await createVoiceEffectPreview(context, effectKind, tuningRef.current);
			if (stopRequestedRef.current) {
				effectNodes.dispose();
				stream.getTracks().forEach((track) => track.stop());
				void context.close();
				return;
			}
			effectNodesRef.current = effectNodes;
			effectNodes.update(tuningRef.current);
			source.connect(effectNodes.input);
			effectNodes.output.connect(destination);
			const audio = document.createElement('audio') as ExtendedAudioElement;
			audio.autoplay = true;
			audio.srcObject = destination.stream;
			document.body.appendChild(audio);

			cleanupRef.current = () => {
				audio.pause();
				audio.remove();
				stream.getTracks().forEach((track) => track.stop());
				source.disconnect();
				effectNodes.dispose();
				void context.close();
			};
			pendingStream = undefined;
			pendingContext = undefined;

			try {
				if (speaker.toLowerCase() !== 'default') {
					await audio.setSinkId(speaker);
				}
			} catch (error) {
				console.warn('failed to use selected speaker for voice effect test, using default output', error);
			}
			if (stopRequestedRef.current) {
				stopTest();
				return;
			}
			await audio.play();
		} catch (error) {
			console.warn('failed to test voice effect', error);
			pendingStream?.getTracks().forEach((track) => track.stop());
			if (pendingContext) void pendingContext.close();
			stopTest();
		}
	};

	return (
		<Button
			variant="contained"
			color="secondary"
			size="small"
			sx={{ width: 240, maxWidth: '100%', minHeight: 40, px: 2, fontSize: 14 }}
			onClick={testVoiceEffect}
		>
			{playing ? t('settings.audio.test_voice_effect_stop') : t('settings.audio.test_voice_effect_start')}
		</Button>
	);
};

export default TestVoiceEffectButton;
