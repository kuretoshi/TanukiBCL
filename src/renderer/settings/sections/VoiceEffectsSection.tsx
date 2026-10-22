import React, { useState } from 'react';
import { TFunction } from 'i18next';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import { AmongUsState } from '../../../common/AmongUsState';
import { ISettings } from '../../../common/ISettings';
import TestVoiceEffectButton, { VoiceEffectPreviewKind } from '../TestVoiceEffectButton';
import { SettingsSection, SliderRow } from '../SettingsControls';

interface Props {
	t: TFunction;
	settings: ISettings;
	setSettings: <K extends keyof ISettings>(setting: K, value: ISettings[K], persist?: boolean) => void;
	gameState: AmongUsState;
}

type StrengthKey = VoiceEffectPreviewKind;
type EffectRow = { key: StrengthKey; label: string };

const VoiceEffectsSection: React.FC<Props> = ({ t, settings, setSettings, gameState }) => {
	const [selectedPreview, setSelectedPreview] = useState<StrengthKey>('voiceEffectStrength');
	const showSnr = gameState?.mod === 'SUPER_NEW_ROLES';
	const showNos = gameState?.mod === 'NoS';
	const uchuAddonDetected = showNos && gameState.nosAddonIds?.includes('UchuAddon') === true;
	const tanukiAddonDetected = showNos && gameState.nosAddonIds?.includes('tanuki.bcl.roles') === true;
	const common: EffectRow[] = [{ key: 'voiceEffectStrength', label: t('settings.voice_effects.disguise_strength') }];
	const snr: EffectRow[] = showSnr
		? [{ key: 'snrJumboVoiceEffectStrength', label: t('settings.voice_effects.snr_jumbo_strength') }]
		: [];
	const nos: EffectRow[] = showNos
		? [
				{ key: 'nosSizeVoiceEffectStrength', label: t('settings.voice_effects.nos_size_strength') },
				{ key: 'nosRokurokubiVoiceEffectStrength', label: t('settings.voice_effects.nos_rokurokubi_strength') },
				{ key: 'nosBerserkerVoiceEffectStrength', label: t('settings.voice_effects.nos_berserker_strength') },
				...(uchuAddonDetected
					? [
							{ key: 'nosCitrusVoiceEffectStrength' as const, label: t('settings.voice_effects.nos_citrus_strength') },
							{ key: 'nosRainbowStarEchoStrength' as const, label: t('settings.voice_effects.nos_rainbow_star_strength') },
						]
					: []),
				...(tanukiAddonDetected
					? [
							{ key: 'nosVoiceJammingEffectStrength' as const, label: t('settings.lobbysettings.nos_voice_jamming_effect') },
							{ key: 'nosMegaphoneEffectStrength' as const, label: t('settings.lobbysettings.nos_megaphone_effect') },
							{ key: 'nosBibiriEchoStrength' as const, label: t('settings.lobbysettings.nos_bibiri_echo') },
						]
					: []),
			]
		: [];
	const available = [...common, ...snr, ...nos];
	const preview = available.find((row) => row.key === selectedPreview)?.key ?? 'voiceEffectStrength';
	const slider = ({ key, label }: EffectRow) => (
		<SliderRow
			key={key}
			label={label}
			value={settings[key] ?? 100}
			min={0}
			max={100}
			step={5}
			format={(value) => `${value}%`}
			onChange={(value, persist) => setSettings(key, value, persist)}
		/>
	);

	return (
		<>
			<SettingsSection title={t('settings.voice_effects.title')}>
				{common.map(slider)}
			</SettingsSection>
			{showSnr && <SettingsSection title={t('settings.lobbysettings.snr_voice_effects')}>{snr.map(slider)}</SettingsSection>}
			{showNos && <SettingsSection title={t('settings.lobbysettings.nos_voice_effects')}>{nos.map(slider)}</SettingsSection>}
			<SettingsSection title={t('settings.voice_effects.preview_title')}>
				<Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 1, px: 2, py: 2 }}>
					<TextField
						select
						size="small"
						label={t('settings.voice_effects.preview_target')}
						value={preview}
						onChange={(event) => setSelectedPreview(event.target.value as StrengthKey)}
						slotProps={{ select: { native: true } }}
						sx={{ minWidth: 180, flex: '1 1 240px', maxWidth: 320 }}
					>
						{available.map((row) => <option key={row.key} value={row.key}>{row.label}</option>)}
					</TextField>
					<TestVoiceEffectButton
						key={preview}
						t={t}
						microphone={settings.microphone}
						speaker={settings.speaker}
						effectKind={preview}
						voiceEffectStrength={settings[preview] ?? 100}
					/>
				</Box>
			</SettingsSection>
		</>
	);
};

export default VoiceEffectsSection;
