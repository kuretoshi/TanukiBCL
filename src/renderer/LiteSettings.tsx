import React, { useContext, useEffect, useReducer, useState } from 'react';
import { ipcRenderer } from 'electron';
import makeStyles from '@mui/styles/makeStyles';
import {
	Box,
	Button,
	Checkbox,
	FormControlLabel,
	Grid,
	Radio,
	RadioGroup,
	Slider,
	TextField,
	Typography,
} from '@mui/material';
import ChevronLeft from '@mui/icons-material/ArrowBack';
import IconButton from '@mui/material/IconButton';
import MuiDivider from '@mui/material/Divider';
import withStyles from '@mui/styles/withStyles';
import i18next from 'i18next';
import { SettingsContext } from './contexts';
import languages from './language/languages';
import SettingsStore, { pushToTalkOptions } from './settings/SettingsStore';
import MicrophoneSoundBar from './settings/MicrophoneSoundBar';
import ServerURLInput from './settings/ServerURLInput';
import TestSpeakersButton from './settings/TestSpeakersButton';
import TestVoiceEffectButton from './settings/TestVoiceEffectButton';

const Divider = withStyles((theme) => ({
	root: {
		width: '100%',
		marginTop: theme.spacing(1.25),
		marginBottom: theme.spacing(1.25),
	},
}))(MuiDivider);

const useStyles = makeStyles((theme) => ({
	root: {
		width: '100%',
		height: `calc(100vh - ${theme.spacing(3)})`,
		background: '#171717',
		position: 'absolute',
		left: 0,
		top: 0,
		zIndex: 99,
		marginTop: theme.spacing(3),
		WebkitAppRegion: 'no-drag',
		boxSizing: 'border-box',
		overflowX: 'hidden',
		isolation: 'isolate',
		WebkitFontSmoothing: 'antialiased',
		textRendering: 'geometricPrecision',
	},
	header: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		height: 34,
	},
	scroll: {
		paddingTop: theme.spacing(0.75),
		paddingLeft: theme.spacing(1.5),
		paddingRight: theme.spacing(1.5),
		overflowY: 'auto',
		overflowX: 'hidden',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		paddingBottom: theme.spacing(7),
		height: `calc(100vh - 34px - ${theme.spacing(7 + 3 + 3)})`,
		'& > div': {
			width: '100%',
			boxSizing: 'border-box',
		},
		'& h6': {
			fontSize: 17,
			lineHeight: '22px',
			fontWeight: 700,
			marginTop: theme.spacing(0.5),
			marginBottom: theme.spacing(0.5),
		},
		'& p, & label, & .MuiTypography-body1': {
			fontSize: 13,
			lineHeight: 1.25,
		},
		'& .MuiFormControlLabel-root': {
			minHeight: 34,
		},
		'& .MuiCheckbox-root, & .MuiRadio-root': {
			padding: 6,
		},
		'& .MuiButton-root': {
			fontSize: 13,
			lineHeight: 1.25,
		},
		'& .MuiTextField-root': {
			marginTop: theme.spacing(1),
			marginBottom: theme.spacing(0.5),
		},
		'& .MuiOutlinedInput-root': {
			minHeight: 48,
			alignItems: 'center',
		},
		'& .MuiOutlinedInput-input': {
			paddingTop: 13,
			paddingBottom: 12,
			lineHeight: '18px',
			boxSizing: 'border-box',
		},
		'& .MuiInputBase-root': {
			fontSize: 12,
		},
		'& .MuiNativeSelect-select, & select.MuiNativeSelect-select': {
			height: 'auto',
			minHeight: 18,
			lineHeight: '18px',
			paddingTop: 13,
			paddingBottom: 12,
			paddingLeft: 12,
			paddingRight: 32,
			boxSizing: 'content-box',
		},
		'& .MuiInputLabel-root': {
			fontSize: 12,
		},
		'& .MuiInputLabel-outlined': {
			transform: 'translate(12px, -8px) scale(0.86)',
			backgroundColor: '#171717',
			paddingLeft: 3,
			paddingRight: 3,
			lineHeight: '16px',
		},
		'& .MuiInputLabel-shrink': {
			transform: 'translate(12px, -8px) scale(0.86)',
		},
		'& legend': {
			fontSize: '0.72em',
		},
		'& select': {
			fontSize: 12,
		},
		'& .MuiTouchRipple-root': {
			display: 'none',
		},
		'& .MuiButtonBase-root, & .MuiButtonBase-root *, & .MuiInputBase-root, & .MuiInputBase-root *, & .MuiInputLabel-root, & .MuiOutlinedInput-notchedOutline': {
			transition: 'none !important',
			animation: 'none !important',
		},
		'& .MuiButtonBase-root, & .MuiInputBase-root, & .MuiInputLabel-root, & .MuiTypography-root': {
			WebkitFontSmoothing: 'antialiased',
			backfaceVisibility: 'hidden',
			transform: 'translateZ(0)',
		},
	},
	backButton: {
		position: 'absolute',
		left: 0,
		top: 0,
	},
	shortcutField: {
		marginTop: theme.spacing(1),
	},
	dialog: {
		marginTop: theme.spacing(1),
	},
	serverButton: {
		display: 'flex',
		justifyContent: 'center',
		width: '100%',
		marginTop: theme.spacing(0.75),
		marginBottom: theme.spacing(0.75),
	},
	centerControl: {
		display: 'flex',
		justifyContent: 'center',
		width: '100%',
		marginTop: theme.spacing(0.5),
		marginBottom: theme.spacing(0.5),
	},
	row: {
		width: '100%',
		marginBottom: theme.spacing(0.75),
	},
	sliderLabel: {
		marginTop: theme.spacing(0.5),
	},
}));

