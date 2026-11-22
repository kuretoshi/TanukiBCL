import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { ipcRenderer, shell } from '../../lib/electron-bridge';
import { SettingsSection, SwitchRow } from '../SettingsControls';
import { speechSetupDownloadUrl, type SharedSpeechStatus } from '../../../common/SharedSpeechSetup';
export default function VoiceStoneSpeechSettings(): React.ReactElement {
	const [local, setLocal] = React.useState<SharedSpeechStatus>();
	const [error, setError] = React.useState('');
	const refresh = React.useCallback(async () => {
		try {
			const status = (await ipcRenderer.invoke('VOICE_STONE_LOCAL_STATUS')) as SharedSpeechStatus | null;
			if (!status || typeof status.runtimeInstalled !== 'boolean') throw new Error('Status unavailable');
			setLocal(status);
			setError('');
			return status;
		} catch {
			setError('実行環境を確認できませんでした。再確認してください。');
			return undefined;
		}
	}, []);
	React.useEffect(() => {
		void refresh();
	}, [refresh]);
	return (
		<SettingsSection title="音声認識">
			<SwitchRow
				label="共有モデルで認識する"
				description="変身・NGワード・ボイスストーンに使用します。"
				checked={local?.enabled ?? false}
				disabled={!local?.available}
				onChange={async (enabled) => {
					if (await ipcRenderer.invoke('VOICE_STONE_LOCAL_SET', enabled)) await refresh();
				}}
			/>
			<Box sx={{ px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
				<Typography
					variant="body2"
					color="text.secondary"
					sx={{ fontSize: 13, lineHeight: 1.7, fontWeight: 400, overflowWrap: 'anywhere' }}
				>
					{!local
						? '実行環境を確認しています。'
						: !local.runtimeInstalled
							? 'Microsoft Visual C++ v14 Redistributable（x64）が未導入、または必要なファイルが不足しています。公式ページからx64版を導入後、「再確認」を押してください。'
							: local.available
								? 'PCは各自の端末、Web・モバイル参加者の分はホストが認識します。オフにすると従来の軽量方式を使います。'
								: '共有モデルが未準備のため、従来の軽量ローカル認識を使用します。'}
				</Typography>
				{(error || local?.error) && (
					<Typography role="alert" variant="body2" color="error" sx={{ fontSize: 13, lineHeight: 1.7 }}>
						{error || local?.error}
					</Typography>
				)}
				<Box
					sx={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: 1,
						'& .MuiButton-root': { minHeight: 36, px: 1.5, fontSize: 13, maxWidth: '100%', whiteSpace: 'normal' },
					}}
				>
					<Button
						variant="outlined"
						color="secondary"
						disabled={!local}
						onClick={async () => {
							const status = await refresh();
							if (status) await shell.openExternal(speechSetupDownloadUrl(status));
						}}
					>
						{local?.runtimeInstalled ? '共有モデルをダウンロード' : 'Visual C++の公式ダウンロードページ'}
					</Button>
					<Button variant="outlined" color="inherit" onClick={() => void refresh()}>
						再確認
					</Button>
				</Box>
				<Typography variant="caption" color="text.secondary" sx={{ fontSize: 12, lineHeight: 1.7, fontWeight: 400 }}>
					導入後はアプリを再起動してください。タヌキ丼未検出時はモデルを読み込みません。
				</Typography>
			</Box>
		</SettingsSection>
	);
}
