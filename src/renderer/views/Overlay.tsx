import React, { useEffect, useMemo, useState, CSSProperties } from 'react';
import { ipcRenderer } from '../lib/electron-bridge';
import { AmongUsState, GameState, VoiceState } from '../../common/AmongUsState';
import { IpcOverlayMessages, IpcMessages } from '../../common/ipc-messages';
import { createRoot } from 'react-dom/client';
import Box from '@mui/material/Box';
import '../css/overlay.css';
import Avatar from '../components/Avatar';
import { ISettings } from '../../common/ISettings';
import { DEFAULT_PLAYERCOLORS } from '../../common/playerColors';
import { nosColorHex } from '../../common/NosSnapshot';
import { modList } from '../../common/Mods';
import { snrMeetingPage } from '../../common/SnrMeeting';
import { reconcileMeetingPlayers, sortMeetingPlayers } from '../../common/meetingOrder';

interface UseStylesProps {
	height: number;
	width: number;
	oldHud: boolean;
}

export interface playerContainerCss extends CSSProperties {
	'--size': string;
}

const useStyles = (props: UseStylesProps) => ({
	meetingHud: {
		position: 'absolute',
		top: '50%',
		left: '50%',
		width: props.width,
		height: props.height,
		transform: 'translate(-50%, -50%)',
	},
	tabletContainer: {
		width: props.oldHud ? '88.45%' : '100%',
		height: '10.5%',
		left: props.oldHud ? '4.7%' : '0.4%',
		top: props.oldHud ? '18.4703%' : '15%',
		position: 'absolute',
		display: 'flex',
		flexWrap: 'wrap',
	},
	playerContainer: {
		width: props.oldHud ? '46.41%' : '30%',
		height: props.oldHud ? '100%' : '109%',
		borderRadius: `${props.height / 100}px`,
		transition: 'opacity .1s linear',
		marginBottom: props.oldHud ? '2%' : '1.9%',
		marginRight: props.oldHud ? '2.34%' : '0.23%',
		marginLeft: props.oldHud ? '0%' : '2.4%',
		boxSizing: 'border-box',
	},
});

function nosMeetingPlayerStyle(
	width: number,
	height: number,
	viewportWidth: number,
	viewportHeight: number,
	count: number,
	index: number
) {
	// NoS More15Helpers scales vote areas about their centers and changes the grid at 16/19 players.
	const columns = count <= 18 ? 3 : 4;
	const scale = count <= 18 ? 0.95 : 0.76;
	// UI camera half-height 3; MeetingHud's AspectSize fits its 8.54 * 1.2-wide background on narrow screens.
	const unit = Math.min(viewportHeight / 6, viewportWidth / (8.54 * 1.2));
	// MeetingHud prefab: VoteOrigin(-3.1, 1.5), ButtonParent(+0.25, 0), sliced background(2.7, 0.63).
	const originX = -3.1 + 0.25 + (count <= 18 ? 0.1 : -0.355);
	const originY = 1.5 + (count <= 18 ? 0.145 : 0);
	const cardWidth = 2.7 * scale * unit;
	const cardHeight = 0.63 * scale * unit;
	const columnStep = 2.9 * scale * (count <= 18 ? 1 : 0.974);
	const rowStep = 0.76 * scale * (count <= 18 ? 0.89 : 1);
	return {
		position: 'absolute',
		width: cardWidth,
		height: cardHeight,
		left: width / 2 + (originX + (index % columns) * columnStep) * unit - cardWidth / 2,
		top: height / 2 - (originY - Math.floor(index / columns) * rowStep) * unit - cardHeight / 2,
		margin: 0,
	};
}

function useWindowSize() {
	const [windowSize, setWindowSize] = useState<[number, number]>([0, 0]);

	useEffect(() => {
		const onResize = () => {
			setWindowSize([window.innerWidth, window.innerHeight]);
		};
		window.addEventListener('resize', onResize);
		onResize();

		return () => window.removeEventListener('resize', onResize);
	}, []);
	return windowSize;
}

const iPadRatio = 854 / 579;

