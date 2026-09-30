import ConnectionIndicator from '../components/ConnectionIndicator';
import { isLiteRuntime } from '../../common/appVariant';
import React, { useContext, useMemo } from 'react';
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
			paddingTop: theme.spacing(3),
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

const otherPlayersGridWidth = 225;
const otherPlayersGridGap = 8;

const OtherPlayersGrid = styled(Box)({
	display: 'grid',
	gap: otherPlayersGridGap,
	width: 'fit-content',
	margin: '4px auto',
});

function getPlayersPerRow(playerCount: number): number {
	if (playerCount <= 9) return 3;
	return Math.min(12, Math.ceil(Math.sqrt(playerCount)));
}

function getOtherPlayerAvatarSize(playersPerRow: number): number {
	return otherPlayersGridWidth / playersPerRow - otherPlayersGridGap;
}

const VoiceView: React.FC<VoiceProps> = function ({ t, error: initialError }: VoiceProps) {
	const classes = useStyles();
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

	const playerConfigs = settings.playerConfigMap;

	const lobbyDetected =
		!!gameState?.lobbyCode &&
		gameState.lobbyCode !== 'MENU' &&
		gameState.gameState !== GameState.MENU &&
		gameState.gameState !== GameState.UNKNOWN;
	let displayedLobbyCode = lobbyDetected ? gameState.lobbyCode : 'MENU';
	if (displayedLobbyCode !== 'MENU' && settings.hideCode) displayedLobbyCode = 'LOBBY';

	const otherPlayersPerRow = getPlayersPerRow(otherPlayers.length);
	const otherPlayerAvatarSize = getOtherPlayerAvatarSize(otherPlayersPerRow);
	const error = voice.error || initialError;
	const detectedMod =
		gameState.mod === 'NONE' ? undefined : (modList.find(({ id }) => id === gameState.mod)?.label ?? gameState.mod);

	return (
		<Box sx={classes.root}>
			{detectedMod && <Box sx={classes.detectedMod}>MOD: {detectedMod}</Box>}
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
						<OtherPlayersGrid sx={{ gridTemplateColumns: `repeat(${otherPlayersPerRow}, ${otherPlayerAvatarSize}px)` }}>
							{otherPlayers.map((player) => {
								const peer = voice.playerSocketIds[player.clientId];
								const connected = voice.socketClients[peer]?.clientId === player.clientId || false;
								const playerConfig =
									playerConfigs?.[player.playerConfigId] ?? playerConfigs?.[player.nameHash] ?? DEFAULT_PLAYER_CONFIG;
								const theirVadHidden = player.shiftedColor !== -1 && gameState?.gameState !== GameState.DISCUSSION;

								return (
									<Box key={player.id} sx={{ width: otherPlayerAvatarSize, position: 'relative' }}>
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
												!(player.disconnected || player.bugged) &&
												visibleRadioClientIds.includes(player.clientId)
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
			{otherPlayers.length <= 6 && <Footer />}
		</Box>
	);
};

export default VoiceView;
