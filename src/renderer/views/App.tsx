import React, { useEffect, useState, useSyncExternalStore } from 'react';
import VoiceView from './VoiceView';
import { isLiteRuntime } from '../../common/appVariant';
import Menu from './Menu';
import { ipcRenderer } from '../lib/electron-bridge';
import SettingsStore, { setSetting, initSettings } from '../settings/SettingsStore';
import { GameStateContext, SettingsContext, PlayerColorContext } from '../state/contexts';
import { gameStore, startGameStore } from '../state/gameStore';
import { startOverlayBridge } from '../state/overlayBridge';
import { startSettingsWindowBridge } from '../state/settingsWindowBridge';
import { useLanguage } from '../language/useLanguage';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import Box from '@mui/material/Box';
import { IpcHandlerMessages, IpcMessages } from '../../common/ipc-messages';
import theme from '../lib/theme';
import SettingsIcon from '@mui/icons-material/Settings';
import RefreshSharpIcon from '@mui/icons-material/RefreshSharp';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import { createRoot } from 'react-dom/client';
import '../css/index.css';
import 'source-code-pro/source-code-pro.css';
import 'typeface-varela/index.css';
import '../language/i18n';
import { withTranslation, WithTranslation } from 'react-i18next';
import { ISettings } from '../../common/ISettings';

let appVersion = '';
if (typeof window !== 'undefined' && window.location) {
	const query = new URLSearchParams(window.location.search.substring(1));
	appVersion = ' v' + query.get('version') || '';
}

const useStyles = () => ({
	root: {
		position: 'absolute',
		width: '100vw',
		height: theme.spacing(3),
		backgroundColor: '#1d1a23',
		top: 0,
		WebkitAppRegion: 'drag',
		zIndex: 100,
	},
	title: {
		width: '100%',
		textAlign: 'center',
		display: 'block',
		height: theme.spacing(3),
		lineHeight: theme.spacing(3),
		color: theme.palette.primary.main,
	},
	button: {
		WebkitAppRegion: 'no-drag',
		marginLeft: 'auto',
		padding: 0,
		position: 'absolute',
		top: 0,
	},
});

const RawTitleBar: React.FC = function () {
	const classes = useStyles();
	return (
		<Box sx={classes.root}>
			<Box component="span" sx={classes.title} style={{ marginLeft: 10 }}>
				{isLiteRuntime() ? 'タヌキのベタクルLite' : 'タヌキのベタクル'}
				{appVersion}
			</Box>
			<IconButton
				sx={classes.button}
				style={{ left: 0 }}
				size="small"
				onClick={() => ipcRenderer.send(IpcHandlerMessages.OPEN_SETTINGS)}
			>
				<SettingsIcon htmlColor="#777" />
			</IconButton>
			<IconButton sx={classes.button} style={{ left: 22 }} size="small" onClick={() => ipcRenderer.send('reload')}>
				<RefreshSharpIcon htmlColor="#777" />
			</IconButton>
			<IconButton
				sx={classes.button}
				style={{ right: 0 }}
				size="small"
				onClick={() => ipcRenderer.send(IpcMessages.QUIT_CREWLINK)}
			>
				<CloseIcon htmlColor="#777" />
			</IconButton>
		</Box>
	);
};

const TitleBar = React.memo(RawTitleBar);

export default function App({ t }: WithTranslation): React.JSX.Element {
	const [settings, setSettings] = useState<ISettings>({} as ISettings);
	const [settingsLoaded, setSettingsLoaded] = useState(false);

	const { gameState, gameOpen, playerColors, error } = useSyncExternalStore(gameStore.subscribe, gameStore.getSnapshot);

	useEffect(() => {
		const onSettingsChanged = (newValue: ISettings) => setSettings(newValue);
		SettingsStore.onDidAnyChange(onSettingsChanged);
		initSettings()
			.then((s) => {
				setSettings(s);
				setSettingsLoaded(true);
			})
			.catch(() => setSettingsLoaded(true));
		return () => SettingsStore.offDidAnyChange(onSettingsChanged);
	}, []);

	useEffect(() => {
		if (!settingsLoaded) return;
		startGameStore();
		startOverlayBridge();
		startSettingsWindowBridge();
	}, [settingsLoaded]);

	useEffect(() => {
		if (!settingsLoaded) return;
		ipcRenderer.send('setAlwaysOnTop', settings.alwaysOnTop);
	}, [settingsLoaded, settings.alwaysOnTop]);

	useEffect(() => {
		if (!settingsLoaded) return;
		ipcRenderer.send('enableOverlay', settings.enableOverlay);
	}, [settingsLoaded, settings.enableOverlay]);

	useLanguage(settings.language, true);

	if (!settingsLoaded) return null;

	return (
		<PlayerColorContext.Provider value={playerColors}>
			<GameStateContext.Provider value={gameState}>
				<SettingsContext.Provider value={[settings, setSetting]}>
					<StyledEngineProvider injectFirst>
						<ThemeProvider theme={theme}>
							<TitleBar />

							{gameOpen ? <VoiceView t={t} error={error} /> : <Menu t={t} error={error} />}
						</ThemeProvider>
					</StyledEngineProvider>
				</SettingsContext.Provider>
			</GameStateContext.Provider>
		</PlayerColorContext.Provider>
	);
}

const App2 = withTranslation()(App);
createRoot(document.getElementById('app')!).render(<App2 />);
