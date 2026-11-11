import React, { useState, useEffect } from 'react';
// @ts-ignore
import chime from '../../../static/sounds/chime.mp3';
import { ExtendedAudioElement } from '../voice/types';
import Button from '@mui/material/Button';
import { ipcRenderer, isNativeVoice } from '../lib/electron-bridge';

interface TestSpeakersProps {
	t: (key: string) => string;
	speaker: string;
}

const useStyles = () => ({
	button: {
		width: 'fit-content',
		alignSelf: 'flex-end',
	},
});

const audio = new Audio() as ExtendedAudioElement;
audio.src = chime;

const TestSpeakersButton: React.FC<TestSpeakersProps> = ({ t, speaker }: TestSpeakersProps) => {
	const classes = useStyles();
	const [playing, setPlaying] = useState(false);

	useEffect(() => {
		if (isNativeVoice)
			return () => {
				void ipcRenderer.invoke('native:voice:speaker-test', false);
			};
		if (speaker.toLowerCase() !== 'default') audio.setSinkId(speaker);
		audio.onended = () => {
			setPlaying(false);
		};
		return () => {
			audio.pause();
			audio.currentTime = 0;
			setPlaying(false);
		};
	}, [speaker]);

	const testSpeakers = () => {
		if (isNativeVoice) {
			void ipcRenderer.invoke('native:voice:speaker-test', !playing).then(() => setPlaying(!playing));
			return;
		}
		if (playing) {
			audio.pause();
			audio.currentTime = 0;
			setPlaying(false);
		} else {
			audio.play();
			setPlaying(true);
		}
	};
	useEffect(() => {
		if (!isNativeVoice || !playing) return;
		const timer = setTimeout(() => setPlaying(false), 4000);
		return () => clearTimeout(timer);
	}, [playing]);

	return (
		<Button variant="contained" color="secondary" size="small" sx={classes.button} onClick={testSpeakers}>
			{playing ? t('settings.audio.test_speaker_stop') : t('settings.audio.test_speaker_start')}
		</Button>
	);
};

export default TestSpeakersButton;
