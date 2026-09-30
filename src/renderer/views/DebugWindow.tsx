import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import {
	Box,
	Button,
	IconButton,
	Tabs,
	Tab,
	Typography,
	Table,
	TableHead,
	TableBody,
	TableRow,
	TableCell,
} from '@mui/material';
import MinimizeIcon from '@mui/icons-material/Remove';
import CloseIcon from '@mui/icons-material/Close';
import BugReportIcon from '@mui/icons-material/BugReport';
import theme from '../lib/theme';
import { ipcRenderer } from '../lib/electron-bridge';
import { remoteGameStore, startRemoteGameStore, stopRemoteGameStore } from '../state/remoteGameStore';
import { IpcSettingsMessages } from '../../common/ipc-messages';
import { GameState } from '../../common/AmongUsState';
import type { NosRadioData } from '../../common/NosSnapshot';
import { isSnrNeutralKiller } from '../../common/SnrRole';
import { modList } from '../../common/Mods';
import '../css/index.css';
import SnrRolePanel from './SnrRolePanel';

const controlStyles = { WebkitAppRegion: 'no-drag', p: 0, borderRadius: 0, width: 34, height: '100%' };
const radioKindNames: Record<number, string> = { 0: 'Impostor', 1: 'Jackal', 2: 'Lovers' };

function hearablePlayerIds(mask: number): string {
	const ids = Array.from({ length: 32 }, (_, id) => id).filter((id) => ((mask >>> id) & 1) !== 0);
	return ids.length ? ids.join(', ') : 'なし';
}