const Overlay: React.FC = function () {
	const [gameState, setGameState] = useState<AmongUsState>(undefined as unknown as AmongUsState);
	const [voiceState, setVoiceState] = useState<VoiceState>(undefined as unknown as VoiceState);
	const [settings, setSettings] = useState<ISettings>(undefined as unknown as ISettings);
	const [playerColors, setColors] = useState<string[][]>(DEFAULT_PLAYERCOLORS);
	useEffect(() => {
		const onState = (_: unknown, newState: AmongUsState) => {
			setGameState(newState);
		};
		const onVoiceState = (_: unknown, newState: VoiceState) => {
			setVoiceState(newState);
		};
		const onSettings = (_: unknown, newState: ISettings) => {
			setSettings(newState);
		};
		const onColorChange = (_: unknown, colors: string[][]) => {
			setColors(colors);
		};
		ipcRenderer.on(IpcOverlayMessages.NOTIFY_GAME_STATE_CHANGED, onState);
		ipcRenderer.on(IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, onVoiceState);
		ipcRenderer.on(IpcOverlayMessages.NOTIFY_SETTINGS_CHANGED, onSettings);
		ipcRenderer.on(IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, onColorChange);
		ipcRenderer.send(IpcMessages.SEND_TO_MAINWINDOW, IpcOverlayMessages.REQUEST_INITVALUES);
		return () => {
			ipcRenderer.off(IpcOverlayMessages.NOTIFY_GAME_STATE_CHANGED, onState);
			ipcRenderer.off(IpcOverlayMessages.NOTIFY_VOICE_STATE_CHANGED, onVoiceState);
			ipcRenderer.off(IpcOverlayMessages.NOTIFY_SETTINGS_CHANGED, onSettings);
			ipcRenderer.off(IpcOverlayMessages.NOTIFY_PLAYERCOLORS_CHANGED, onColorChange);
		};
	}, []);

	if (!settings || !voiceState || !gameState || !settings.enableOverlay || gameState.gameState == GameState.MENU)
		return null;
	return (
		<>
			<OverlayWatermark
				serverURL={settings.serverURL}
				lowered={gameState.mod === 'SUPER_NEW_ROLES'}
				inGame={gameState.gameState === GameState.TASKS}
				mod={gameState.mod}
				nosReadFailed={gameState.nosReadStatus?.failed}
				nosReadMessage={gameState.nosReadStatus?.message}
			/>
			{settings.meetingOverlay && gameState.gameState === GameState.DISCUSSION && (
				<MeetingHud gameState={gameState} voiceState={voiceState} playerColors={playerColors} />
			)}
			{settings.overlayPosition !== 'hidden' && (
				<AvatarOverlay
					playerColors={playerColors}
					voiceState={voiceState}
					gameState={gameState}
					position={settings.overlayPosition}
					compactOverlay={settings.compactOverlay}
				/>
			)}
		</>
	);
};

const overlayVersion = new URLSearchParams(window.location.search).get('version') || 'DEV';

interface OverlayWatermarkProps {
	serverURL: string;
	lowered: boolean;
	inGame: boolean;
	mod: AmongUsState['mod'];
	nosReadFailed?: boolean;
	nosReadMessage?: string;
}

const OverlayWatermark: React.FC<OverlayWatermarkProps> = ({
	serverURL,
	lowered,
	inGame,
	mod,
	nosReadFailed,
	nosReadMessage,
}: OverlayWatermarkProps) => {
	const isNoS = mod === 'NoS';
	const modName =
		mod === 'NONE'
			? ''
			: mod === 'SUPER_NEW_ROLES'
				? 'SuperNewRoles'
				: mod === 'TOH4E'
					? 'TOH4E'
					: mod === 'NoS'
						? 'NoS'
						: (modList.find((candidate) => candidate.id === mod)?.label ?? mod);

	return (
		<div
			title={isNoS ? nosReadMessage : undefined}
			style={
				isNoS && nosReadFailed
					? { backgroundColor: '#581e24', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 360 }
					: undefined
			}
			className={`tanuki-overlay-watermark${lowered ? ' tanuki-overlay-watermark_snr' : ''}${
				inGame ? ' tanuki-overlay-watermark_game' : ''
			}${isNoS ? ' tanuki-overlay-watermark_nos' : ''}`}
		>
			<div>
				TanukiBCL v{overlayVersion}
				{modName && ` [${modName}]`}
			</div>
			<div>{serverURL}</div>
			{isNoS && nosReadFailed && <div role="status">{nosReadMessage}</div>}
		</div>
	);
};

