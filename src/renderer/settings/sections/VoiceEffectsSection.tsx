import React, { useState } from 'react';
import { TFunction } from 'i18next';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AmongUsState } from '../../../common/AmongUsState';
import { hasTanukiAddon } from '../../../common/tanukiAddon';
import { ISettings } from '../../../common/ISettings';
import { getVoiceEffectTuning, type VoiceEffectId, type VoiceEffectTuning } from '../../../common/VoiceEffectTuning';
import TestVoiceEffectButton from '../TestVoiceEffectButton';
import { getRokuroVoice } from '../../../common/RokuroVoice';
import { SettingsSection, SliderRow } from '../SettingsControls';

interface Props {
	t: TFunction;
	settings: ISettings;
	setSettings: <K extends keyof ISettings>(setting: K, value: ISettings[K], persist?: boolean) => void;
	gameState: AmongUsState;
}

type EffectRow = { id: VoiceEffectId; label: string };

const VoiceEffectsSection: React.FC<Props> = ({ t, settings, setSettings, gameState }) => {
	const [selectedEffect, setSelectedEffect] = useState<VoiceEffectId>('disguise');
	const showSnr = gameState?.mod === 'SUPER_NEW_ROLES';
	const showNos = gameState?.mod === 'NoS';
	const uchuAddonDetected = showNos && gameState.nosAddonIds?.includes('UchuAddon') === true;
	const tanukiAddonDetected = hasTanukiAddon(gameState);
	const common: EffectRow[] = [{ id: 'disguise', label: t('settings.voice_effects.disguise_strength') }];
	const snr: EffectRow[] = showSnr
		? [
				{ id: 'snrJumbo', label: t('settings.voice_effects.snr_jumbo_strength') },
				{ id: 'snrPush', label: t('settings.voice_effects.snr_push_reverb_strength') },
			]
		: [];
	const nos: EffectRow[] = showNos
		? [
				{ id: 'nosSize', label: t('settings.voice_effects.nos_size_strength') },
				{ id: 'nosRokurokubi', label: t('settings.voice_effects.nos_rokurokubi_strength') },
				{ id: 'nosBerserker', label: t('settings.voice_effects.nos_berserker_strength') },
				...(uchuAddonDetected
					? [
							{ id: 'nosCitrus' as const, label: t('settings.voice_effects.nos_citrus_strength') },
							{ id: 'nosRainbowStar' as const, label: t('settings.voice_effects.nos_rainbow_star_strength') },
						]
					: []),
				...(tanukiAddonDetected
					? [
							{ id: 'nosVoiceJamming' as const, label: t('settings.lobbysettings.nos_voice_jamming_effect') },
							{ id: 'nosMegaphone' as const, label: t('settings.lobbysettings.nos_megaphone_effect') },
							{ id: 'nosBibiri' as const, label: t('settings.lobbysettings.nos_bibiri_echo') },
						]
					: []),
			]
		: [];
	const available = [...common, ...snr, ...nos];
	const effectId = available.find(({ id }) => id === selectedEffect)?.id ?? 'disguise';
	const tuning = getVoiceEffectTuning(settings, effectId);
	const rokuro = getRokuroVoice(settings.rokuroVoice);
	const updateTuning = (axis: keyof VoiceEffectTuning, value: number, persist: boolean) =>
		setSettings(
			'voiceEffectTunings',
			{ ...settings.voiceEffectTunings, [effectId]: { ...tuning, [axis]: value } },
			persist
		);
	const groups = [
		{ label: t('settings.voice_effects.common'), rows: common },
		{ label: t('settings.lobbysettings.snr_voice_effects'), rows: snr },
		{ label: t('settings.lobbysettings.nos_voice_effects'), rows: nos },
	];
	return (
		<SettingsSection title={t('settings.voice_effects.title')}>
			<Box sx={{ px: 2, py: 1.5 }}>
				<TextField
					select
					fullWidth
					size="small"
					label={t('settings.voice_effects.preview_target')}
					value={effectId}
					onChange={(event) => setSelectedEffect(event.target.value as VoiceEffectId)}
					slotProps={{ select: { native: true } }}
				>
					{groups
						.filter(({ rows }) => rows.length > 0)
						.map(({ label, rows }) => (
							<optgroup key={label} label={label}>
								{rows.map(({ id, label: effectLabel }) => (
									<option key={id} value={id}>
										{effectLabel}
									</option>
								))}
							</optgroup>
						))}
				</TextField>
				<Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
					{t('settings.voice_effects.tuning_help')}
				</Typography>
			</Box>
			<Box key={effectId}>
				<SliderRow
					label={t('settings.voice_effects.pitch')}
					description={t('settings.voice_effects.pitch_help')}
					value={tuning.pitch}
					min={-100}
					max={100}
					step={5}
					marks={[{ value: 0, label: '0' }]}
					format={(value) => `${value > 0 ? '+' : ''}${value}`}
					onChange={(value, persist) => updateTuning('pitch', value, persist)}
				/>
				{(['reverb', 'echo'] as const).map((axis) => (
					<SliderRow
						key={axis}
						label={t(`settings.voice_effects.${axis}`)}
						value={tuning[axis]}
						min={0}
						max={100}
						step={5}
						format={(value) => `${value}%`}
						onChange={(value, persist) => updateTuning(axis, value, persist)}
					/>
				))}
			</Box>
			<Box sx={{ display: 'flex', justifyContent: 'center', px: 2, py: 1.5 }}>
				{effectId === 'nosRokurokubi' && (
					<Box sx={{ width: '100%' }}>
						<Typography sx={{ px: 2, py: 1 }}>
							首が伸びている間は顔と身体の両方から声が聞こえます。身体はこもったエコー音声です。
						</Typography>
						{(
							[
								['headVolume', '顔の音量'],
								['bodyVolume', '身体の音量'],
								['bodyEcho', '身体のエコー'],
							] as const
						).map(([key, label]) => (
							<SliderRow
								key={key}
								label={label}
								value={rokuro[key]}
								min={0}
								max={100}
								step={5}
								format={(value) => `${value}%`}
								onChange={(value, persist) => setSettings('rokuroVoice', { ...rokuro, [key]: value }, persist)}
							/>
						))}
					</Box>
				)}
			</Box>
			<Box sx={{ display: 'flex', justifyContent: 'center', px: 2, py: 1.5 }}>
				<TestVoiceEffectButton
					key={effectId}
					t={t}
					microphone={settings.microphone}
					speaker={settings.speaker}
					effectKind={effectId}
					tuning={tuning}
				/>
			</Box>
		</SettingsSection>
	);
};
export default VoiceEffectsSection;
