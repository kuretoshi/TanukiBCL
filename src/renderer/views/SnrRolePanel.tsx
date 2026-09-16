import React, { useState } from 'react';
import { Box, Button, Typography, Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material';
import { ipcRenderer } from '../lib/electron-bridge';
import { AmongUsState } from '../../common/AmongUsState';

type EnumValue = { value: number; name: string | null } | null;
interface SnrRow {
	playerId: number;
	role: EnumValue;
	modifier: EnumValue;
	ghostRole: EnumValue;
	assignedTeam: EnumValue;
	winnerTeam: EnumValue;
	teamTag: EnumValue;
	roleClass: string | null;
	abilities: { name: string | null; currentTeam: EnumValue }[];
}
interface SnrResult {
	status: string;
	message?: string;
	pid?: number;
	capturedAt?: string;
	version?: string;
	players?: SnrRow[];
}
const label = (value: EnumValue) => (value ? `${value.name || '不明'} (${value.value})` : '未取得');

export default function SnrRolePanel({ gameState }: { gameState: AmongUsState }): React.JSX.Element {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<SnrResult | null>(null);
	const read = async () => {
		if (busy) return;
		setBusy(true);
		setResult(null);
		try {
			setResult((await ipcRenderer.invoke('debug:snr-roles')) as SnrResult);
		} catch {
			setResult({ status: 'error', message: '取得処理に失敗しました。' });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2, userSelect: 'text' }}>
			<Button variant="outlined" disabled={busy || gameState.mod !== 'SUPER_NEW_ROLES'} onClick={() => void read()}>
				{busy ? '取得中…' : 'SNR役職を取得'}
			</Button>
			<Typography variant="body2" sx={{ my: 1 }}>
				取得ボタンを押した時点の管理メモリを読み取ります。音声の陣営判定には反映しません。
			</Typography>
			<Typography variant="caption">
				スナップショット作成時にゲームが一瞬停止する場合があります。試合中の連続取得は避けてください。
			</Typography>
			{result?.status === 'error' && (
				<Typography role="alert" sx={{ mt: 1 }}>
					{result.message}
				</Typography>
			)}
			{result?.status === 'ok' && (
				<>
					<Typography sx={{ my: 1 }}>
						取得時刻: {result.capturedAt} / PID: {result.pid} / SNR: {result.version}
					</Typography>
					<Table size="small">
						<TableHead>
							<TableRow>
								{['Player ID', 'SNR役職', '割り当て陣営', '勝利陣営', 'チーム', '追加属性', '幽霊役職'].map((t) => (
									<TableCell key={t}>{t}</TableCell>
								))}
							</TableRow>
						</TableHead>
						<TableBody>
							{result.players?.map((p) => (
								<TableRow key={p.playerId}>
									<TableCell>{p.playerId}</TableCell>
									<TableCell>{label(p.role)}</TableCell>
									<TableCell>{label(p.assignedTeam)}</TableCell>
									<TableCell>{label(p.winnerTeam)}</TableCell>
									<TableCell>{label(p.teamTag)}</TableCell>
									<TableCell>{label(p.modifier)}</TableCell>
									<TableCell>{label(p.ghostRole)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					{result.players?.length === 0 && (
						<Typography sx={{ mt: 1 }}>
							プレイヤー情報はまだ初期化されていません。役職割り当て後に再取得してください。
						</Typography>
					)}
					<Box component="pre" sx={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
						{JSON.stringify(result.players, null, 2)}
					</Box>
				</>
			)}
		</Box>
	);
}
