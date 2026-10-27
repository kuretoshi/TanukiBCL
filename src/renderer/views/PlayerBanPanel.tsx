import React, { useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import type { Player } from '../../common/AmongUsState';
import { ipcRenderer } from '../lib/electron-bridge';

interface BanRecord {
	uid_digest: string;
	display_name: string;
	friend_code: string;
	reason: string;
	created_at: number;
}

export default function PlayerBanPanel({ players }: { players: Player[] }): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [reason, setReason] = useState('');
	const [bans, setBans] = useState<BanRecord[]>([]);
	const [message, setMessage] = useState('管理者パスワードを入力して一覧を読み込んでください。');
	const [busy, setBusy] = useState(false);
	const [confirmUid, setConfirmUid] = useState('');

	const operate = async (payload: Record<string, unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			const result = (await ipcRenderer.invoke('debug:player-bans', { password, ...payload })) as {
				bans?: BanRecord[];
				error?: string;
			};
			if (result.error) setMessage(result.error);
			else if (result.bans) {
				setBans(result.bans);
				setMessage('BAN一覧を更新しました。');
				setConfirmUid('');
			}
		} catch {
			setMessage('BANサーバーに接続できませんでした。');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
			<Typography variant="body2">
				現在のプレイヤーからBAN対象を選べます。ゲーム内IDや名前だけでは登録できません。
			</Typography>
			<Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
				<TextField
					type="password"
					label="BAN管理者パスワード"
					size="small"
					autoComplete="off"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
				<Button disabled={!password || busy} onClick={() => void operate({ action: 'list' })}>
					一覧を読み込む
				</Button>
			</Box>
			<TextField
				label="登録理由（任意）"
				size="small"
				value={reason}
				onChange={(event) => setReason(event.target.value)}
				slotProps={{ htmlInput: { maxLength: 500 } }}
			/>
			<Typography role="status" variant="caption">
				{message}
			</Typography>
			{players
				.filter((player) => player.playerUid)
				.map((player) => (
					<Box key={player.id} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
						<Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>
							{player.name}
							{player.isLocal ? '（自分）' : ''} ／ Friend Code: {player.friendCode || 'なし'}
						</Typography>
						<Button
							color="error"
							variant="outlined"
							disabled={!password || busy}
							onClick={() => {
								if (confirmUid !== player.playerUid) {
									setConfirmUid(player.playerUid);
									setMessage(`${player.name}をBANする場合は、もう一度押してください。`);
									return;
								}
								void operate({
									action: 'add',
									playerUid: player.playerUid,
									displayName: player.name,
									friendCode: player.friendCode,
									reason,
								});
							}}
						>
							{confirmUid === player.playerUid ? 'BANを確定' : 'BAN登録'}
						</Button>
					</Box>
				))}
			{players.every((player) => !player.playerUid) && (
				<Typography variant="body2">ユーザー識別子の取得を待っています。</Typography>
			)}
			<Typography variant="subtitle2">登録済み</Typography>
			{bans.map((ban) => (
				<Box key={ban.uid_digest} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
					<Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>
						{ban.display_name || '名前なし'} ／ {ban.friend_code || 'Friend Codeなし'}
						{ban.reason ? ` ／ ${ban.reason}` : ''}
					</Typography>
					<Button disabled={busy} onClick={() => void operate({ action: 'remove', uidDigest: ban.uid_digest })}>
						解除
					</Button>
				</Box>
			))}
		</Box>
	);
}
