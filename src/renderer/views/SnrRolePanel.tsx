import React from 'react';
import { Box, Typography, Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material';
import { AmongUsState } from '../../common/AmongUsState';
import type { SnrEnumValue } from '../../common/SnrRole';

const label = (value: SnrEnumValue | null | undefined) =>
	value ? `${value.name ?? '名称不明'} (${value.value})` : '未取得';

export default function SnrRolePanel({ gameState }: { gameState: AmongUsState }): React.JSX.Element {
	const players = gameState.players ?? [];
	return (
		<Box sx={{ p: 2, userSelect: 'text', overflowX: 'auto' }}>
			<Typography variant="body2" sx={{ mb: 1 }}>
				役職・追加属性・幽霊役職は常時更新します。割り当て陣営・勝利陣営・チームは既存の自動取得結果で約5秒ごとに更新します。
			</Typography>
			<Typography variant="caption" color="text.secondary">
				{gameState.debug?.snrRoleStatus || 'SNR情報を自動取得中…'}
			</Typography>
			<Table size="small" sx={{ mt: 1, '& th, & td': { verticalAlign: 'top' } }}>
				<TableHead>
					<TableRow>
						{['プレイヤー / ID', 'SNR役職', '割り当て陣営', '勝利陣営', 'チーム', '追加属性', '幽霊役職'].map(
							(title) => (
								<TableCell key={title}>{title}</TableCell>
							)
						)}
					</TableRow>
				</TableHead>
				<TableBody>
					{players.map((player) => (
						<TableRow key={player.id} selected={player.isLocal}>
							<TableCell>
								{player.name}
								{player.isLocal ? '（自分）' : ''}
								<br />
								ID: {player.id}
							</TableCell>
							<TableCell>{label(player.snrRole?.role)}</TableCell>
							<TableCell>{label(player.snrRole?.assignedTeam)}</TableCell>
							<TableCell>{label(player.snrRole?.winnerTeam)}</TableCell>
							<TableCell>{label(player.snrRole?.teamTag)}</TableCell>
							<TableCell>
								{player.snrRole?.modifier ? label(player.snrRole.modifier) : player.snrRole ? 'なし' : '未取得'}
							</TableCell>
							<TableCell>
								{player.snrRole?.ghostRole ? label(player.snrRole.ghostRole) : player.snrRole ? 'なし' : '未取得'}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{!players.length && <Typography sx={{ mt: 1 }}>プレイヤー情報を待っています…</Typography>}
		</Box>
	);
}
