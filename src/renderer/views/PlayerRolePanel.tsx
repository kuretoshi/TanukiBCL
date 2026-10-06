import React, { useState } from 'react';
import { Alert, Box, Chip, Collapse, IconButton, TextField, Typography } from '@mui/material';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { AmongUsState, Player } from '../../common/AmongUsState';
import type { SnrEnumValue } from '../../common/SnrRole';
import type { NosRadioReports } from './NosDebugPanel';
import PlayerRadioPanel from './PlayerRadioPanel';

function Flag({ value }: { value: boolean | null | undefined }): React.JSX.Element {
	return (
		<Chip
			size="small"
			variant="outlined"
			label={value == null ? '未取得' : value ? 'true / はい' : 'false / いいえ'}
			color={value == null ? 'warning' : value ? 'success' : 'default'}
		/>
	);
}

function enumLabel(value: SnrEnumValue | null | undefined, available: boolean): string {
	return value ? `${value.name ?? '名称不明'} (${value.value})` : available ? 'なし' : '未取得';
}

const numberLabel = (value: number | undefined, digits = 3) =>
	typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '未取得';
const sectionStyles = { p: 1.5, minWidth: 0, border: 1, borderColor: 'divider', borderRadius: 1 };
const costumeLabel = (value: string | undefined) => (value == null ? '未取得' : value || 'なし');

function PlayerAppearance({ player, mod }: { player: Player; mod: AmongUsState['mod'] }): React.JSX.Element {
	return (
		<Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1.5fr)' }, gap: 2 }}>
			<Box sx={sectionStyles}>
				<Typography variant="subtitle2" sx={{ mb: 1 }}>
					座標・サイズ
				</Typography>
				<Values
					values={[
						['X / Y', `${numberLabel(player.x, 2)} / ${numberLabel(player.y, 2)}`],
						...(mod === 'NoS'
							? ([
									['BodyRateX', numberLabel(player.nosPlayer?.bodyRateX)],
									['BodyRateY', numberLabel(player.nosPlayer?.bodyRateY)],
								] as [string, React.ReactNode][])
							: []),
						...(player.snrRole?.jumbo
							? ([
									[
										'Jumbo current / max',
										`${numberLabel(player.snrRole.jumbo.currentSize)} / ${numberLabel(player.snrRole.jumbo.maxSize)}`,
									],
								] as [string, React.ReactNode][])
							: []),
					]}
				/>
			</Box>
			<Box sx={sectionStyles}>
				<Typography variant="subtitle2" sx={{ mb: 1 }}>
					外見・コスチューム
				</Typography>
				<Values
					values={[
						['外見名 / Outfit', `${player.appearanceName ?? player.name} / ${player.currentOutfit ?? '未取得'}`],
						['色ID（元 → 外見）', `${player.colorId ?? '未取得'} → ${player.appearanceColorId ?? '未取得'}`],
						['Skin（元 → 外見）', `${costumeLabel(player.skinId)} → ${costumeLabel(player.appearanceSkinId)}`],
						['Hat（元 → 外見）', `${costumeLabel(player.hatId)} → ${costumeLabel(player.appearanceHatId)}`],
						['Visor（元 → 外見）', `${costumeLabel(player.visorId)} → ${costumeLabel(player.appearanceVisorId)}`],
						...(mod === 'NoS'
							? ([
									['NoS Skin', costumeLabel(player.nosPlayer?.skin?.name)],
									['NoS Hat', costumeLabel(player.nosPlayer?.hat?.name)],
									['NoS Visor', costumeLabel(player.nosPlayer?.visor?.name)],
								] as [string, React.ReactNode][])
							: []),
						...(mod === 'SUPER_NEW_ROLES'
							? ([
									['SNR Hat2', costumeLabel(player.snrHat2Id)],
									['SNR Visor2', costumeLabel(player.snrVisor2Id)],
								] as [string, React.ReactNode][])
							: []),
					]}
				/>
			</Box>
		</Box>
	);
}

function Values({ values }: { values: [string, React.ReactNode][] }): React.JSX.Element {
	return (
		<Box
			component="dl"
			sx={{
				m: 0,
				display: 'grid',
				gridTemplateColumns: 'minmax(110px, 0.8fr) minmax(0, 1fr)',
				gap: '6px 12px',
				alignItems: 'center',
			}}
		>
			{values.map(([label, value]) => (
				<React.Fragment key={label}>
					<Box component="dt" sx={{ color: 'text.secondary', fontSize: 12, overflowWrap: 'anywhere' }}>
						{label}
					</Box>
					<Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13 }}>
						{value}
					</Box>
				</React.Fragment>
			))}
		</Box>
	);
}

