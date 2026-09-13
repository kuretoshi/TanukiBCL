import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, LinearProgress, Typography } from '@mui/material';
import { AutoUpdaterState, IpcRendererMessages } from '../../../common/ipc-messages';
import { ipcRenderer, shell } from '../../lib/electron-bridge';
import { SettingsSection } from '../SettingsControls';

export default function UpdateSection(): React.JSX.Element {
	const [state, setState] = useState<AutoUpdaterState>({ state: 'idle' });
	useEffect(() => {
		let active = true;
		let receivedEvent = false;
		const listener = (_: unknown, next: AutoUpdaterState) => {
			receivedEvent = true;
			if (active) setState(next);
		};
		ipcRenderer.on(IpcRendererMessages.AUTO_UPDATER_STATE, listener);
		ipcRenderer
			.invoke('updater:get-state')
			.then((snapshot) => {
				if (active && !receivedEvent) setState(snapshot as AutoUpdaterState);
			})
			.catch((error) => {
				if (active && !receivedEvent) setState({ state: 'error', error: String(error) });
			});
		return () => {
			active = false;
			ipcRenderer.off(IpcRendererMessages.AUTO_UPDATER_STATE, listener);
		};
	}, []);
	const busy = state.state === 'checking' || state.state === 'downloading';
	const canStart = !!state.info && (state.state === 'available' || state.state === 'downloaded');
	return (
		<SettingsSection title="アップデート">
			<Box sx={{ p: 2.5 }}>
				<Box
					aria-live="polite"
					sx={{ mb: 2.5, '& .MuiTypography-root': { fontSize: 15, lineHeight: 1.6, fontWeight: 500 } }}
				>
					{state.info && <Typography>最新バージョンv{state.info.version}</Typography>}
					{state.state === 'idle' && <Typography>アップデートを確認してください。</Typography>}
					{state.state === 'checking' && <Typography>アップデートを確認中…</Typography>}
					{state.state === 'unavailable' && <Typography>最新バージョンです</Typography>}
					{state.state === 'downloading' && (
						<>
							<Typography>ダウンロード中…</Typography>
							<LinearProgress
								variant={state.progress ? 'determinate' : 'indeterminate'}
								value={state.progress?.percent}
							/>
						</>
					)}
					{state.state === 'downloaded' && <Typography>アップデートの準備ができました。</Typography>}
					{state.state === 'error' && (
						<Alert severity="error">アップデートを確認・取得できませんでした。{state.error}</Alert>
					)}
				</Box>
				<Box
					sx={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
						gap: 1.5,
						maxWidth: 440,
						'& .MuiButton-root': { minHeight: 40, px: 2, fontSize: 14, whiteSpace: 'nowrap' },
					}}
				>
					<Button
						variant="outlined"
						disabled={busy}
						onClick={() => {
							setState({ state: 'checking' });
							ipcRenderer.send('updater:check');
						}}
					>
						アップデートを確認
					</Button>
					<Button
						variant="contained"
						disabled={!canStart}
						onClick={() => {
							setState((current) => ({ ...current, state: 'downloading' }));
							ipcRenderer.send('update-app');
						}}
					>
						アップデート開始
					</Button>
				</Box>
				<Typography variant="body2" color="text.secondary" sx={{ mt: 2, fontSize: 12, lineHeight: 1.8, maxWidth: 480 }}>
					アップデート開始後は、ダウンロード完了時にアプリを終了して更新します。
				</Typography>
				{state.state === 'error' && (
					<Button onClick={() => shell.openExternal('https://github.com/kuretoshi/BetterCrewLink/releases/latest')}>
						手動でダウンロード
					</Button>
				)}
			</Box>
		</SettingsSection>
	);
}
