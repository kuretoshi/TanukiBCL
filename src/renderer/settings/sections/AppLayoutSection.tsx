import React from 'react';
import { TFunction } from 'i18next';
import { AppPlayerLayout, ISettings } from '../../../common/ISettings';
import { SelectRow, SettingsSection } from '../SettingsControls';

export interface AppLayoutSectionProps {
	t: TFunction;
	settings: ISettings;
	setSettings: <K extends keyof ISettings>(setting: K, value: ISettings[K]) => void;
}

const AppLayoutSection: React.FC<AppLayoutSectionProps> = function ({ t, settings, setSettings }) {
	return (
		<SettingsSection title={t('settings.app_layout.title')}>
			<SelectRow
				label={t('settings.app_layout.player_order')}
				value={settings.appPlayerLayout}
				options={[
					{ value: 'standard', label: t('settings.app_layout.standard') },
					{ value: 'aliveAboveGhosts', label: t('settings.app_layout.alive_above_ghosts') },
				]}
				onChange={(value) => setSettings('appPlayerLayout', value as AppPlayerLayout)}
			/>
		</SettingsSection>
	);
};

export default AppLayoutSection;
