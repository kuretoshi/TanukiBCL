import React, { useState } from 'react';
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Alert,
	Box,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableRow,
	TextField,
	Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { AmongUsState } from '../../common/AmongUsState';
import type { NosRadioData } from '../../common/NosSnapshot';

export type NosRadioReports = Record<number, { clientId: number; radios: NosRadioData[]; receivedAt: number }>;
const radioKindNames: Record<number, string> = { 0: 'Impostor', 1: 'Jackal', 2: 'Lovers' };

function hearablePlayerIds(mask: number): string {
	const ids = Array.from({ length: 32 }, (_, id) => id).filter((id) => ((mask >>> id) & 1) !== 0);
	return ids.length ? ids.join(', ') : 'なし';
}

const tableStyles = { '& th, & td': { verticalAlign: 'top', overflowWrap: 'anywhere', minWidth: 100 } };

export default function NosDebugPanel({
	gameState,
	radioReports,
}: {
	gameState: AmongUsState;
	radioReports?: NosRadioReports;
}): React.JSX.Element {
	const [query, setQuery] = useState('');
	const [showJson, setShowJson] = useState(false);
	if (gameState.mod !== 'NoS')
		return (
			<Alert severity="info" sx={{ m: 2 }}>
				NoSを起動すると取得情報を表示します。
			</Alert>
		);
	const players = gameState.players ?? [];
	const search = query.trim().toLocaleLowerCase();
	const filtered = players.filter((player) =>
		[
			player.name,
			String(player.id),
			player.nosPlayer?.skin?.name,
			player.nosPlayer?.hat?.name,
			player.nosPlayer?.visor?.name,
		].some((value) => value?.toLocaleLowerCase().includes(search))
	);
	const status = gameState.nosReadStatus;
	const active = players.filter((player) => !player.disconnected);
	const missing = active.filter((player) => !player.nosPlayer);
	const contents = gameState.nosLoadedContents;
	return (
		<Box sx={{ p: 2, userSelect: 'text' }}>
			<Alert severity={status?.failed ? 'error' : missing.length || !active.length || !status ? 'info' : 'success'}>
				<Typography variant="subtitle2">NoSデータの取得状態</Typography>
				{status?.message || 'データの取得を待っています。'}
			</Alert>
			<Typography variant="body2" sx={{ my: 1 }}>
				TBCLFields Version: {status?.schemaVersion ?? '未取得'} ／ プレイヤーデータ: {active.length - missing.length} /{' '}
				{active.length}人
			</Typography>
			{missing.length > 0 && (
				<Typography variant="body2" color="warning.main" sx={{ mb: 1 }}>
					未取得: {missing.map((player) => `${player.name}（ID: ${player.id}）`).join('、')}
				</Typography>
			)}
			<TextField
				label="プレイヤー名・ID・コスチューム名で検索"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				size="small"
				fullWidth
				sx={{ my: 1 }}
			/>
			<Typography variant="subtitle2" sx={{ mt: 1 }}>
				コスチューム（CostumeData）
			</Typography>
			<Box sx={{ overflowX: 'auto' }}>
				<Table size="small" sx={tableStyles}>
					<TableHead>
						<TableRow>
							{['プレイヤー / ID', 'Skin', 'Hat', 'Visor', '画像の参照'].map((label) => (
								<TableCell key={label}>{label}</TableCell>
							))}
						</TableRow>
					</TableHead>
					<TableBody>
						{filtered.map((player) => (
							<TableRow key={player.id} selected={player.isLocal}>
								<TableCell>
									{player.name}
									{player.isLocal ? '（自分）' : ''}
									<br />
									ID: {player.id}
									{player.disconnected ? ' / 切断' : ''}
								</TableCell>
								{(['skin', 'hat', 'visor'] as const).map((part) => (
									<TableCell key={part}>{player.nosPlayer?.[part]?.name ?? '未取得'}</TableCell>
								))}
								<TableCell>
									{Object.entries(player.nosCosmetics ?? {})
										.filter(([, url]) => !!url)
										.map(([part]) => part)
										.join(', ') || 'ローカル画像の参照なし'}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Box>
			{filtered.length === 0 && (
				<Typography variant="body2" sx={{ py: 1 }}>
					{players.length ? '検索に一致するプレイヤーはいません。' : 'プレイヤー情報を待っています…'}
				</Typography>
			)}
			<Typography variant="caption" color="text.secondary">
				画像の参照は登録された描画用URLの種類です。画像の表示成功を示すものではありません。
			</Typography>
			<Accordion sx={{ mt: 2 }} expanded={showJson} onChange={(_, expanded) => setShowJson(expanded)}>
				<AccordionSummary expandIcon={<ExpandMoreIcon />}>
					<Typography variant="subtitle2">LoadedContents.json の詳細</Typography>
				</AccordionSummary>
				<AccordionDetails>
					<Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
						{contents?.path || 'パス未取得'}
						<br />
						{contents?.status || '未取得'}
					</Typography>
					{showJson && contents?.data !== undefined && (
						<Box component="pre" sx={{ maxHeight: 300, overflow: 'auto', fontSize: 12 }}>
							{JSON.stringify(contents.data, null, 2)}
						</Box>
					)}
				</AccordionDetails>
			</Accordion>
			<Accordion sx={{ mt: 1 }}>
				<AccordionSummary expandIcon={<ExpandMoreIcon />}>
					<Typography variant="subtitle2">無線チャンネル（RadioData）</Typography>
				</AccordionSummary>
				<AccordionDetails>
					{filtered.map((player) => {
						const report = radioReports?.[player.id];
						const radios = player.isLocal
							? gameState.nosRadios
							: report?.clientId === player.clientId
								? report.radios
								: undefined;
						return (
							<Box key={player.id} sx={{ mb: 1, overflowWrap: 'anywhere' }}>
								<Typography variant="body2" sx={{ fontWeight: 'bold' }}>
									{player.name} / PlayerId: {player.id} / ClientId: {player.clientId} ／{' '}
									{radios ? `${radios.length}件` : player.isLocal ? '未取得' : '相手から未受信'}
								</Typography>
								{radios?.map((radio, index) => (
									<Typography key={index} variant="body2" sx={{ pl: 2 }}>
										#{index} Kind: {radio.kind} ({radioKindNames[radio.kind] ?? 'Unknown'}) ／ Name:{' '}
										{radio.name || '(名称なし)'} ／ NameLength: {radio.nameLength} ／ HearableMask: {radio.hearableMask}{' '}
										(0x{(radio.hearableMask >>> 0).toString(16).toUpperCase().padStart(8, '0')}) ／ 声が届くPlayerId:{' '}
										{hearablePlayerIds(radio.hearableMask)}
									</Typography>
								))}
							</Box>
						);
					})}
				</AccordionDetails>
			</Accordion>
		</Box>
	);
}
