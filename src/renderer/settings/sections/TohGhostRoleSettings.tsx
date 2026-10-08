import React from 'react';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import { ILobbySettings } from '../../../common/ISettings';
import { TohRoleDefinition } from '../../../common/TohRole';
import {
	setTohGhostRole,
	setTohGhostRoleGroup,
	tohGhostRoleEnabled,
	tohGhostRoleGroups,
} from '../../../common/TohGhostRoles';
import { SettingsSection, SwitchRow } from '../SettingsControls';

interface Props {
	values: ILobbySettings;
	catalog: readonly TohRoleDefinition[];
	disabled: boolean;
	disabledReason?: string;
	update: (partial: Partial<ILobbySettings>) => void;
	onBack: () => void;
}

const TohGhostRoleSettings: React.FC<Props> = ({ values, catalog, disabled, disabledReason, update, onBack }) => (
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
		{catalog.length === 0 && (
			<Alert severity="info">役職一覧の取得待ちです。TOH4E系のロビーに入り、ホストからの受信をお待ちください。</Alert>
		)}
		{tohGhostRoleGroups(catalog).map((group) => (
			<SettingsSection key={group.label} title={group.label}>
				<SwitchRow
					label={`${group.label}を一括設定`}
					description={`${group.roles.filter((role) => tohGhostRoleEnabled(values, role.roleName)).length} / ${group.roles.length} 役職がオン`}
					disabled={disabled || group.roles.length === 0}
					disabledReason={disabledReason}
					checked={group.roles.length > 0 && group.roles.every((role) => tohGhostRoleEnabled(values, role.roleName))}
					onChange={(checked) => update(setTohGhostRoleGroup(values, group.type, checked, catalog))}
				/>
				{group.roles.map(({ roleName: key, displayName: label }) => (
					<SwitchRow
						key={key}
						label={label}
						disabled={disabled}
						disabledReason={disabledReason}
						checked={tohGhostRoleEnabled(values, key)}
						onChange={(checked) => update(setTohGhostRole(values, key, checked, catalog))}
					/>
				))}
			</SettingsSection>
		))}
	</>
);

export default TohGhostRoleSettings;
