import React, { useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import type { Player } from '../../common/AmongUsState';
import { ipcRenderer } from '../lib/electron-bridge';

interface BanRecord {
	uid_digest: string;
	player_uid: string;
	display_name: string;
	friend_code: string;
	reason: string;
	created_at: number;
}

interface PendingNameBan {
	player_name: string;
	reason: string;
}

export default function PlayerBanPanel({ players }: { players: Player[] }): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [reason, setReason] = useState('');
	const [playerName, setPlayerName] = useState('');
	const [bans, setBans] = useState<BanRecord[]>([]);
	const [pending, setPending] = useState<PendingNameBan[]>([]);
	const [message, setMessage] = useState('管理者パスワードを入力して一覧を読み込んでください。');
	const [busy, setBusy] = useState(false);
	const [confirmUid, setConfirmUid] = useState('');
	const [confirmName, setConfirmName] = useState('');

	const operate = async (payload: Record<string, unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			const result = (await ipcRenderer.invoke('debug:player-bans', { password, ...payload })) as {
				bans?: BanRecord[];
				pending?: PendingNameBan[];
				error?: string;
			};
			if (result.error) setMessage(result.error);
			else if (result.bans) {
				setBans(result.bans);
				setPending(result.pending ?? []);
				setMessage('BAN一覧を更新しました。');
				setConfirmUid('');
				setConfirmName('');
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
				UIDが分かるプレイヤーは直接登録できます。名前だけの場合は、同名の別人が先に接続するとそのUIDが登録されます。
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
			<Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
				<TextField
					label="UID待ちのプレイヤー名（完全一致）"
					size="small"
					value={playerName}
					onChange={(event) => {
						setPlayerName(event.target.value);
						setConfirmName('');
					}}
					slotProps={{ htmlInput: { maxLength: 80 } }}
				/>
				<Button
					color="error"
					disabled={!password || !playerName.trim() || busy}
					onClick={() => {
						const name = playerName.trim();
						if (confirmName !== name) {
							setConfirmName(name);
							setMessage(`${name}を名前で登録する場合は、もう一度押してください。`);
							return;
						}
						void operate({ action: 'add-name', playerName: name, reason });
					}}
				>
					{confirmName === playerName.trim() ? '名前登録を確定' : '名前で登録'}
				</Button>
			</Box>
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
			<Typography variant="subtitle2">UID待ち</Typography>
			{pending.map((item) => (
				<Box key={item.player_name} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
					<Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>
						{item.player_name}
						{item.reason ? ` ／ ${item.reason}` : ''}
					</Typography>
					<Button
						disabled={!password || busy}
						onClick={() => void operate({ action: 'remove-name', playerName: item.player_name })}
					>
						解除
					</Button>
				</Box>
			))}
			<Typography variant="subtitle2">登録済み</Typography>
			{bans.map((ban) => (
				<Box key={ban.uid_digest} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
					<Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>
						{ban.display_name || '名前なし'} ／ UID: {ban.player_uid || '旧登録・未保存'}
						{ban.friend_code ? ` ／ ${ban.friend_code}` : ''}
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
