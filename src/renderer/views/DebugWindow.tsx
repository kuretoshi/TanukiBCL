import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { Box, Button, IconButton, Accordion, AccordionDetails, AccordionSummary, Typography } from '@mui/material';
import MinimizeIcon from '@mui/icons-material/Remove';
import CloseIcon from '@mui/icons-material/Close';
import BugReportIcon from '@mui/icons-material/BugReport';
import theme from '../lib/theme';
import { ipcRenderer } from '../lib/electron-bridge';
import { remoteGameStore, startRemoteGameStore, stopRemoteGameStore } from '../state/remoteGameStore';
import { IpcSettingsMessages } from '../../common/ipc-messages';
import { GameState } from '../../common/AmongUsState';
import type { NosRadioReports } from './NosDebugPanel';
import { modList } from '../../common/Mods';
import '../css/index.css';
import SnrRolePanel from './SnrRolePanel';
import NosDebugPanel from './NosDebugPanel';
import PlayerRolePanel from './PlayerRolePanel';
import DebugLivePanel from './DebugLivePanel';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const controlStyles = { WebkitAppRegion: 'no-drag', p: 0, borderRadius: 0, width: 34, height: '100%' };

const jsonStyles = {
	m: 0,
	p: 2,
	maxHeight: 360,
	overflow: 'auto',
	fontFamily: 'Consolas, monospace',
	fontSize: 12,
	lineHeight: 1.6,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	userSelect: 'text',
};

function DebugSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode | (() => React.ReactNode);
}): React.JSX.Element {
	const [expanded, setExpanded] = useState(false);
	return (
		<Accordion expanded={expanded} onChange={(_, value) => setExpanded(value)}>
			<AccordionSummary expandIcon={<ExpandMoreIcon />}>
				<Typography variant="subtitle2">{title}</Typography>
			</AccordionSummary>
			<AccordionDetails sx={{ p: 0 }}>
				{typeof children === 'function' ? (expanded ? children() : null) : children}
			</AccordionDetails>
		</Accordion>
	);
}

function DebugWindow(): React.JSX.Element {
	const { gameState } = useSyncExternalStore(remoteGameStore.subscribe, remoteGameStore.getSnapshot);
	const players = gameState.players ?? [];
	const [voice, setVoice] = useState<unknown>(null);
	const radioClientIds = (voice as { impostorRadioClientIds?: number[] } | null)?.impostorRadioClientIds;
	const radioReports = (
		voice as {
			nosRadiosByPlayer?: NosRadioReports;
		} | null
	)?.nosRadiosByPlayer;
	const modName =
		gameState.mod === 'NONE'
			? 'Vanilla'
			: gameState.mod === 'OTHER'
				? '不明なMOD'
				: (modList.find((mod) => mod.id === gameState.mod)?.label ?? '取得待ち');
	const [showLogs, setShowLogs] = useState(false);
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
		if (!showLogs) return;
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
	}, [showLogs]);

	const version = new URLSearchParams(window.location.search).get('version');
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
					<Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', userSelect: 'text' }}>
						<Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, px: 2, py: 1 }}>
							<Typography variant="body2" sx={{ flex: 1 }}>
								起動中のMOD: {modName} ／ ゲーム: {GameState[gameState.gameState] ?? '取得待ち'} ／ {players.length}人
							</Typography>
							<Button variant="outlined" size="small" disabled={savingLog} onClick={() => void saveLog()}>
								{savingLog ? '保存中…' : 'ログを保存'}
							</Button>
						</Box>
						{saveMessage && (
							<Typography role="status" variant="caption" sx={{ px: 2 }}>
								{saveMessage}
							</Typography>
						)}
						<Typography variant="caption" color="text.secondary" sx={{ px: 2 }}>
							ゲーム・音声の状態を自動更新します。詳しい情報は下の項目を開いて確認できます。
						</Typography>
						<PlayerRolePanel gameState={gameState} radioReports={radioReports} radioClientIds={radioClientIds} />
						<Box sx={{ px: 2, pb: 2 }}>
							{gameState.mod === 'NoS' && (
								<DebugSection title="NoS：コスチューム・無線・LoadedContents.json">
									<NosDebugPanel gameState={gameState} radioReports={radioReports} />
								</DebugSection>
							)}
							{gameState.mod === 'SUPER_NEW_ROLES' && (
								<DebugSection title="SNR：役職・割り当て陣営・勝利陣営">
									<SnrRolePanel gameState={gameState} />
								</DebugSection>
							)}
							<DebugSection title="プレイヤーの外見・サイズ・座標など">
								<DebugLivePanel gameState={gameState} />
							</DebugSection>
							<DebugSection title="ゲーム状態（JSON）">
								{() => (
									<Box component="pre" sx={jsonStyles}>
										{JSON.stringify({ state: GameState[gameState.gameState] ?? 'WAITING', ...gameState }, null, 2)}
									</Box>
								)}
							</DebugSection>
							<DebugSection title="音声接続（JSON）">
								{() => (
									<Box component="pre" sx={jsonStyles}>
										{voice ? JSON.stringify(voice, null, 2) : '音声接続の情報を待っています…'}
									</Box>
								)}
							</DebugSection>
							<Accordion expanded={showLogs} onChange={(_, expanded) => setShowLogs(expanded)}>
								<AccordionSummary expandIcon={<ExpandMoreIcon />}>
									<Typography variant="subtitle2">ログ</Typography>
								</AccordionSummary>
								<AccordionDetails sx={{ p: 0 }}>
									<Typography variant="caption" color="text.secondary" sx={{ px: 2 }}>
										最新のログ（最大64KB）を1秒ごとに更新します。
									</Typography>
									<Box component="pre" sx={jsonStyles}>
										{logs || 'ログを取得しています…'}
									</Box>
								</AccordionDetails>
							</Accordion>
						</Box>
					</Box>
				</Box>
			</ThemeProvider>
		</StyledEngineProvider>
	);
}
createRoot(document.getElementById('app')!).render(<DebugWindow />);
