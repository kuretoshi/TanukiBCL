import React from 'react';
import Button from '@mui/material/Button';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField } from '@mui/material';
import { TFunction } from 'i18next';
import { ISettings } from '../../../common/ISettings';
import { ipcRenderer } from '../../lib/electron-bridge';
import ServerURLInput from '../ServerURLInput';
import { ConfirmApi, SelectRow, SettingRow, SettingsSection, SwitchRow } from '../SettingsControls';

export interface AdvancedSectionProps {
	t: TFunction;
	settings: ISettings;
	setSettings: <K extends keyof ISettings>(setting: K, value: ISettings[K]) => void;
	confirm: ConfirmApi['confirm'];
}

const AdvancedSection: React.FC<AdvancedSectionProps> = function ({ t, settings, setSettings, confirm }) {
	const [passwordOpen, setPasswordOpen] = React.useState(false);
	const [password, setPassword] = React.useState('');
	const [passwordError, setPasswordError] = React.useState('');
	const [authenticating, setAuthenticating] = React.useState(false);
	const closePassword = () => {
		if (authenticating) return;
		setPasswordOpen(false);
		setPassword('');
		setPasswordError('');
	};
	const authenticate = async () => {
		if (authenticating || !password) return;
		setAuthenticating(true);
		try {
			if (await ipcRenderer.invoke('OPEN_DEBUG', password)) {
				setPasswordOpen(false);
				setPasswordError('');
			} else setPasswordError('認証できませんでした。パスワードと開発者用の設定を確認してください。');
		} catch {
			setPasswordError('認証処理に失敗しました。再試行してください。');
		} finally {
			setPassword('');
			setAuthenticating(false);
		}
	};
	return (
		<>
			<Dialog open={passwordOpen} onClose={closePassword} fullWidth maxWidth="xs">
				<DialogTitle>開発者認証</DialogTitle>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void authenticate();
					}}
				>
					<DialogContent>
						<TextField
							autoFocus
							fullWidth
							type="password"
							label="パスワード"
							value={password}
							disabled={authenticating}
							error={!!passwordError}
							helperText={passwordError || '開発者用パスワードを入力してください。'}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</DialogContent>
					<DialogActions>
						<Button onClick={closePassword} disabled={authenticating}>
							キャンセル
						</Button>
						<Button type="submit" disabled={authenticating || !password}>
							開く
						</Button>
					</DialogActions>
				</form>
			</Dialog>
			<SettingsSection title={t('settings.advanced.title')}>
				<SelectRow
					label={t('settings.advanced.voice_server')}
					value={settings.serverURL}
					options={[...new Set([...(settings.serverURLs || []), settings.serverURL])].map((url) => ({
						value: url,
						label: url,
					}))}
					onChange={(url) => setSettings('serverURL', url)}
				/>
				<SwitchRow
					label={t('settings.advanced.nat_fix')}
					description={t('settings.advanced.nat_fix_warning')}
					checked={settings.natFix}
					onChange={(checked) =>
						confirm(
							t('settings.warning'),
							t('settings.advanced.nat_fix_warning'),
							() => setSettings('natFix', checked),
							checked
						)
					}
				/>
				<SettingRow
					label={t('settings.advanced.voice_server')}
					description={settings.serverURL}
					controlWidth="auto"
					control={
						<ServerURLInput
							t={t}
							initialURL={settings.serverURL}
							onValidURL={(url) => {
								setSettings('serverURLs', [...new Set([...(settings.serverURLs || []), url])]);
								setSettings('serverURL', url);
							}}
							sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}
						/>
					}
				/>
			</SettingsSection>

			<SettingsSection title="デバッグ">
				<SettingRow
					label="デバッグ情報"
					description="ゲーム状態・音声接続・ログを別ウィンドウで表示します。"
					controlWidth="auto"
					control={
						<Button variant="outlined" onClick={() => setPasswordOpen(true)}>
							デバッグ情報を開く
						</Button>
					}
				/>
			</SettingsSection>
			<SettingsSection title={t('settings.beta.title')}>
				<SwitchRow
					label={t('settings.beta.mobilehost')}
					checked={settings.mobileHost}
					onChange={(checked) => setSettings('mobileHost', checked)}
				/>
				<SwitchRow
					label={t('settings.beta.hardware_acceleration')}
					description={t('settings.beta.hardware_acceleration_warning')}
					checked={settings.hardware_acceleration}
					onChange={(checked) =>
						confirm(
							t('settings.warning'),
							t('settings.beta.hardware_acceleration_warning'),
							() => {
								setSettings('hardware_acceleration', checked);
								ipcRenderer.send('relaunch');
							},
							!checked
						)
					}
				/>
				<SwitchRow
					label={t('settings.beta.echocancellation')}
					checked={settings.echoCancellation}
					onChange={(checked) => setSettings('echoCancellation', checked)}
				/>
				<SwitchRow
					label={t('settings.beta.spatial_audio')}
					checked={settings.enableSpatialAudio}
					onChange={(checked) => setSettings('enableSpatialAudio', checked)}
				/>
				<SwitchRow
					label={t('settings.beta.noiseSuppression')}
					checked={settings.noiseSuppression}
					onChange={(checked) => setSettings('noiseSuppression', checked)}
				/>
				<SwitchRow
					label={t('settings.beta.oldsampledebug')}
					description={t('settings.beta.oldsampledebug_warning')}
					checked={settings.oldSampleDebug}
					onChange={(checked) =>
						confirm(
							t('settings.warning'),
							t('settings.beta.oldsampledebug_warning'),
							() => setSettings('oldSampleDebug', checked),
							checked
						)
					}
				/>
			</SettingsSection>
		</>
	);
};

export default AdvancedSection;