interface LiteSettingsProps {
	t: (key: string) => string;
	open: boolean;
	onClose: () => void;
}

const shortcutFields = [
	['pushToTalkShortcut', 'settings.keyboard.push_to_talk'],
	['impostorRadioShortcut', 'settings.keyboard.impostor_radio'],
	['muteShortcut', 'settings.keyboard.mute'],
	['deafenShortcut', 'settings.keyboard.deafen'],
] as const;

interface MediaDeviceOption {
	id: string;
	label: string;
	kind: MediaDeviceKind;
}

function getShortcut(ev: React.KeyboardEvent | React.MouseEvent) {
	const keyEvent = ev as React.KeyboardEvent;
	const mouseEvent = ev as React.MouseEvent;
	if ('key' in keyEvent && keyEvent.key) {
		const key = keyEvent.key.length === 1 ? keyEvent.key.toUpperCase() : keyEvent.key;
		return key;
	}
	if ('button' in mouseEvent) {
		return `Mouse${mouseEvent.button}`;
	}
	return '';
}

const LiteSettings: React.FC<LiteSettingsProps> = function ({ t, open, onClose }: LiteSettingsProps) {
	const classes = useStyles();
	const [settings, setSettings] = useContext(SettingsContext);
	const [_, updateDevices] = useReducer((state) => state + 1, 0);
	const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

	useEffect(() => {
		i18next.changeLanguage(settings.language);
	}, [settings.language]);

	useEffect(() => {
		navigator.mediaDevices
			?.enumerateDevices()
			.then((nextDevices) => setDevices(nextDevices))
			.catch(() => setDevices([]));
	}, [_]);

	useEffect(() => {
		ipcRenderer.send('setAlwaysOnTop', settings.alwaysOnTop);
	}, [settings.alwaysOnTop]);

	useEffect(() => {
		ipcRenderer.send('enableOverlay', settings.enableOverlay);
	}, [settings.enableOverlay]);

	const resetDefaults = () => {
		SettingsStore.clear();
		ipcRenderer.send('relaunch');
	};

	const mapDevice = (device: MediaDeviceInfo): MediaDeviceOption => {
		let label = device.label;
		if (device.deviceId === 'default') {
			label = t('buttons.default');
		} else {
			const match = /.+?\([^(]+\)/.exec(device.label);
			if (match && match[0]) {
				label = match[0];
			}
		}
		return {
			id: device.deviceId,
			kind: device.kind,
			label: label || device.deviceId,
		};
	};
	const microphones = devices.filter((device) => device.kind === 'audioinput').map(mapDevice);
	const speakers = devices.filter((device) => device.kind === 'audiooutput').map(mapDevice);
	const microphoneOptions =
		microphones.length > 0 ? microphones : [{ id: 'Default', label: 'Default', kind: 'audioinput' as MediaDeviceKind }];
	const speakerOptions =
		speakers.length > 0 ? speakers : [{ id: 'Default', label: 'Default', kind: 'audiooutput' as MediaDeviceKind }];

	if (!open) {
		return <></>;
	}

	return (
		<Box className={classes.root}>
			<div className={classes.header}>
				<IconButton className={classes.backButton} size="small" onClick={onClose}>
					<ChevronLeft htmlColor="#777" />
				</IconButton>
				<Typography variant="h6">{t('settings.title')}</Typography>
			</div>
			<div className={classes.scroll}>
				<Typography variant="h6">{t('settings.audio.title')}</Typography>
				<div>
					<TextField
						fullWidth
						select
						label={t('settings.audio.microphone')}
						variant="outlined"
						color="secondary"
						value={settings.microphone}
						className={classes.shortcutField}
						SelectProps={{ native: true }}
						InputLabelProps={{ shrink: true }}
						onChange={(ev) => setSettings('microphone', ev.target.value)}
						onClick={updateDevices}
					>
						{microphoneOptions.map((device) => (
							<option key={device.id} value={device.id}>
								{device.label}
							</option>
						))}
					</TextField>
					{open && <MicrophoneSoundBar microphone={settings.microphone} />}
					<TextField
						fullWidth
						select
						label={t('settings.audio.speaker')}
						variant="outlined"
						color="secondary"
						value={settings.speaker}
						className={classes.shortcutField}
						SelectProps={{ native: true }}
						InputLabelProps={{ shrink: true }}
						onChange={(ev) => setSettings('speaker', ev.target.value)}
						onClick={updateDevices}
					>
						{speakerOptions.map((device) => (
							<option key={device.id} value={device.id}>
								{device.label}
							</option>
						))}
					</TextField>
					<div className={classes.centerControl}>
						<TestSpeakersButton t={t} speaker={settings.speaker} />
					</div>
					<Typography className={classes.sliderLabel}>{t('settings.audio.voice_effect_strength')}: {settings.voiceEffectStrength}%</Typography>
					<Slider
						size="small"
						value={settings.voiceEffectStrength}
						valueLabelDisplay="auto"
						min={0}
						max={100}
						step={5}
						onChange={(_, newValue: number | number[]) => setSettings('voiceEffectStrength', newValue as number)}
					/>
					<div className={classes.centerControl}>
						<TestVoiceEffectButton
							t={t}
							microphone={settings.microphone}
							speaker={settings.speaker}
							voiceEffectStrength={settings.voiceEffectStrength}
						/>
					</div>
					<RadioGroup
						value={settings.pushToTalkMode}
						onChange={(ev) => setSettings('pushToTalkMode', Number(ev.target.value))}
					>
						<FormControlLabel value={pushToTalkOptions.VOICE} control={<Radio />} label={t('settings.audio.voice_activity')} />
						<FormControlLabel value={pushToTalkOptions.PUSH_TO_TALK} control={<Radio />} label={t('settings.audio.push_to_talk')} />
						<FormControlLabel value={pushToTalkOptions.PUSH_TO_MUTE} control={<Radio />} label={t('settings.audio.push_to_mute')} />
					</RadioGroup>
					<Typography className={classes.sliderLabel}>{t('settings.audio.microphone_volume')}</Typography>
					<Grid container spacing={1} alignItems="center">
						<Grid item xs={2}>
							<Checkbox
								checked={settings.microphoneGainEnabled}
								onChange={(_, checked: boolean) => setSettings('microphoneGainEnabled', checked)}
							/>
						</Grid>
						<Grid item xs={10}>
							<Slider
								size="small"
								disabled={!settings.microphoneGainEnabled}
								value={settings.microphoneGain}
								valueLabelDisplay="auto"
								min={0}
								max={300}
								step={2}
								onChange={(_, newValue: number | number[]) => setSettings('microphoneGain', newValue as number)}
							/>
						</Grid>
					</Grid>
					<Typography className={classes.sliderLabel}>{t('settings.audio.microphone_sens')}</Typography>
					<Grid container spacing={1} alignItems="center">
						<Grid item xs={2}>
							<Checkbox
								checked={settings.micSensitivityEnabled}
								onChange={(_, checked: boolean) => setSettings('micSensitivityEnabled', checked)}
							/>
						</Grid>
						<Grid item xs={10}>
							<Slider
								size="small"
								disabled={!settings.micSensitivityEnabled}
								value={+(1 - settings.micSensitivity).toFixed(2)}
								valueLabelDisplay="auto"
								min={0}
								max={1}
								step={0.05}
								onChange={(_, newValue: number | number[]) => setSettings('micSensitivity', 1 - (newValue as number))}
							/>
						</Grid>
					</Grid>
					<Typography>{t('settings.audio.mastervolume')}: {settings.masterVolume}%</Typography>
					<Slider
						size="small"
						value={settings.masterVolume}
						min={0}
						max={200}
						onChange={(_, newValue: number | number[]) => setSettings('masterVolume', newValue as number)}
					/>
					<Typography>{t('settings.audio.crewvolume')}: {settings.crewVolumeAsGhost}%</Typography>
					<Slider
						size="small"
						value={settings.crewVolumeAsGhost}
						valueLabelDisplay="auto"
						min={0}
						max={100}
						onChange={(_, newValue: number | number[]) => setSettings('crewVolumeAsGhost', newValue as number)}
					/>
					<Typography>{t('settings.audio.ghostvolumeasimpostor')}: {settings.ghostVolumeAsImpostor}%</Typography>
					<Slider
						size="small"
						value={settings.ghostVolumeAsImpostor}
						valueLabelDisplay="auto"
						min={0}
						max={100}
						onChange={(_, newValue: number | number[]) => setSettings('ghostVolumeAsImpostor', newValue as number)}
					/>
				</div>

				<Divider />
				<Typography variant="h6">{t('settings.keyboard.title')}</Typography>
				<Grid container spacing={1}>
					{shortcutFields.map(([field, label]) => (
						<Grid item xs={6} key={field}>
							<TextField
								fullWidth
								spellCheck={false}
								label={t(label)}
								variant="outlined"
								color="secondary"
								value={settings[field]}
								className={classes.shortcutField}
								InputLabelProps={{ shrink: true }}
								onKeyDown={(ev) => {
									ev.preventDefault();
									setSettings(field, getShortcut(ev));
								}}
								onMouseDown={(ev) => {
									if (ev.button === 0) {
										return;
									}
									ev.preventDefault();
									setSettings(field, getShortcut(ev));
								}}
							/>
						</Grid>
					))}
				</Grid>

				<Divider />
				<Typography variant="h6">{t('settings.overlay.title')}</Typography>
				<div>
					<FormControlLabel
						label={t('settings.overlay.always_on_top')}
						checked={settings.alwaysOnTop}
						onChange={(_, checked: boolean) => setSettings('alwaysOnTop', checked)}
						control={<Checkbox />}
					/>
					<FormControlLabel
						label={t('settings.overlay.enabled')}
						checked={settings.enableOverlay}
						onChange={(_, checked: boolean) => setSettings('enableOverlay', checked)}
						control={<Checkbox />}
					/>
					<FormControlLabel
						label={t('settings.overlay.compact')}
						checked={settings.compactOverlay}
						onChange={(_, checked: boolean) => setSettings('compactOverlay', checked)}
						control={<Checkbox />}
					/>
					<FormControlLabel
						label={t('settings.overlay.meeting')}
						checked={settings.meetingOverlay}
						onChange={(_, checked: boolean) => setSettings('meetingOverlay', checked)}
						control={<Checkbox />}
					/>
					<TextField
						fullWidth
						select
						label={t('settings.overlay.pos')}
						variant="outlined"
						color="secondary"
						value={settings.overlayPosition}
						className={classes.shortcutField}
						SelectProps={{ native: true }}
						InputLabelProps={{ shrink: true }}
						onChange={(ev) => setSettings('overlayPosition', ev.target.value)}
					>
						<option value="hidden">{t('settings.overlay.locations.hidden')}</option>
						<option value="top">{t('settings.overlay.locations.top')}</option>
						<option value="bottom_left">{t('settings.overlay.locations.bottom')}</option>
						<option value="right">{t('settings.overlay.locations.right')}</option>
						<option value="right1">{t('settings.overlay.locations.right1')}</option>
						<option value="left">{t('settings.overlay.locations.left')}</option>
						<option value="left1">{t('settings.overlay.locations.left1')}</option>
					</TextField>
				</div>

				<Divider />
				<Typography variant="h6">{t('settings.advanced.title')}</Typography>
				<div>
					<FormControlLabel
						label={t('settings.advanced.nat_fix')}
						checked={settings.natFix}
						onChange={(_, checked: boolean) => setSettings('natFix', checked)}
						control={<Checkbox />}
					/>
					<div className={classes.serverButton}>
						<ServerURLInput
							t={t}
							initialURL={settings.serverURL}
							serverURLs={[settings.serverURL, ...(settings.serverURLs || [])]}
							onSaveURLs={(url, urls) => {
								setSettings('serverURL', url);
								setSettings('serverURLs', urls);
							}}
							className={classes.dialog}
						/>
					</div>
				</div>

				<Divider />
				<Typography variant="h6">{t('settings.language')}</Typography>
				<div>
					<TextField
						fullWidth
						select
						label={t('settings.language')}
						variant="outlined"
						color="secondary"
						value={settings.language}
						className={classes.shortcutField}
						SelectProps={{ native: true }}
						InputLabelProps={{ shrink: true }}
						onChange={(ev) => setSettings('language', ev.target.value)}
					>
						{Object.entries(languages).map(([key, language]) => (
							<option key={key} value={key}>
								{language.name}
							</option>
						))}
					</TextField>
				</div>

				<Divider />
				<Typography variant="h6">{t('settings.streaming.title')}</Typography>
				<div>
					<FormControlLabel
						label={t('settings.streaming.hidecode')}
						checked={!settings.hideCode}
						onChange={(_, checked: boolean) => setSettings('hideCode', !checked)}
						control={<Checkbox />}
					/>
					<FormControlLabel
						label={t('settings.streaming.obs_overlay')}
						checked={settings.obsOverlay}
						onChange={(_, checked: boolean) => {
							setSettings('obsOverlay', checked);
							if (!settings.obsSecret) {
								setSettings('obsSecret', Math.random().toString(36).substr(2, 9).toUpperCase());
							}
						}}
						control={<Checkbox />}
					/>
					<TextField
						fullWidth
						label={t('settings.streaming.obs_url')}
						variant="outlined"
						color="secondary"
						value={`https://kuretoshi.github.io/BetterCrewlink-obs_fix/?compact=${
							settings.compactOverlay ? '1' : '0'
						}&position=${settings.overlayPosition}&meeting=${settings.meetingOverlay ? '1' : '0'}&secret=${
							settings.obsSecret || ''
						}&server=${settings.serverURL}`}
						className={classes.shortcutField}
						InputLabelProps={{ shrink: true }}
						InputProps={{ readOnly: true }}
					/>
				</div>

				<Divider />
				<div className={classes.row}>
					<Button fullWidth variant="outlined" color="secondary" onClick={resetDefaults}>
						{t('settings.troubleshooting.restore')}
					</Button>
				</div>
			</div>
		</Box>
	);
};

export default LiteSettings;