function ModValues({ player, mod }: { player: Player; mod: AmongUsState['mod'] }): React.JSX.Element {
	if (mod === 'SUPER_NEW_ROLES') {
		const data = player.snrRole;
		return (
			<Values
				values={[
					['Role', enumLabel(data?.role, !!data)],
					['Modifier', enumLabel(data?.modifier, !!data)],
					['GhostRole', enumLabel(data?.ghostRole, !!data)],
					['IsNeutral', <Flag key="flag0" value={data?.isNeutral} />],
					['CanKill', <Flag key="flag1" value={data?.canKill} />],
				]}
			/>
		);
	}
	if (mod === 'NoS') {
		const data = player.nosPlayer;
		return (
			<Values
				values={[
					['IsImpostor', <Flag key="flag2" value={data?.isImpostor} />],
					['IsCrewmate', <Flag key="flag3" value={data?.isCrewmate} />],
					['IsNeutral', <Flag key="flag4" value={data?.isNeutral} />],
					['IsKiller', <Flag key="flag5" value={data?.isKiller} />],
					['IsImpostorlike', <Flag key="flag6" value={data?.isImpostorlike} />],
					['IsJammed', <Flag key="flag7" value={data?.isJammed} />],
				]}
			/>
		);
	}
	if (mod === 'TOH4E') {
		const data = player.tohRole;
		return (
			<Values
				values={[
					['RoleId', data?.roleId ?? '未取得'],
					['RoleName', data?.roleName ?? '未取得'],
					['IKiller', <Flag key="flag8" value={data?.isKiller} />],
					['IsNeutralKiller', <Flag key="flag9" value={data?.isNeutralKiller} />],
					...(data?.roleName === 'Opportunist'
						? [
								['Opportunist.CanKill', <Flag key="flag10" value={data.opportunistCanKill} />] as [
									string,
									React.ReactNode,
								],
							]
						: []),
				]}
			/>
		);
	}
	return (
		<Typography variant="body2" color="text.secondary">
			MOD固有値なし
		</Typography>
	);
}

