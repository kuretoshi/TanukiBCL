import React from 'react';
import { Box, Typography, Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material';
import { AmongUsState, GameState } from '../../common/AmongUsState';
import { isSnrNeutralKiller } from '../../common/SnrRole';

export default function DebugLivePanel({ gameState }: { gameState: AmongUsState }): React.JSX.Element {
	const players = gameState.players ?? [];
	return (
		<Box sx={{ overflowX: 'auto', p: 2, userSelect: 'text' }}>
			<Typography sx={{ mb: 1 }}>
				ゲーム状態: {GameState[gameState.gameState]} ／ プレイヤー: {players.length}人
			</Typography>
			<Typography variant="body2" sx={{ mb: 1 }}>
				通信妨害: {gameState.comsSabotaged ? 'あり' : 'なし'} ／ カモフラージュ:{' '}
				{gameState.camouflaged ? 'あり' : 'なし'} ／ ミックスアップ: {gameState.mixupSabotaged ? 'あり' : 'なし'}
			</Typography>
			<Typography variant="caption" color="text.secondary">
				{gameState.mod === 'SUPER_NEW_ROLES'
					? gameState.debug?.snrRoleStatus || 'SNR役職未取得'
					: gameState.mod === 'NoS'
						? gameState.nosReadStatus?.message || 'NoSスナップショット未取得'
						: gameState.mod === 'TOH4E'
							? gameState.debug?.tohRoleStatus || 'TOH4E役職未取得'
							: '役職は現在取得できる判定値です。Mod固有の役職名をすべて識別するものではありません。'}
			</Typography>

			<Table size="small" sx={{ mt: 1, '& th, & td': { whiteSpace: 'nowrap' } }}>
				<TableHead>
					<TableRow>
						{['名前 / ID', '役職 / 本体陣営値', '状態', '会話状態', '変身 / 外見', 'サイズ', '座標'].map((label) => (
							<TableCell key={label}>{label}</TableCell>
						))}
					</TableRow>
				</TableHead>
				<TableBody>
					{players.map((player) => (
						<TableRow key={player.id} selected={player.isLocal}>
							<TableCell>
								{player.name}
								{player.isLocal ? '（自分）' : ''}
								<br />
								ID: {player.id} / Client: {player.clientId}
							</TableCell>
							<TableCell>
								{player.roleName || '不明'}
								<br />
								本体陣営値: {player.roleTeam}
								{gameState.mod === 'SUPER_NEW_ROLES' && player.snrRole && (
									<>
										<br />
										SNR IsNeutral: {player.snrRole.isNeutral == null ? '未取得' : String(player.snrRole.isNeutral)}
										<br />
										SNR CanKill: {player.snrRole.canKill == null ? '未取得' : String(player.snrRole.canKill)}
										<br />
										第三陣営キル役職の対象: {isSnrNeutralKiller(player.snrRole) ? 'はい' : 'いいえ／未取得'}
									</>
								)}
								{gameState.mod === 'TOH4E' && (
									<>
										<br />
										RoleId: {player.tohRole?.roleId ?? '未取得'}
										<br />
										IKiller: {player.tohRole?.isKiller == null ? '未取得' : String(player.tohRole.isKiller)}
										{player.tohRole?.roleName === 'Opportunist' && (
											<>
												<br />
												Opportunist.CanKill:{' '}
												{player.tohRole.opportunistCanKill == null
													? '未取得'
													: String(player.tohRole.opportunistCanKill)}
											</>
										)}
									</>
								)}
								{gameState.mod === 'NoS' && player.nosPlayer && (
									<>
										<br />
										IsNeutral={String(player.nosPlayer.isNeutral)}
										<br />
										IsKiller={String(player.nosPlayer.isKiller)}
										<br />
										IsImpostor={String(player.nosPlayer.isImpostor)}
										<br />
										IsCrewmate={String(player.nosPlayer.isCrewmate)}
									</>
								)}
							</TableCell>
							<TableCell>
								{player.disconnected ? '切断' : player.isDead ? '死亡' : '生存'}
								{player.inVent ? ' / ベント' : ''}
							</TableCell>
							<TableCell>
								{gameState.mod === 'NoS'
									? `IsJammed (会議中のフィクサー妨害): ${player.nosPlayer?.isJammed == null ? '未取得' : String(player.nosPlayer.isJammed)}`
									: '—'}
							</TableCell>
							<TableCell>
								{player.appearanceName || player.name}
								<br />
								Outfit: {player.currentOutfit} / 色: {player.colorId} → {player.appearanceColorId}
								<br />
								Skin: {player.appearanceSkinId || 'なし'}
								<br />
								Hat: {player.appearanceHatId || 'なし'}
								<br />
								Visor: {player.appearanceVisorId || 'なし'}
								<br />
								Pet: {player.petId || 'なし'}
								{player.nosPlayer && (
									<>
										<br />
										NoS: {player.nosPlayer.name} / RGB:{' '}
										{[player.nosPlayer.colorR, player.nosPlayer.colorG, player.nosPlayer.colorB]
											.map((value) => value.toFixed(3))
											.join(', ')}
									</>
								)}
							</TableCell>
							<TableCell>
								{gameState.mod === 'NoS' && player.nosPlayer && (
									<>
										BodyRateX: {player.nosPlayer.bodyRateX?.toFixed(3) ?? '未取得'}
										<br />
										BodyRateY: {player.nosPlayer.bodyRateY?.toFixed(3) ?? '未取得'}
									</>
								)}
								{gameState.mod === 'SUPER_NEW_ROLES' && player.snrRole?.jumbo && (
									<>
										ジャンボ:{' '}
										{Math.min(100, (player.snrRole.jumbo.currentSize / player.snrRole.jumbo.maxSize) * 100).toFixed(0)}%
									</>
								)}
							</TableCell>
							<TableCell>
								{player.x?.toFixed(2)}, {player.y?.toFixed(2)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{players.length === 0 && <Typography sx={{ py: 2 }}>プレイヤー情報を待っています…</Typography>}
			{gameState.debug && (
				<Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>
					自分の役職: {gameState.debug.localRoleLabel} / 陣営値: {gameState.debug.localRoleTeam}
					{'\n'}外見: {gameState.debug.currentOutfits}
					{'\n'}サイズ: {gameState.debug.sizeDebug}
					{'\n'}色: {gameState.debug.colorDebug}
				</Box>
			)}
		</Box>
	);
}
