import React from 'react';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import { ILobbySettings } from '../../../common/ISettings';
import { setTohGhostRole, tohGhostRoleEnabled, tohGhostRoleGroups } from '../../../common/TohGhostRoles';
import { SettingsSection, SwitchRow } from '../SettingsControls';

interface Props {
	values: ILobbySettings;
	disabled: boolean;
	disabledReason?: string;
	update: (partial: Partial<ILobbySettings>) => void;
	onBack: () => void;
}

const TohGhostRoleSettings: React.FC<Props> = ({ values, disabled, disabledReason, update, onBack }) => (
	<>
		<Button onClick={onBack} sx={{ mb: 1 }}>
			← MOD設定に戻る
		</Button>
		<Typography variant="h6" sx={{ mb: 1 }}>
			幽霊の声が聞こえる役職設定
		</Typography>
		<Alert severity="info" sx={{ mb: 2 }}>
			有効にした役職は、生存中も幽霊の声を聞けます。インポスターは通常のロビー設定で変更できます。
			{disabled && ` ${disabledReason || 'このロビーのホスト設定を表示しています。'}`}
		</Alert>
		{tohGhostRoleGroups.map((group) => (
			<SettingsSection key={group.label} title={group.label}>
				{group.roles.map(([key, label]) => (
					<SwitchRow
						key={key}
						label={label}
						disabled={disabled}
						disabledReason={disabledReason}
						checked={tohGhostRoleEnabled(values, key)}
						onChange={(checked) => update(setTohGhostRole(values, key, checked))}
					/>
				))}
			</SettingsSection>
		))}
	</>
);

export default TohGhostRoleSettings;