export default function PlayerRolePanel({
	gameState,
	radioReports,
	radioClientIds,
}: {
	gameState: AmongUsState;
	radioReports?: NosRadioReports;
	radioClientIds?: number[];
}): React.JSX.Element {
	const [query, setQuery] = useState('');
	const [collapsedPlayers, setCollapsedPlayers] = useState<Record<string, boolean>>({});
	const playerKey = (player: Player) => `${gameState.lobbyCode ?? ''}:${player.clientId}:${player.id}`;
	const isCollapsed = (player: Player) => !!collapsedPlayers[playerKey(player)];
	const togglePlayer = (player: Player) => {
		const key = playerKey(player);
		setCollapsedPlayers((previous) => ({ ...previous, [key]: !previous[key] }));
	};
	const players = gameState.players ?? [];
	const search = query.trim().toLocaleLowerCase();
	const filtered = players.filter((player) =>
		[player.name, String(player.id), player.roleName, player.snrRole?.role.name, player.tohRole?.roleName].some(
			(value) => value?.toLocaleLowerCase().includes(search)
		)
	);
	const mod = gameState.mod;
	const isNosMissing = (player: Player) => mod === 'NoS' && !player.nosPlayer;
	const status =
		mod === 'NoS'
			? gameState.nosReadStatus?.message
			: mod === 'SUPER_NEW_ROLES'
				? gameState.debug?.snrRoleStatus
				: mod === 'TOH4E'
					? gameState.debug?.tohRoleStatus
					: undefined;
	return (
		<Box sx={{ p: 2, userSelect: 'text' }}>
			{status && (
				<Alert severity={mod === 'NoS' && gameState.nosReadStatus?.failed ? 'error' : 'info'} sx={{ mb: 1 }}>
					{status}
				</Alert>
			)}
			{mod === 'NoS' && (
				<Alert severity="info" sx={{ mb: 1 }}>
					NoSが公開する情報は陣営・判定値です。TBCLFieldsには役職名が含まれないため、個別の役職名は表示できません。
				</Alert>
			)}
			<TextField
				label="プレイヤー名・ID・役職名で検索"
				size="small"
				fullWidth
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>

			<Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, my: 1.5 }}>
				<Typography variant="body2" sx={{ mr: 'auto' }}>
					プレイヤー {filtered.length} / {players.length}人
				</Typography>
				<Chip size="small" variant="outlined" color="success" label="true / はい" />
				<Chip size="small" variant="outlined" label="false / いいえ" />
				<Chip size="small" variant="outlined" color="warning" label="未取得" />
			</Box>
			<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
				{filtered.map((player) => (
					<Box
						component="article"
						aria-label={`${player.name}のデバッグ情報`}
						key={playerKey(player)}
						sx={{
							minWidth: 0,
							border: isNosMissing(player) ? 2 : 1,
							borderColor: isNosMissing(player) ? 'error.main' : player.isLocal ? 'primary.main' : 'divider',
							borderRadius: 2,
							overflow: 'hidden',
							backgroundColor: 'background.paper',
						}}
					>
						<Box
							sx={{
								px: 2,
								py: 1.5,
								backgroundColor: player.isLocal ? 'rgba(186,104,200,0.1)' : 'rgba(255,255,255,0.025)',
								borderBottom: isCollapsed(player) ? 0 : 1,
								borderColor: 'divider',
							}}
						>
							<Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
								<Typography variant="subtitle1" sx={{ fontWeight: 'bold', overflowWrap: 'anywhere', minWidth: 0 }}>
									{player.name}
								</Typography>
								{player.isLocal && <Chip size="small" variant="outlined" color="primary" label="自分" />}
								<Chip size="small" label={player.disconnected ? '切断' : player.isDead ? '死亡' : '生存'} />
								{isNosMissing(player) && <Chip size="small" color="error" label="NoS未取得" />}
								<Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
									PlayerId: {player.id} ／ ClientId: {player.clientId}
								</Typography>
								<IconButton
									size="small"
									aria-label={`${player.name}の詳細を${isCollapsed(player) ? '展開' : '最小化'}`}
									title={isCollapsed(player) ? '詳細を展開' : '詳細を最小化'}
									aria-expanded={!isCollapsed(player)}
									aria-controls={`player-details-${player.id}-${player.clientId}`}
									onClick={() => togglePlayer(player)}
								>
									{isCollapsed(player) ? <ExpandMore /> : <ExpandLess />}
								</IconButton>
							</Box>
							<Typography variant="body2" sx={{ mt: 0.5, color: 'primary.main', overflowWrap: 'anywhere' }}>
								{mod === 'NoS' ? '陣営' : '役職'}: {player.roleName || '未取得'}
							</Typography>
						</Box>
						<Collapse in={!isCollapsed(player)} id={`player-details-${player.id}-${player.clientId}`} unmountOnExit>
							<Box sx={{ p: 2 }}>
								<Box
									sx={{
										display: 'grid',
										gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr)' },
										gap: 2,
										mb: 2,
									}}
								>
									<Box sx={sectionStyles}>
										<Typography variant="subtitle2" sx={{ mb: 1 }}>
											ベタクル側の判定
										</Typography>
										<Values
											values={[
												['RoleTeam（本体）', player.roleTeam ?? '未取得'],
												[
													'IsImpostor',
													<Flag
														key="app-impostor"
														value={mod === 'NoS' && !player.nosPlayer ? undefined : player.isImpostor}
													/>,
												],
												[
													'IsThirdParty',
													<Flag
														key="app-third-party"
														value={mod === 'NoS' && !player.nosPlayer ? undefined : player.isThirdParty}
													/>,
												],
											]}
										/>
									</Box>
									<Box sx={sectionStyles}>
										<Typography variant="subtitle2" sx={{ mb: 1 }}>
											MOD固有の値
										</Typography>
										<ModValues player={player} mod={mod} />
									</Box>
								</Box>
								<PlayerAppearance player={player} mod={mod} />
								<PlayerRadioPanel
									player={player}
									gameState={gameState}
									radioReports={radioReports}
									radioClientIds={radioClientIds}
								/>
							</Box>
						</Collapse>
					</Box>
				))}
			</Box>
			{filtered.length === 0 && (
				<Typography sx={{ py: 2 }}>
					{players.length ? '検索に一致するプレイヤーはいません。' : 'プレイヤー情報を待っています…'}
				</Typography>
			)}
			{mod === 'SUPER_NEW_ROLES' && (
				<Typography variant="body2" sx={{ mt: 1 }}>
					SNRの詳細な割り当て陣営・勝利陣営は下の「SNR：役職・割り当て陣営・勝利陣営」で自動更新されます。
				</Typography>
			)}
		</Box>
	);
}
