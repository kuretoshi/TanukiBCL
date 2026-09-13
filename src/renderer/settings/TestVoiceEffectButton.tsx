import React, { useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';

import { ExtendedAudioElement } from '../voice/types';
import {
	createVoiceDisguiseEffect,
	disconnectVoiceDisguiseEffect,
	updateVoiceDisguiseEffect,
	VoiceDisguiseEffect,
} from '../voiceEffect';

interface TestVoiceEffectButtonProps {
	t: (key: string) => string;
	microphone: string;
	speaker: string;
	voiceEffectStrength: number;
}

const TestVoiceEffectButton: React.FC<TestVoiceEffectButtonProps> = ({
	t,
	microphone,
	speaker,
	voiceEffectStrength,
}: TestVoiceEffectButtonProps) => {
	const [playing, setPlaying] = useState(false);
	const cleanupRef = useRef<(() => void) | undefined>(undefined);
	const effectNodesRef = useRef<VoiceDisguiseEffect | undefined>(undefined);
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
			updateVoiceDisguiseEffect(effectNodesRef.current, voiceEffectStrength);
		}
	}, [voiceEffectStrength]);

	const testVoiceEffect = async () => {
		if (playingRef.current) {
			stopTest();
			return;
		}

		stopRequestedRef.current = false;
		playingRef.current = true;
		setPlaying(true);

		try {
			const audioOptions: MediaTrackConstraints & Record<string, unknown> = {
				deviceId: microphone ?? 'default',
				autoGainControl: false,
				echoCancellation: false,
				noiseSuppression: false,
				googEchoCancellation: false,
				googAutoGainControl2: false,
				googNoiseSuppression: false,
				googHighpassFilter: false,
				googTypingNoiseDetection: false,
			};
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: audioOptions,
				video: false,
			});
			if (stopRequestedRef.current) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			const context = new AudioContext();
			const source = context.createMediaStreamSource(stream);
			const destination = context.createMediaStreamDestination();
			const effectNodes = createVoiceDisguiseEffect(context, null, voiceEffectStrength);
			effectNodesRef.current = effectNodes;
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
				disconnectVoiceDisguiseEffect(effectNodes);
				context.close();
			};

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
