import React, { Dispatch, SetStateAction, Suspense, lazy, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { ipcRenderer } from 'electron';
import { ThemeProvider, Theme, StyledEngineProvider } from '@mui/material/styles';
import makeStyles from '@mui/styles/makeStyles';
import SettingsIcon from '@mui/icons-material/Settings';
import RefreshSharpIcon from '@mui/icons-material/RefreshSharp';
import CloseIcon from '@mui/icons-material/Close';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import LinearProgress from '@mui/material/LinearProgress';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import prettyBytes from 'pretty-bytes';
import { withNamespaces } from 'react-i18next';
import { AmongUsState } from '../common/AmongUsState';
import {
	AutoUpdaterState,
	IpcHandlerMessages,
	IpcMessages,
	IpcOverlayMessages,
	IpcRendererMessages,
	IpcSyncMessages,
} from '../common/ipc-messages';
import { GameStateContext, HostSettingsContext, PlayerColorContext, SettingsContext } from './contexts';
import SettingsStore, { setLobbySetting, setSetting } from './settings/SettingsStore';
import { ISettings } from '../common/ISettings';
import { defaultLobbySettings } from '../common/defaultLobbySettings';
import Menu from './Menu';
import theme from './theme';
import './css/index.css';
import 'typeface-varela/index.css';
import './language/i18n';

const Voice = lazy(() => import('./Voice'));
const LiteSettings = lazy(() => import('./LiteSettings'));

declare module '@mui/styles/defaultTheme' {
	// eslint-disable-next-line @typescript-eslint/no-empty-interface
	interface DefaultTheme extends Theme {}
}

const litePlayerColors = [
	['#C51111', '#7A0838'],
	['#132ED1', '#09158E'],
	['#117F2D', '#0A4D2E'],
	['#ED54BA', '#AB2BAD'],
	['#EF7D0D', '#B33E15'],
	['#F5F557', '#C38823'],
	['#3F474E', '#1E1F26'],
	['#FFFFFF', '#8394BF'],
	['#6B2FBB', '#3B177C'],
	['#71491E', '#5E2615'],
	['#38FEDC', '#24A8BE'],
	['#50EF39', '#15A742'],
];

let appVersion = '';
if (typeof window !== 'undefined' && window.location) {
	const query = new URLSearchParams(window.location.search.substring(1));
	appVersion = ' v' + query.get('version') || '';
}

const useStyles = makeStyles(() => ({
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
		fontSize: 12,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		padding: '0 28px 0 52px',
		boxSizing: 'border-box',
	},
	button: {
		WebkitAppRegion: 'no-drag',
		marginLeft: 'auto',
		padding: 0,
		position: 'absolute',
		top: 0,
	},
}));

interface TitleBarProps {
	settingsOpen: boolean;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
}

const TitleBar: React.FC<TitleBarProps> = React.memo(function ({ settingsOpen, setSettingsOpen }: TitleBarProps) {
	const classes = useStyles();
	return (
		<div className={classes.root}>
			<span className={classes.title}>BetterCrewLinkKaiLite{appVersion}</span>
			<IconButton
				className={classes.button}
				style={{ left: 0 }}
				size="small"
				onClick={() => setSettingsOpen(!settingsOpen)}
			>
				<SettingsIcon htmlColor="#777" />
			</IconButton>
			<IconButton
				className={classes.button}
				style={{ left: 22 }}
				size="small"
				onClick={() => {
					window.dispatchEvent(new Event('crewlink-save-settings-before-reload'));
					ipcRenderer.send('reload');
				}}
			>
				<RefreshSharpIcon htmlColor="#777" />
			</IconButton>
			<IconButton
				className={classes.button}
				style={{ right: 0 }}
				size="small"
				onClick={() => ipcRenderer.send(IpcMessages.QUIT_CREWLINK)}
			>
				<CloseIcon htmlColor="#777" />
			</IconButton>
		</div>
	);
});

enum AppState {
	MENU,
	VOICE,
}

