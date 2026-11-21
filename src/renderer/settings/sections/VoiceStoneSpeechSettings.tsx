import React from 'react';
import { Button, FormControlLabel, Switch, Typography } from '@mui/material';
import { ipcRenderer, shell } from '../../lib/electron-bridge';
import { SettingsSection } from '../SettingsControls';
export default function VoiceStoneSpeechSettings(): React.ReactElement {
	const [local, setLocal] = React.useState({ available: false, enabled: false, error: '' });
	React.useEffect(() => {
		void ipcRenderer.invoke('VOICE_STONE_LOCAL_STATUS').then((v) => {
			if (v) setLocal(v as typeof local);
		});
	}, []);
	return (
		<SettingsSection title="ボイスストーンの音声認識">
			<FormControlLabel
				label="共有モデルで認識する（Silero VAD＋SenseVoice）"
				control={
					<Switch
						checked={local.enabled}
						disabled={!local.available}
						onChange={async (_, enabled) => {
							if (await ipcRenderer.invoke('VOICE_STONE_LOCAL_SET', enabled)) setLocal({ ...local, enabled });
						}}
					/>
				}
			/>
			<Typography variant="body2">
				{local.available
					? '通常は共有モデルを使用します。録音時間の終了後に判定します。PCは各自、Web・モバイル分はホストが認識します。オフにすると従来の軽量方式を使います。'
					: '共有モデルが未準備のため、従来の軽量ローカル認識を使用します。'}
			</Typography>
			<Typography variant="body2">{local.error}</Typography>
			<Button
				onClick={() =>
					shell.openExternal(
						'https://github.com/kuretoshi/TanukiBCL/releases/download/v3.2.69/TanukiBCL-SharedSpeech-Setup-2.0.2.1.exe'
					)
				}
			>
				共有モデルをダウンロード
			</Button>
			<Typography variant="body2">
				初回のみインストーラーを実行後、ベタクルを再起動してください。各版で同じモデルを使います。タヌキ丼未検出時はモデルを読み込みません。
			</Typography>
		</SettingsSection>
	);
}
