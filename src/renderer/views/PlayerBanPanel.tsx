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

interface PlayerHistoryRecord {
	uid_digest: string;
	display_name: string;
	friend_code: string;
	first_seen_at: number;
	last_seen_at: number;
	is_banned: number;
}

const formatSeenAt = (seconds: number) => new Date(seconds * 1000).toLocaleString('ja-JP');

const HistoryRecords = React.memo(function HistoryRecords({ records }: { records: PlayerHistoryRecord[] }) {
	return (
		<Box sx={{ maxHeight: 360, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
			{records.map((item) => (
				<Box key={item.uid_digest} sx={{ py: 0.75, borderBottom: 1, borderColor: 'divider' }}>
					<Typography variant="body2">
						{item.display_name} ／ ID: …{item.uid_digest.slice(-8)}
						{item.friend_code ? ` ／ ${item.friend_code}` : ''} ／ {item.is_banned ? 'BAN済み' : '未BAN'}
					</Typography>
					<Typography variant="caption">
						初回: {formatSeenAt(item.first_seen_at)} ／ 最終: {formatSeenAt(item.last_seen_at)}
					</Typography>
				</Box>
			))}
		</Box>
	);
});

export default function PlayerBanPanel({ players }: { players: Player[] }): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [reason, setReason] = useState('');
	const [playerName, setPlayerName] = useState('');
	const [bans, setBans] = useState<BanRecord[]>([]);
	const [pending, setPending] = useState<PendingNameBan[]>([]);
	const [history, setHistory] = useState<PlayerHistoryRecord[]>([]);
	const [historyTotal, setHistoryTotal] = useState(0);
	const [historyLoaded, setHistoryLoaded] = useState(false);
	const [historyAvailable, setHistoryAvailable] = useState(true);
	const [message, setMessage] = useState('管理者パスワードを入力して一覧を読み込んでください。');
	const [busy, setBusy] = useState(false);
	const [confirmUid, setConfirmUid] = useState('');
	const [confirmName, setConfirmName] = useState('');

	const operate = async (payload: Record<string, unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			const result = (await ipcRenderer.invoke('debug:player-bans', {
				password,
				...payload,
				historyAll: true,
			})) as {
				bans?: BanRecord[];
				pending?: PendingNameBan[];
				history?: PlayerHistoryRecord[];
				historyTotal?: number;
				historyAvailable?: boolean;
				error?: string;
			};
			if (result.error) setMessage(result.error);
			else if (result.bans) {
				setBans(result.bans);
				setPending(result.pending ?? []);
				setHistory(result.history ?? []);
				setHistoryTotal(result.historyTotal ?? 0);
				setHistoryAvailable(result.historyAvailable !== false);
				setHistoryLoaded(true);
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
			<Typography variant="subtitle2">現在のロビー</Typography>
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
			<Button variant="outlined" onClick={() => void ipcRenderer.invoke('OPEN_PLAYER_HISTORY')}>
				プレイヤー履歴を別ウィンドウで開く
			</Button>
			<Typography variant="subtitle2">
				DB登録済みプレイヤー（{historyLoaded ? `${historyTotal}人` : '未読み込み'}）
			</Typography>
			{historyLoaded && !historyAvailable && <Typography variant="body2">履歴機能はサーバーに未反映です。</Typography>}
			{historyLoaded && historyAvailable && history.length === 0 && (
				<Typography variant="body2">記録されたプレイヤーはまだいません。</Typography>
			)}
			{historyLoaded && historyAvailable && history.length < historyTotal && (
				<Typography variant="body2">一部のみ取得できました。サーバーの更新を確認してください。</Typography>
			)}
			{history.length > 0 && <HistoryRecords records={history} />}
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