interface AvatarOverlayProps {
	playerColors: string[][];
	voiceState: VoiceState;
	gameState: AmongUsState;
	position: ISettings['overlayPosition'];
	compactOverlay: boolean;
}

const AvatarOverlay: React.FC<AvatarOverlayProps> = ({
	playerColors,
	voiceState,
	gameState,
	position,
	compactOverlay,
}: AvatarOverlayProps) => {
	const players = useMemo(() => {
		if (!gameState.players) return null;
		return gameState.players
			.filter((o) => !voiceState.localIsAlive || !(voiceState.otherDead[o.clientId] && !o.isLocal))
			.slice()
			.sort((a, b) => {
				if (
					(a.disconnected || voiceState.otherDead[a.clientId]) &&
					(b.disconnected || voiceState.otherDead[b.clientId])
				) {
					return a.id - b.id;
				} else if (a.disconnected || voiceState.otherDead[a.clientId]) {
					return 1000;
				} else if (b.disconnected || voiceState.otherDead[b.clientId]) {
					return -1000;
				}
				return a.id - b.id;
			});
	}, [gameState.players, voiceState.localIsAlive, voiceState.otherDead]);

	if (!gameState.players) return null;

	const positionParse = position.replace('1', '');

	const avatars: React.JSX.Element[] = [];
	const isOnSide = positionParse == 'right' || positionParse == 'left';
	const showName =
		!gameState.mixupSabotaged &&
		!gameState.camouflaged &&
		isOnSide &&
		(!compactOverlay || position === 'right1' || position === 'left1');
	const classnames: string[] = ['overlay-wrapper'];
	if (gameState.gameState == GameState.UNKNOWN || gameState.gameState == GameState.MENU) {
		classnames.push('gamestate_menu');
	} else {
		classnames.push('gamestate_game');
		classnames.push('overlay_postion_' + positionParse);
		if (compactOverlay || position === 'right1' || position === 'left1') {
			classnames.push('compactoverlay');
		}
		if (position === 'left1' || position === 'right1') {
			classnames.push('overlay_postion_' + position);
		}
	}

	players?.forEach((player) => {
		const vadHidden = player.shiftedColor !== -1 && gameState.gameState !== GameState.DISCUSSION;
		const voiceActivity =
			(!vadHidden || player.isLocal) &&
			(voiceState.otherTalking[player.clientId] || (player.isLocal && voiceState.localTalking));
		if (!voiceActivity && compactOverlay) {
			return;
		}
		const peer = voiceState.playerSocketIds[player.clientId];
		const connected = voiceState.socketClients[peer]?.clientId === player.clientId;
		if (!connected && !player.isLocal) {
			return;
		}
		const talking = voiceActivity && !player.inVent;
		// const audio = voiceState.audioConnected[peer];
		avatars.push(
			<div key={player.id} className="player_wrapper">
				<div>
					<Avatar
						colorPalette={
							playerColors[
								player.currentOutfit > 0 && player.currentOutfit <= 10 && player.appearanceColorId >= 0
									? player.appearanceColorId
									: player.colorId
							]
						}
						key={player.id}
						// connectionState={!connected ? 'disconnected' : audio ? 'connected' : 'novoice'}
						player={player}
						showborder={isOnSide && !compactOverlay}
						muted={voiceState.muted && player.isLocal}
						deafened={voiceState.deafened && player.isLocal}
						connectionState={'connected'}
						talking={talking}
						borderColor={player.isLocal && vadHidden ? 'gray' : '#2ecc71'}
						isUsingRadio={
							voiceState.impostorRadioClientIds?.includes(player.clientId) ??
							voiceState.impostorRadioClientId == player.clientId
						}
						isAlive={!voiceState.otherDead[player.clientId] || (player.isLocal && !player.isDead)}
						size={100}
						lookLeft={!(positionParse === 'left' || positionParse === 'bottom_left')}
						showHat={true}
						mod={gameState.mod}
					/>
				</div>
				{showName && (
					<span
						className="playername"
						style={{
							opacity: (position === 'right1' || position === 'left1') && !talking ? 0 : 1,
						}}
					>
						<small>{player.appearanceName || player.name}</small>
					</span>
				)}
			</div>
		);
	});
	if (avatars.length === 0) return null;
	const playerContainerStyle = { '--size': 7.5 * (10 / avatars.length) + 'vh' } as playerContainerCss;
	return (
		<div>
			<div className={classnames.join(' ')} style={playerContainerStyle}>
				<div className="otherplayers">
					<div className="players_container playerContainerBack">{avatars}</div>
				</div>
			</div>
			{/* {(voiceState.muted || voiceState.deafened) && (
				<div className="volumeicons">{voiceState.deafened ? <VolumeOff /> : <MicOff />}</div>
			)} */}
		</div>
	);
};

