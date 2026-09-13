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
import { modList } from '../../common/Mods';
import '../css/index.css';

const controlStyles = { WebkitAppRegion: 'no-drag', p: 0, borderRadius: 0, width: 34, height: '100%' };

function DebugWindow(): React.JSX.Element {
	const { gameState } = useSyncExternalStore(remoteGameStore.subscribe, remoteGameStore.getSnapshot);
	const players = gameState.players ?? [];
	const modName =
		gameState.mod === 'NONE'
			? 'Vanilla'
			: gameState.mod === 'OTHER'
				? '不明なMOD'
				: (modList.find((mod) => mod.id === gameState.mod)?.label ?? '取得待ち');
	const [voice, setVoice] = useState<unknown>(null);
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
					{tab === 'live' ? (
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
								役職は現在取得できる判定値です。Mod固有の役職名をすべて識別するものではありません。
							</Typography>
							<Table size="small" sx={{ mt: 1, '& th, & td': { whiteSpace: 'nowrap' } }}>
								<TableHead>
									<TableRow>
										{['名前 / ID', '役職 / 陣営値', '状態', '変身 / 外見', 'サイズ', '座標'].map((label) => (
											<TableCell key={label}>{label}</TableCell>
										))}
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
												{player.roleName || '不明'} / {player.roleTeam}
											</TableCell>
											<TableCell>
												{player.disconnected ? '切断' : player.isDead ? '死亡' : '生存'}
												{player.inVent ? ' / ベント' : ''}
											</TableCell>
											<TableCell>
												{player.appearanceName || player.name}
												<br />
												Outfit: {player.currentOutfit} / 色: {player.colorId} → {player.appearanceColorId}
												<br />
												Skin: {player.appearanceSkinId || 'なし'}
											</TableCell>
											<TableCell>
												{player.sizeScale?.toFixed(3) ?? '不明'} / {player.specialRole}
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