// @ts-ignore
function LiteApp({ t }): JSX.Element {
	const [state, setState] = useState<AppState>(AppState.MENU);
	const [gameState, setGameState] = useState<AmongUsState>({} as AmongUsState);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [diaOpen, setDiaOpen] = useState(true);
	const [error, setError] = useState('');
	const [updaterState, setUpdaterState] = useState<AutoUpdaterState>({ state: 'unavailable' });
	const playerColors = useRef<string[][]>(litePlayerColors);
	const overlayInitCount = useRef<number>(0);
	const [settings, setSettings] = useState(SettingsStore.store);
	const [hostLobbySettings, setHostLobbySettings] = useState(defaultLobbySettings);

	useEffect(() => {
		SettingsStore.onDidAnyChange((newValue) => {
			setSettings(newValue as ISettings);
		});
	}, []);

	useEffect(() => {
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, playerColors.current);
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_SETTINGS_CHANGED, SettingsStore.store);
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_GAME_STATE_CHANGED, gameState);
	}, [overlayInitCount.current]);

	useEffect(() => {
		let shouldInit = true;
		const onOpen = (_: Electron.IpcRendererEvent, isOpen: boolean) => {
			setState(isOpen ? AppState.VOICE : AppState.MENU);
		};
		const onState = (_: Electron.IpcRendererEvent, newState: AmongUsState) => {
			setGameState(newState);
		};
		const onError = (_: Electron.IpcRendererEvent, newError: string) => {
			shouldInit = false;
			setError(newError);
		};
		const onAutoUpdaterStateChange = (_: Electron.IpcRendererEvent, nextState: AutoUpdaterState) => {
			setUpdaterState((old) => ({ ...old, ...nextState }));
		};
		const onColorsChange = (_: Electron.IpcRendererEvent, colors: string[][]) => {
			playerColors.current = colors;
			ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, colors);
		};
		const onOverlayInit = () => {
			overlayInitCount.current++;
		};

		ipcRenderer
			.invoke(IpcHandlerMessages.START_HOOK)
			.then(() => {
				if (shouldInit) {
					setGameState(ipcRenderer.sendSync(IpcSyncMessages.GET_INITIAL_STATE));
				}
			})
			.catch((hookError: Error) => {
				if (shouldInit) {
					shouldInit = false;
					setError(hookError.message);
				}
			});

		ipcRenderer.on(IpcRendererMessages.AUTO_UPDATER_STATE, onAutoUpdaterStateChange);
		ipcRenderer.on(IpcRendererMessages.NOTIFY_GAME_OPENED, onOpen);
		ipcRenderer.on(IpcRendererMessages.NOTIFY_GAME_STATE_CHANGED, onState);
		ipcRenderer.on(IpcRendererMessages.ERROR, onError);
		ipcRenderer.on(IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, onColorsChange);
		ipcRenderer.on(IpcOverlayMessages.REQUEST_INITVALUES, onOverlayInit);

		return () => {
			ipcRenderer.off(IpcRendererMessages.AUTO_UPDATER_STATE, onAutoUpdaterStateChange);
			ipcRenderer.off(IpcRendererMessages.NOTIFY_GAME_OPENED, onOpen);
			ipcRenderer.off(IpcRendererMessages.NOTIFY_GAME_STATE_CHANGED, onState);
			ipcRenderer.off(IpcRendererMessages.ERROR, onError);
			ipcRenderer.off(IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, onColorsChange);
			shouldInit = false;
		};
	}, []);

	useEffect(() => {
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_GAME_STATE_CHANGED, gameState);
	}, [gameState]);

	useEffect(() => {
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, playerColors.current);
		ipcRenderer.send(IpcMessages.SEND_TO_OVERLAY, IpcOverlayMessages.NOTIFY_SETTINGS_CHANGED, SettingsStore.store);
	}, [settings]);

	const page =
		state === AppState.VOICE ? (
			<Suspense fallback={null}>
				<Voice t={t} error={error} />
			</Suspense>
		) : (
			<Menu t={t} error={error} />
		);

	return (
		<PlayerColorContext.Provider value={playerColors.current}>
			<GameStateContext.Provider value={gameState}>
				<HostSettingsContext.Provider value={[hostLobbySettings, setHostLobbySettings]}>
					<SettingsContext.Provider value={[settings, setSetting, setLobbySetting]}>
						<StyledEngineProvider injectFirst>
							<ThemeProvider theme={theme}>
								<TitleBar settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} />
								{settingsOpen && (
									<Suspense fallback={null}>
										<LiteSettings t={t} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
									</Suspense>
								)}
								<Dialog fullWidth open={updaterState.state !== 'unavailable' && diaOpen}>
									{updaterState.state === 'available' && updaterState.info && (
										<DialogTitle>アップデート v{updaterState.info.version}</DialogTitle>
									)}
									{updaterState.state === 'error' && <DialogTitle>アップデートエラー</DialogTitle>}
									{updaterState.state === 'downloading' && <DialogTitle>アップデート中...</DialogTitle>}
									<DialogContent>
										{updaterState.state === 'downloading' && updaterState.progress && (
											<>
												<LinearProgress variant="determinate" value={updaterState.progress.percent} />
												<DialogContentText>
													{prettyBytes(updaterState.progress.transferred)} / {prettyBytes(updaterState.progress.total)}
												</DialogContentText>
											</>
										)}
										{updaterState.state === 'available' && (
											<>
												<LinearProgress variant="indeterminate" />
												<DialogContentText>新しいバージョンがあります。今すぐアップデートしますか？</DialogContentText>
											</>
										)}
										{updaterState.state === 'error' && (
											<DialogContentText color="error">{String(updaterState.error)}</DialogContentText>
										)}
									</DialogContent>
									{updaterState.state === 'error' && (
										<DialogActions>
											<Button color="grey" onClick={() => setDiaOpen(false)}>
												閉じる
											</Button>
										</DialogActions>
									)}
									{updaterState.state === 'available' && (
										<DialogActions>
											<Button onClick={() => ipcRenderer.send('update-app')}>今すぐ</Button>
											<Button onClick={() => setDiaOpen(false)}>あとで</Button>
										</DialogActions>
									)}
								</Dialog>
								{!settingsOpen && page}
							</ThemeProvider>
						</StyledEngineProvider>
					</SettingsContext.Provider>
				</HostSettingsContext.Provider>
			</GameStateContext.Provider>
		</PlayerColorContext.Provider>
	);
}

// @ts-ignore
const App2 = withNamespaces()(LiteApp);
// @ts-ignore
ReactDOM.render(<App2 />, document.getElementById('app'));
