import ConnectionIndicator from '../components/ConnectionIndicator';
import { isLiteRuntime } from '../../common/appVariant';
import React, { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Typography from '@mui/material/Typography';
import { styled, useTheme } from '@mui/material/styles';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import VolumeOff from '@mui/icons-material/VolumeOff';
import VolumeUp from '@mui/icons-material/VolumeUp';
import Mic from '@mui/icons-material/Mic';
import MicOff from '@mui/icons-material/MicOff';

import Avatar from '../components/Avatar';
import Footer from '../components/Footer';
import SupportLink from '../components/SupportLink';
import { GameStateContext, SettingsContext } from '../state/contexts';
import { GameState } from '../../common/AmongUsState';
import { SocketConfig } from '../../common/ISettings';
import { modList } from '../../common/Mods';
import { IpcHandlerMessages } from '../../common/ipc-messages';
import { ipcRenderer } from '../lib/electron-bridge';
import { useVoiceEngine } from '../voice/useVoiceController';
import { getPlayerGridLayout, playerAvatarChrome, playerGridGap, playerGroupHeaderHeight } from './playerGridLayout';

export interface VoiceProps {
	t: (key: string) => string;
	error: string;
}

const useStyles = () => {
	const theme = useTheme();
	return {
		error: {
			position: 'absolute',
			top: '50%',
			transform: 'translateY(-50%)',
		},
		root: {
			height: '100vh',
			width: '100vw',
			boxSizing: 'border-box',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
			paddingTop: theme.spacing(3),
		},
		content: {
			position: 'relative',
			display: 'flex',
			flexDirection: 'column',
			flex: '1 1 auto',
			minHeight: 0,
		},
		versionWarning: {
			flexShrink: 0,
			margin: '0 12px 8px',
			zIndex: 4,
			boxSizing: 'border-box',
			maxHeight: 96,
			overflowY: 'auto',
			overflowWrap: 'anywhere',
			whiteSpace: 'normal',
			padding: '8px 10px',
			border: '1px solid #9b7b2d',
			borderRadius: '4px',
			backgroundColor: '#443919',
		},
		top: {
			display: 'flex',
			justifyContent: 'center',
			alignItems: 'center',
		},
		right: {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			justifyContent: 'center',
		},
		username: {
			display: 'block',
			textAlign: 'center',
			fontSize: 20,
			whiteSpace: 'nowrap',
			maxWidth: '115px',
		},
		code: {
			fontFamily: "'Source Code Pro', monospace",
			display: 'block',
			width: 'fit-content',
			margin: '5px auto',
			padding: '5px',
			borderRadius: '5px',
			fontSize: 28,
		},
		avatarWrapper: {
			width: 80,
			padding: theme.spacing(1),
			position: 'relative',
		},
		muteButtons: {
			paddingLeft: '5px',
			paddingTop: '26px',
			float: 'right',
			display: 'grid',
		},
		left: { float: 'left' },
		detectedMod: {
			position: 'fixed',
			right: 6,
			bottom: 58,
			zIndex: 2,
			maxWidth: 'calc(100% - 12px)',
			padding: '2px 5px',
			borderRadius: '4px',
			backgroundColor: 'rgba(0, 0, 0, 0.35)',
			color: 'rgba(255, 255, 255, 0.72)',
			fontSize: 10,
			lineHeight: 1.2,
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			pointerEvents: 'none',
		},
	};
};

const DEFAULT_PLAYER_CONFIG: SocketConfig = { volume: 1, isMuted: false };

const OtherPlayersGrid = styled(Box)({
	display: 'grid',
	gap: playerGridGap,
	flex: '1 1 0',
	minHeight: 0,
	width: 'calc(100% - 24px)',
	margin: '4px auto',
	justifyContent: 'center',
	alignContent: 'start',
	overflow: 'hidden',
});

const PlayerGroupHeader: React.FC<{ label: string; row: number; color: string }> = function ({ label, row, color }) {
	return (
		<Box sx={{ gridColumn: '1 / -1', gridRow: row, display: 'flex', alignItems: 'center', gap: 1 }}>
			<Typography
				component="span"
				variant="caption"
				sx={{ color, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap' }}
			>
				{label}
			</Typography>
			<Box sx={{ height: '1px', flex: 1, backgroundColor: 'rgba(255,255,255,0.32)' }} />
		</Box>
	);
};

const VoiceView: React.FC<VoiceProps> = function ({ t, error: initialError }: VoiceProps) {
	const classes = useStyles();
	const gridRef = useRef<HTMLDivElement>(null);
	const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
	const rawGameState = useContext(GameStateContext);
	const [settings, setSetting] = useContext(SettingsContext);
	const { voice, controller } = useVoiceEngine();
	const gameState = controller.getEffectiveGameState(rawGameState);

	const myPlayer = useMemo(() => gameState?.players?.find((player) => player.isLocal), [gameState?.players]);
	const vadHidden = (myPlayer?.shiftedColor ?? -1) !== -1 && gameState?.gameState !== GameState.DISCUSSION;
	const visibleRadioClientIds = controller.getVisibleRadioClientIds(gameState);

	const otherPlayers = useMemo(() => {
		if (!gameState?.players || !myPlayer) return [];
		return gameState.players.filter((player) => !player.isLocal);
	}, [gameState?.players, myPlayer]);
	const groupPlayersByLife = settings.appPlayerLayout === 'aliveAboveGhosts';
	const alivePlayers = groupPlayersByLife ? otherPlayers.filter((player) => !voice.otherDead[player.clientId]) : [];
	const displayedPlayers = groupPlayersByLife
		? [...alivePlayers, ...otherPlayers.filter((player) => !!voice.otherDead[player.clientId])]
		: otherPlayers;

	const playerConfigs = settings.playerConfigMap;

	const lobbyDetected =
		!!gameState?.lobbyCode &&
		gameState.lobbyCode !== 'MENU' &&
		gameState.gameState !== GameState.MENU &&
		gameState.gameState !== GameState.UNKNOWN;
	let displayedLobbyCode = lobbyDetected ? gameState.lobbyCode : 'MENU';
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';

	const error = voice.error || initialError;
	const gridVisible = !!myPlayer && lobbyDetected && !error;
	useLayoutEffect(() => {
		const grid = gridRef.current;
		if (!grid) return;
		const updateSize = () => {
			const { width, height } = grid.getBoundingClientRect();
			setGridSize((previous) =>
				previous.width === width && previous.height === height ? previous : { width, height }
			);
		};
		updateSize();
		const observer = new ResizeObserver(updateSize);
		observer.observe(grid);
		return () => observer.disconnect();
	}, [gridVisible]);
	const { columns: otherPlayersPerRow, avatarSize: otherPlayerAvatarSize } = getPlayerGridLayout(
		gridSize.width,
		gridSize.height,
		displayedPlayers.length,
		groupPlayersByLife ? alivePlayers.length : undefined
	);
	const aliveRows = Math.ceil(alivePlayers.length / otherPlayersPerRow);
	const ghostCount = groupPlayersByLife ? displayedPlayers.length - alivePlayers.length : 0;
	const ghostRows = Math.ceil(ghostCount / otherPlayersPerRow);
	const ghostHeaderRow = alivePlayers.length > 0 ? aliveRows + 2 : 1;
	const groupedRows = [
		aliveRows > 0
			? `${playerGroupHeaderHeight}px repeat(${aliveRows}, ${otherPlayerAvatarSize + playerAvatarChrome}px)`
			: '',
		ghostRows > 0
			? `${playerGroupHeaderHeight}px repeat(${ghostRows}, ${otherPlayerAvatarSize + playerAvatarChrome}px)`
			: '',
	]
		.filter(Boolean)
		.join(' ');
	const detectedMod =
		gameState.mod === 'NONE' ? undefined : (modList.find(({ id }) => id === gameState.mod)?.label ?? gameState.mod);

	return (
		<Box sx={classes.root}>
			<Box sx={classes.content}>
				{detectedMod && (
					<Box
						title={gameState.nosReadStatus?.message}
						sx={{
							...classes.detectedMod,
							...(gameState.mod === 'NoS' && gameState.nosReadStatus?.failed
								? { backgroundColor: '#581e24', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: 360 }
								: {}),
						}}
					>
						MOD: {detectedMod}
						{gameState.mod === 'NoS' && gameState.nosReadStatus?.failed && (
							<div role="status">{gameState.nosReadStatus.message}</div>
						)}
					</Box>
				)}
				{error && (
					<Box sx={classes.error}>
						<Typography align="center" variant="h6" color="error">
							ERROR
						</Typography>
						<Typography align="center" style={{ whiteSpace: 'pre-wrap' }}>
							{error}
						</Typography>
						<SupportLink />
					</Box>
				)}
				{!error && (
					<>
						<Box sx={classes.top}>
							{myPlayer && lobbyDetected && (
								<Box sx={classes.avatarWrapper}>
									<Avatar
										hideWhenAppearanceChanged={gameState.gameState === GameState.TASKS}
										deafened={voice.deafened}
										muted={voice.muted}
										player={myPlayer}
										borderColor={vadHidden ? 'gray' : '#2ecc71'}
										connectionState={voice.connected ? 'connected' : 'disconnected'}
										isUsingRadio={visibleRadioClientIds.includes(myPlayer.clientId)}
										talking={voice.talking}
										isAlive={!myPlayer.isDead}
										size={100}
										mod={gameState.mod}
									/>
									<ConnectionIndicator connected={voice.connected} quality={voice.serverQuality} edgeInset={6} />
								</Box>
							)}
							<Box sx={classes.right}>
								<div>
									<Box sx={classes.left}>
										{myPlayer && lobbyDetected && (
											<Box component="span" sx={classes.username}>
												{myPlayer.appearanceName || myPlayer.name}
											</Box>
										)}
										<Box
											component="span"
											sx={classes.code}
											style={{
												background: lobbyDetected ? '#3e4346' : 'transparent',
											}}
										>
											{displayedLobbyCode === 'MENU' ? t('game.menu') : displayedLobbyCode}
										</Box>
									</Box>
									{lobbyDetected && (
										<Box sx={classes.muteButtons}>
											<IconButton onClick={controller.toggleMute} size="small">
												{voice.muted || voice.deafened ? <MicOff /> : <Mic />}
											</IconButton>
											<IconButton onClick={controller.toggleDeafen} size="small">
												{voice.deafened ? <VolumeOff /> : <VolumeUp />}
											</IconButton>
										</Box>
									)}
								</div>
							</Box>
						</Box>
						{voice.activeLobbySettings?.deadOnly && (
							<Box sx={classes.top}>
								<small style={{ padding: 0 }}>{t('settings.lobbysettings.ghost_only_warning2')}</small>
							</Box>
						)}
						{voice.activeLobbySettings?.meetingGhostOnly && (
							<Box sx={classes.top}>
								<small style={{ padding: 0 }}>{t('settings.lobbysettings.meetings_only_warning2')}</small>
							</Box>
						)}
						<Divider />
						{!isLiteRuntime() && displayedLobbyCode === 'MENU' && (
							<Box sx={classes.top}>
								<Button
									style={{ margin: '10px' }}
									onClick={() => ipcRenderer.send(IpcHandlerMessages.OPEN_LOBBYBROWSER)}
									color="primary"
									variant="outlined"
								>
									{t('buttons.public_lobby')}
								</Button>
							</Box>
						)}
						{myPlayer && lobbyDetected && (
							<OtherPlayersGrid
								ref={gridRef}
								sx={{
									...(groupPlayersByLife && {
										width: 'calc(100% - 32px)',
										justifyContent: displayedPlayers.length >= 8 ? 'space-between' : 'center',
									}),
									gridTemplateColumns: `repeat(${otherPlayersPerRow}, ${otherPlayerAvatarSize + playerAvatarChrome}px)`,
									...(groupPlayersByLife && { gridTemplateRows: groupedRows }),
									gridAutoRows: `${otherPlayerAvatarSize + playerAvatarChrome}px`,
								}}
							>
								{groupPlayersByLife && alivePlayers.length > 0 && (
									<PlayerGroupHeader label={t('settings.app_layout.survivors')} row={1} color="#91d6a9" />
								)}
								{groupPlayersByLife && ghostCount > 0 && (
									<PlayerGroupHeader label={t('settings.app_layout.afterlife')} row={ghostHeaderRow} color="#c8b1df" />
								)}
								{displayedPlayers.map((player, index) => {
									const peer = voice.playerSocketIds[player.clientId];
									const connected = voice.socketClients[peer]?.clientId === player.clientId || false;
									const playerConfig =
										playerConfigs?.[player.playerConfigId] ?? playerConfigs?.[player.nameHash] ?? DEFAULT_PLAYER_CONFIG;
									const theirVadHidden = player.shiftedColor !== -1 && gameState?.gameState !== GameState.DISCUSSION;
									const ghostGroup = groupPlayersByLife && index >= alivePlayers.length;
									const groupIndex = ghostGroup ? index - alivePlayers.length : index;
									const playerBoxSx = {
										width: otherPlayerAvatarSize,
										position: 'relative' as const,
										...(groupPlayersByLife && {
											gridColumn: (groupIndex % otherPlayersPerRow) + 1,
											gridRow: Math.floor(groupIndex / otherPlayersPerRow) + (ghostGroup ? ghostHeaderRow + 1 : 2),
										}),
									};

									return (
										<Box key={player.id} sx={playerBoxSx}>
											<Avatar
												hideWhenAppearanceChanged={gameState.gameState === GameState.TASKS}
												connectionState={
													!connected ? 'disconnected' : voice.audioConnected[peer] ? 'connected' : 'novoice'
												}
												player={player}
												talking={!player.inVent && !theirVadHidden && voice.otherTalking[player.clientId]}
												borderColor="#2ecc71"
												isAlive={!voice.otherDead[player.clientId]}
												isUsingRadio={
													!(player.disconnected || player.bugged) && visibleRadioClientIds.includes(player.clientId)
												}
												size={otherPlayerAvatarSize}
												socketConfig={playerConfig}
												onConfigChange={(config, persist) =>
													setSetting(`playerConfigMap.${player.playerConfigId}`, config, persist)
												}
												mod={gameState.mod}
											/>
											<ConnectionIndicator
												connected={connected && !!voice.audioConnected[peer]}
												quality={voice.connectionQuality[peer]}
											/>
										</Box>
									);
								})}
							</OtherPlayersGrid>
						)}
					</>
				)}
				{voice.versionWarning && lobbyDetected && (
					<Typography role="status" color="warning.main" align="center" sx={classes.versionWarning}>
						{voice.versionWarning}
					</Typography>
				)}
			</Box>
			<Footer inFlow />
		</Box>
	);
};

export default VoiceView;
