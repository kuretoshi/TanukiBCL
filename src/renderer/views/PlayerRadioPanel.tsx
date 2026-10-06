import React from 'react';
import { Box, Chip, Typography } from '@mui/material';
import { AmongUsState, Player } from '../../common/AmongUsState';
import type { NosRadioReports } from './NosDebugPanel';

const kindNames: Record<number, string> = { 0: 'Impostor', 1: 'Jackal', 2: 'Lovers' };

export default function PlayerRadioPanel({
	player,
	gameState,
	radioReports,
	radioClientIds,
}: {
	player: Player;
	gameState: AmongUsState;
	radioReports?: NosRadioReports;
	radioClientIds?: number[];
}): React.JSX.Element {
	const active = radioClientIds?.includes(player.clientId);
	const report = radioReports?.[player.id];
	const radios = player.isLocal
		? gameState.nosRadios
		: report?.clientId === player.clientId
			? report.radios
			: undefined;
	return (
		<Box sx={{ mt: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, overflowWrap: 'anywhere' }}>
			<Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
				<Typography variant="subtitle2">Radio</Typography>
				<Chip
					size="small"
					variant="outlined"
					color={active == null ? 'warning' : active ? 'success' : 'default'}
					label={active == null ? '無線送信状態：未取得' : active ? '無線送信：ON' : '無線送信：OFF'}
				/>
			</Box>
			{gameState.mod === 'NoS' && (
				<>
					<Typography variant="caption" color="text.secondary">
						RadioData（話せるチャンネル）:{' '}
						{radios ? `${radios.length}件` : player.isLocal ? '未取得' : '相手から未受信'}
					</Typography>
					{radios?.length === 0 && <Typography variant="body2">利用できるチャンネルなし</Typography>}
					{radios?.map((radio, index) => {
						const recipients = Array.from({ length: 32 }, (_, id) => id)
							.filter((id) => ((radio.hearableMask >>> id) & 1) !== 0)
							.map((id) => {
								const recipient = gameState.players?.find((candidate) => candidate.id === id);
								return recipient ? `${recipient.name}（ID: ${id}）` : `ID: ${id}`;
							});
						return (
							<Box key={index} sx={{ mt: 1, pl: 1, borderLeft: 2, borderColor: 'divider' }}>
								<Typography variant="body2">
									#{index} {radio.name || '名称なし'} ／ Kind: {radio.kind} ({kindNames[radio.kind] ?? 'Unknown'}) ／
									NameLength: {radio.nameLength}
								</Typography>
								<Typography variant="body2">声が届く対象: {recipients.join('、') || 'なし'}</Typography>
								<Typography variant="caption" color="text.secondary">
									HearableMask: {radio.hearableMask} / 0x
									{(radio.hearableMask >>> 0).toString(16).toUpperCase().padStart(8, '0')}
								</Typography>
							</Box>
						);
					})}
				</>
			)}
		</Box>
	);
}