function DebugWindow(): React.JSX.Element {
	const { gameState } = useSyncExternalStore(remoteGameStore.subscribe, remoteGameStore.getSnapshot);
	const players = gameState.players ?? [];
	const [voice, setVoice] = useState<unknown>(null);
	const radioReports = (
		voice as {
			nosRadiosByPlayer?: Record<number, { clientId: number; radios: NosRadioData[]; receivedAt: number }>;
		} | null
	)?.nosRadiosByPlayer;
	const modName =
		gameState.mod === 'NONE'
			? 'Vanilla'
			: gameState.mod === 'OTHER'
				? '不明なMOD'
				: (modList.find((mod) => mod.id === gameState.mod)?.label ?? '取得待ち');
	const [tab, setTab] = useState('live');
	const [logs, setLogs] = useState('');
	const [savingLog, setSavingLog] = useState(false);
	const [saveMessage, setSaveMessage] = useState('');
	const saveLog = async () => {
		if (savingLog) return;
		setSavingLog(true);
		setSaveMessage('');
		try {
			const result = (await ipcRenderer.invoke('debug:save-log')) as { status: 'saved' | 'cancelled' | 'error' };
			if (result.status === 'saved') setSaveMessage('ログを保存しました。');
			else if (result.status === 'error') setSaveMessage('ログを保存できませんでした。保存先を確認してください。');
		} catch {
			setSaveMessage('ログを保存できませんでした。再試行してください。');
		} finally {
			setSavingLog(false);
		}
	};
	useEffect(() => {
		const onVoice = (_: unknown, value: unknown) => setVoice(value);
		ipcRenderer.on(IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED, onVoice);
		startRemoteGameStore();
		return () => {
			ipcRenderer.off(IpcSettingsMessages.NOTIFY_DEBUG_VOICE_CHANGED, onVoice);
			stopRemoteGameStore();
		};
	}, []);
	useEffect(() => {
		if (tab !== 'logs') return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		const refresh = async () => {
			try {
				const text = await ipcRenderer.invoke('debug:get-logs');
				if (active) setLogs(String(text || 'ログはありません。'));
			} catch (error) {
				if (active) setLogs(String(error));
			} finally {
				if (active) timer = setTimeout(refresh, 1000);
			}
		};
		void refresh();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [tab]);
	const version = new URLSearchParams(window.location.search).get('version');
	const text =
		tab === 'logs'
			? logs
			: JSON.stringify(
					tab === 'voice'
						? voice
						: {
								state: GameState[gameState.gameState] ?? 'WAITING',
								...gameState,
							},
					null,
					2
				);
	return (
		<StyledEngineProvider injectFirst>
			<ThemeProvider theme={theme}>
				<Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
					<Box
						sx={{
							display: 'flex',
							alignItems: 'center',
							height: 30,
							flexShrink: 0,
							backgroundColor: '#1d1a23',
							WebkitAppRegion: 'drag',
						}}
					>
						<Box
							sx={{
								flex: 1,
								display: 'flex',
								alignItems: 'center',
								gap: 1,
								pl: 1.5,
								color: 'primary.main',
								fontSize: 13,
							}}
						>
							<BugReportIcon sx={{ fontSize: 16 }} />
							デバッグ情報 v{version}
						</Box>
						<IconButton aria-label="最小化" sx={controlStyles} onClick={() => ipcRenderer.send('minimize', 'debug')}>
							<MinimizeIcon sx={{ fontSize: 16 }} />
						</IconButton>
						<IconButton aria-label="閉じる" sx={controlStyles} onClick={() => window.close()}>
							<CloseIcon sx={{ fontSize: 16 }} />
						</IconButton>
					</Box>
					<Tabs
						value={tab}
						onChange={(_, value: string) => setTab(value)}
						variant="scrollable"
						scrollButtons="auto"
						sx={{ px: 2, flexShrink: 0 }}
					>
						<Tab value="live" label="リアルタイム" />
						<Tab value="snr" label="SNR役職" />
						<Tab value="game" label="ゲーム状態" />
						<Tab value="voice" label="音声接続" />
						<Tab value="logs" label="ログ" />
					</Tabs>
					<Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, px: 2, pt: 1 }}>
						<Typography variant="body2" sx={{ flex: 1 }}>
							起動中のMOD: {modName}
						</Typography>
						<Button variant="outlined" size="small" disabled={savingLog} onClick={() => void saveLog()}>
							{savingLog ? '保存中…' : 'ログを保存'}
						</Button>
					</Box>
					{saveMessage && (
						<Typography role="status" variant="caption" sx={{ px: 2, pt: 1 }}>
							{saveMessage}
						</Typography>
					)}
					<Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 1 }}>
						{tab === 'logs' ? '最新のログ（最大64KB）を1秒ごとに更新します。' : 'ゲーム・音声の状態を自動更新します。'}
					</Typography>
					{tab === 'snr' ? (
						<SnrRolePanel gameState={gameState} />
					) : tab === 'live' ? (
						<Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 2, pb: 2, userSelect: 'text' }}>
							<Typography sx={{ mb: 1 }}>
								ゲーム状態: {GameState[gameState.gameState]} ／ プレイヤー: {players.length}人
							</Typography>
							<Typography variant="body2" sx={{ mb: 1 }}>
								通信妨害: {gameState.comsSabotaged ? 'あり' : 'なし'} ／ カモフラージュ:{' '}
								{gameState.camouflaged ? 'あり' : 'なし'} ／ ミックスアップ:{' '}
								{gameState.mixupSabotaged ? 'あり' : 'なし'}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								{gameState.mod === 'SUPER_NEW_ROLES'
									? gameState.debug?.snrRoleStatus || 'SNR役職未取得'
									: gameState.mod === 'NoS'
										? gameState.debug?.nosSnapshotStatus || 'NoSスナップショット未取得'
										: gameState.mod === 'TOH4E'
											? gameState.debug?.tohRoleStatus || 'TOH4E役職未取得'
											: '役職は現在取得できる判定値です。Mod固有の役職名をすべて識別するものではありません。'}
							</Typography>
							{gameState.mod === 'NoS' && (
								<Box sx={{ mt: 1, p: 1, backgroundColor: '#1d1a23', borderRadius: 1 }}>
									<Typography variant="subtitle2">RadioData（各プレイヤーが話せるチャンネル）</Typography>
									{players.map((player) => {
										const report = radioReports?.[player.id];
										const radios = player.isLocal
											? gameState.nosRadios
											: report?.clientId === player.clientId
												? report.radios
												: undefined;
										return (
											<Box key={player.id} sx={{ mt: 1, overflowWrap: 'anywhere' }}>
												<Typography variant="body2" sx={{ fontWeight: 'bold' }}>
													{player.name} / PlayerId: {player.id} / ClientId: {player.clientId} ／{' '}
													{radios ? `${radios.length}件` : player.isLocal ? '未取得' : '相手から未受信'}
												</Typography>
												{radios?.map((radio, index) => (
													<Typography key={index} variant="body2" sx={{ pl: 2 }}>
														#{index} Kind: {radio.kind} ({radioKindNames[radio.kind] ?? 'Unknown'}) ／ Name:{' '}
														{radio.name || '(名称なし)'} ／ NameLength: {radio.nameLength} ／ HearableMask:{' '}
														{radio.hearableMask} (0x
														{(radio.hearableMask >>> 0).toString(16).toUpperCase().padStart(8, '0')}) ／
														声が届くPlayerId: {hearablePlayerIds(radio.hearableMask)}
													</Typography>
												))}
											</Box>
										);
									})}
								</Box>
							)}
							<Table size="small" sx={{ mt: 1, '& th, & td': { whiteSpace: 'nowrap' } }}>
								<TableHead>
									<TableRow>
										{['名前 / ID', '役職 / 本体陣営値', '状態', '会話状態', '変身 / 外見', 'サイズ', '座標'].map(
											(label) => (
												<TableCell key={label}>{label}</TableCell>
											)
										)}
									</TableRow>
								</TableHead>
								<TableBody>
									{players.map((player) => (
										<TableRow key={player.id} selected={player.isLocal}>
											<TableCell>
												{player.name}
												{player.isLocal ? '（自分）' : ''}
												<br />
												ID: {player.id} / Client: {player.clientId}
											</TableCell>
											<TableCell>
												{player.roleName || '不明'}
												<br />
												本体陣営値: {player.roleTeam}
												{gameState.mod === 'SUPER_NEW_ROLES' && player.snrRole && (
													<>
														<br />
														SNR IsNeutral:{' '}
														{player.snrRole.isNeutral == null ? '未取得' : String(player.snrRole.isNeutral)}
														<br />
														SNR CanKill: {player.snrRole.canKill == null ? '未取得' : String(player.snrRole.canKill)}
														<br />
														第三陣営キル役職の対象: {isSnrNeutralKiller(player.snrRole) ? 'はい' : 'いいえ／未取得'}
													</>
												)}
												{gameState.mod === 'TOH4E' && (
													<>
														<br />
														RoleId: {player.tohRole?.roleId ?? '未取得'}
														<br />
														IKiller: {player.tohRole?.isKiller == null ? '未取得' : String(player.tohRole.isKiller)}
														{player.tohRole?.roleName === 'Opportunist' && (
															<>
																<br />
																Opportunist.CanKill:{' '}
																{player.tohRole.opportunistCanKill == null
																	? '未取得'
																	: String(player.tohRole.opportunistCanKill)}
															</>
														)}
													</>
												)}
												{gameState.mod === 'NoS' && player.nosPlayer && (
													<>
														<br />
														IsNeutral={String(player.nosPlayer.isNeutral)}
														<br />
														IsKiller={String(player.nosPlayer.isKiller)}
														<br />
														IsImpostor={String(player.nosPlayer.isImpostor)}
														<br />
														IsCrewmate={String(player.nosPlayer.isCrewmate)}
													</>
												)}
											</TableCell>
											<TableCell>
												{player.disconnected ? '切断' : player.isDead ? '死亡' : '生存'}
												{player.inVent ? ' / ベント' : ''}
											</TableCell>
											<TableCell>
												{gameState.mod === 'NoS'
													? `IsJammed (会議中のフィクサー妨害): ${player.nosPlayer?.isJammed == null ? '未取得' : String(player.nosPlayer.isJammed)}`
													: '—'}
											</TableCell>
											<TableCell>
												{player.appearanceName || player.name}
												<br />
												Outfit: {player.currentOutfit} / 色: {player.colorId} → {player.appearanceColorId}
												<br />
												Skin: {player.appearanceSkinId || 'なし'}
												<br />
												Hat: {player.appearanceHatId || 'なし'}
												<br />
												Visor: {player.appearanceVisorId || 'なし'}
												<br />
												Pet: {player.petId || 'なし'}
												{player.nosPlayer && (
													<>
														<br />
														NoS: {player.nosPlayer.name} / RGB:{' '}
														{[player.nosPlayer.colorR, player.nosPlayer.colorG, player.nosPlayer.colorB]
															.map((value) => value.toFixed(3))
															.join(', ')}
													</>
												)}
											</TableCell>
											<TableCell>
												{gameState.mod === 'NoS' && player.nosPlayer && (
													<>
														BodyRateX: {player.nosPlayer.bodyRateX?.toFixed(3) ?? '未取得'}
														<br />
														BodyRateY: {player.nosPlayer.bodyRateY?.toFixed(3) ?? '未取得'}
													</>
												)}
												{gameState.mod === 'SUPER_NEW_ROLES' && player.snrRole?.jumbo && (
													<>
														ジャンボ:{' '}
														{Math.min(
															100,
															(player.snrRole.jumbo.currentSize / player.snrRole.jumbo.maxSize) * 100
														).toFixed(0)}
														%
													</>
												)}
											</TableCell>
											<TableCell>
												{player.x?.toFixed(2)}, {player.y?.toFixed(2)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							{players.length === 0 && <Typography sx={{ py: 2 }}>プレイヤー情報を待っています…</Typography>}
							{gameState.debug && (
								<Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
									自分の役職: {gameState.debug.localRoleLabel} / 陣営値: {gameState.debug.localRoleTeam}
									{'\n'}外見: {gameState.debug.currentOutfits}
									{'\n'}サイズ: {gameState.debug.sizeDebug}
									{'\n'}色: {gameState.debug.colorDebug}
								</Box>
							)}
						</Box>
					) : (
						<Box
							component="pre"
							sx={{
								flex: 1,
								minHeight: 0,
								m: 0,
								p: 2,
								overflow: 'auto',
								userSelect: 'text',
								fontFamily: 'Consolas, monospace',
								fontSize: 12,
								lineHeight: 1.6,
								whiteSpace: 'pre-wrap',
								overflowWrap: 'anywhere',
								backgroundColor: '#1d1a23',
							}}
						>
							{text || '情報を待っています…'}
						</Box>
					)}
				</Box>
			</ThemeProvider>
		</StyledEngineProvider>
	);
}

createRoot(document.getElementById('app')!).render(<DebugWindow />);