interface MeetingHudProps {
	gameState: AmongUsState;
	voiceState: VoiceState;
	playerColors: string[][];
}

const MeetingHud: React.FC<MeetingHudProps> = ({ voiceState, gameState, playerColors }: MeetingHudProps) => {
	const [windowWidth, windowheight] = useWindowSize();
	const [width, height] = useMemo(() => {
		if (gameState.oldMeetingHud) {
			let hudWidth = 0,
				hudHeight = 0;
			if (windowWidth / (windowheight * 0.96) > iPadRatio) {
				hudHeight = windowWidth * 0.96;
				hudWidth = hudHeight * iPadRatio;
			} else {
				hudWidth = windowWidth;
				hudHeight = windowWidth * (1 / iPadRatio);
			}
			return [hudWidth, hudWidth];
		}

		let resultW;
		const ratio_diff = Math.abs(windowWidth / windowheight - 1.7);

		if (ratio_diff < 0.25) {
			resultW = windowWidth / 1.192;
		} else if (ratio_diff < 0.5) {
			resultW = windowWidth / 1.146;
		} else {
			resultW = windowWidth / 1.591;
		}

		const resultH = resultW / 1.72;

		return [resultW, resultH];
	}, [windowWidth, windowheight, gameState.oldMeetingHud]);

	const classes = useStyles({
		width: width,
		height: height,
		oldHud: gameState.oldMeetingHud,
	});
	const [players, setPlayers] = useState(() => sortMeetingPlayers(gameState.players ?? []));
	const [meetingStartedAt] = useState(Date.now);
	useEffect(() => {
		// Ability kills can become final only after the HUD enters discussion. NoS also
		// rearranges its vote areas two seconds after opening the meeting.
		if (Date.now() - meetingStartedAt > 4000 || !gameState.players) return;
		setPlayers((snapshot) => {
			const next = reconcileMeetingPlayers(snapshot, gameState.players);
			return next.every((player, index) => player.id === snapshot[index]?.id) ? snapshot : next;
		});
	}, [gameState.players, meetingStartedAt]);
	if (!players || gameState.gameState !== GameState.DISCUSSION) return null;

	const largeNosMeeting = gameState.mod === 'NoS' && !gameState.oldMeetingHud && players.length > 15;
	const visiblePlayers = snrMeetingPage(gameState.mod, gameState.players, gameState.snrMeeting) ?? players;
	const overlays = visiblePlayers.map((player, index) => {
		// A temporarily missing player must keep its vote-area slot, never shift the following frames.
		if (!player) return <Box key={`snr-empty-${index}`} sx={classes.playerContainer} style={{ opacity: 0 }} />;
		// Keep tablet order fixed, but use the current publication for NoS RGB.
		const livePlayer = gameState.players.find((current) => current.id === player.id);
		const color =
			(gameState.mod === 'NoS' && nosColorHex(livePlayer?.nosPlayer)) || playerColors[player.colorId]?.[0] || '#C51111';

		return (
			<Box
				key={player.id}
				data-meeting-player={player.id}
				sx={
					largeNosMeeting
						? {
								...classes.playerContainer,
								...nosMeetingPlayerStyle(width, height, windowWidth, windowheight, players.length, index),
							}
						: classes.playerContainer
				}
				style={{
					opacity: voiceState.otherTalking[player.clientId] || (player.isLocal && voiceState.localTalking) ? 1 : 0,
					border: 'solid',
					borderWidth: '2px',
					borderColor: '#00000037',
					boxShadow: `0 0 ${height / 100}px ${height / 100}px ${color}`,
					transition: 'opacity 400ms',
				}}
			/>
		);
	});

	return (
		<Box sx={classes.meetingHud}>
			<Box
				sx={largeNosMeeting ? { ...classes.tabletContainer, left: 0, top: 0, height: '100%' } : classes.tabletContainer}
			>
				{overlays}
			</Box>
		</Box>
	);
};

createRoot(document.getElementById('app')!).render(<Overlay />);

export default Overlay;
