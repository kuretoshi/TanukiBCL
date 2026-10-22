import React, { useState } from 'react';
import { TFunction } from 'i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { AmongUsState } from '../../../common/AmongUsState';
import { ILobbySettings, ISettings } from '../../../common/ISettings';
import { isLiteRuntime } from '../../../common/appVariant';
import { defaultLobbySettings } from '../../voice/types';
import TestVoiceEffectButton from '../TestVoiceEffectButton';
import { SettingsSection, SliderRow } from '../SettingsControls';

interface Props {
	t: TFunction;
	settings: ISettings;
	setSettings: <K extends keyof ISettings>(setting: K, value: ISettings[K], persist?: boolean) => void;
	gameState: AmongUsState;
	activeLobbySettings: ILobbySettings | null;
	myLobbySettings: ILobbySettings;
	update: (partial: Partial<ILobbySettings>) => void;
}

const VoiceEffectsSection: React.FC<Props> = ({
	t,
	settings,
	setSettings,
	gameState,
	activeLobbySettings,
	myLobbySettings,
	update,
}) => {
	const [selectedTab, setTab] = useState<'current' | 'mine'>(gameState?.isHost ? 'mine' : 'current');
	const lite = isLiteRuntime();
	const tab = lite ? 'current' : selectedTab;
	const current = tab === 'current';
	const inLobby = activeLobbySettings !== null && !!gameState?.lobbyCode && gameState.lobbyCode !== 'MENU';
	const values = current ? activeLobbySettings : (myLobbySettings ?? defaultLobbySettings);
	const disabled = current;
	const mod = gameState?.mod;
	const showSnr = mod === 'SUPER_NEW_ROLES';
	const showNos = mod === 'NoS';
	const uchuAddonDetected = gameState?.mod === 'NoS' && gameState.nosAddonIds?.includes('UchuAddon') === true;
	const tanukiAddonDetected = gameState?.mod === 'NoS' && gameState.nosAddonIds?.includes('tanuki.bcl.roles') === true;
	const updateSetting = current ? (_: Partial<ILobbySettings>) => {} : update;

	return (
		<>
			<SettingsSection title={t('settings.voice_effects.title')}>
				<SliderRow
					label={t('settings.voice_effects.disguise_strength')}
					value={settings.voiceEffectStrength}
					min={0}
					max={100}
					format={(value) => `${value}%`}
					onChange={(value, persist) => setSettings('voiceEffectStrength', value, persist)}
				/>
				<Box sx={{ display: 'flex', justifyContent: 'center', px: 2, py: 2 }}>
					<TestVoiceEffectButton
						t={t}
						microphone={settings.microphone}
						speaker={settings.speaker}
						voiceEffectStrength={settings.voiceEffectStrength}
					/>
				</Box>
			</SettingsSection>
			<Tabs
				value={tab}
				onChange={(_, value: 'current' | 'mine') => setTab(value)}
				sx={{ mb: 2, minHeight: 36, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
			>
				<Tab value="current" label={t('settings.lobbysettings.tab_current')} sx={{ minHeight: 36, py: 0 }} />
				{!lite && <Tab value="mine" label={t('settings.lobbysettings.tab_mine')} sx={{ minHeight: 36, py: 0 }} />}
			</Tabs>
			{current && !inLobby && <Alert severity="info">{t('settings.lobbysettings.no_lobby')}</Alert>}
			{values && (!current || inLobby) && (
				<>
					{showSnr && (
						<SettingsSection title={t('settings.lobbysettings.snr_voice_effects')}>
							<SliderRow
								label={t('settings.voice_effects.snr_jumbo_strength')}
								disabled={disabled}
								value={values.snrJumboVoiceEffectStrength ?? 100}
								min={0}
								max={100}
								step={5}
								format={(value) => `${value}%`}
								commitOnly
								onChange={(snrJumboVoiceEffectStrength) => updateSetting({ snrJumboVoiceEffectStrength })}
							/>
						</SettingsSection>
					)}
					{showNos && (
						<SettingsSection title={t('settings.lobbysettings.nos_voice_effects')}>
							{(
								[
									['nosSizeVoiceEffectStrength', 'nos_size_strength'],
									['nosRokurokubiVoiceEffectStrength', 'nos_rokurokubi_strength'],
									['nosBerserkerVoiceEffectStrength', 'nos_berserker_strength'],
									...(uchuAddonDetected
										? [
												['nosCitrusVoiceEffectStrength', 'nos_citrus_strength'],
												['nosRainbowStarEchoStrength', 'nos_rainbow_star_strength'],
											]
										: []),
								] as Array<[keyof ILobbySettings, string]>
							).map(([strengthKey, label]) => (
									<SliderRow
										key={strengthKey}
										label={t(`settings.voice_effects.${label}`)}
										disabled={disabled}
										value={(values[strengthKey] as number) ?? 100}
										min={0}
										max={100}
										step={5}
										format={(value) => `${value}%`}
										commitOnly
										onChange={(value) => updateSetting({ [strengthKey]: value })}
									/>
							))}
							{(
								(tanukiAddonDetected ? [
									['nosVoiceJammingEffectStrength', 'nos_voice_jamming_effect'],
									['nosMegaphoneEffectStrength', 'nos_megaphone_effect'],
									['nosBibiriEchoStrength', 'nos_bibiri_echo'],
								] : []) as Array<[keyof ILobbySettings, string]>
							).map(([strengthKey, label]) => (
								<SliderRow
									key={strengthKey}
									label={t(`settings.lobbysettings.${label}`)}
									disabled={disabled}
									value={(values[strengthKey] as number) ?? 100}
									min={0}
									max={100}
									step={5}
									format={(value) => `${value}%`}
									commitOnly
									onChange={(value) => updateSetting({ [strengthKey]: value })}
								/>
							))}
						</SettingsSection>
					)}
				</>
			)}
		</>
	);
};

export default VoiceEffectsSection;
