import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Button, Paper, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
import type { PlayerHistoryRecord } from '../../main/playerBans';
import theme from '../lib/theme';
import { ipcRenderer } from '../lib/electron-bridge';
import '../css/index.css';

interface HistoryFilter {
	name: string;
	from: number | null;
	to: number | null;
}

const pageSize = 50;
const formatSeenAt = (seconds: number) => new Date(seconds * 1000).toLocaleString('ja-JP');

function dateBoundary(value: string, nextDay: boolean): number | null {
	if (!value) return null;
	const date = new Date(`${value}T00:00:00`);
	if (Number.isNaN(date.getTime())) return null;
	if (nextDay) date.setDate(date.getDate() + 1);
	return Math.floor(date.getTime() / 1000);
}

function PlayerHistoryWindow(): React.JSX.Element {
	const [password, setPassword] = useState('');
	const [reason, setReason] = useState('');
	const [name, setName] = useState('');
	const [fromDate, setFromDate] = useState('');
	const [toDate, setToDate] = useState('');
	const [filter, setFilter] = useState<HistoryFilter>({ name: '', from: null, to: null });
	const [offset, setOffset] = useState(0);
	const [history, setHistory] = useState<PlayerHistoryRecord[]>([]);
	const [total, setTotal] = useState(0);
	const [busy, setBusy] = useState(false);
	const [confirmDigest, setConfirmDigest] = useState('');
	const [banType, setBanType] = useState<'uid' | 'ip'>('uid');
	const [ipBansAvailable, setIpBansAvailable] = useState(false);
	const [message, setMessage] = useState('管理者パスワードを入力し、検索してください。');

	const operate = async (
		action: 'list' | 'add-history' | 'add-history-ip',
		nextFilter: HistoryFilter,
		nextOffset: number,
		digest?: string
	) => {
		if (busy || !password) return;
		setBusy(true);
		setMessage('確認しています…');
		try {
			const result = (await ipcRenderer.invoke('debug:player-bans', {
				password,
				action,
				uidDigest: digest,
				reason,
				historyName: nextFilter.name,
				historyFrom: nextFilter.from,
				historyTo: nextFilter.to,
				historyOffset: nextOffset,
			})) as {
				history?: PlayerHistoryRecord[];
				historyTotal?: number;
				historyAvailable?: boolean;
				ipBansAvailable?: boolean;
				error?: string;
			};
			if (result.error) {
				setMessage(result.error);
				return;
			}
			setIpBansAvailable(result.ipBansAvailable === true);
			if (result.ipBansAvailable !== true) setBanType('uid');
			setConfirmDigest('');
			if (result.historyAvailable === false) {
				setMessage('履歴機能はサーバーに未反映です。サーバーの更新後に利用できます。');
				return;
			}
			setHistory(result.history ?? []);
			setTotal(result.historyTotal ?? 0);
			setFilter(nextFilter);
			setOffset(nextOffset);
			setMessage(action === 'list' ? '履歴を更新しました。' : 'BANを登録しました。');
		} catch {
			setMessage('BANサーバーに接続できませんでした。');
		} finally {
			setBusy(false);
		}
	};

	const search = () => {
		const from = dateBoundary(fromDate, false);
		const to = dateBoundary(toDate, true);
		if ((fromDate && from === null) || (toDate && to === null) || (from !== null && to !== null && from >= to)) {
			setMessage('日付の範囲を確認してください。');
			return;
		}
		void operate('list', { name: name.trim(), from, to }, 0);
	};

	return (
		<StyledEngineProvider injectFirst>
			<ThemeProvider theme={theme}>
				<Box
					sx={{
						minHeight: '100vh',
						bgcolor: 'background.default',
						color: 'text.primary',
						p: 2,
						boxSizing: 'border-box',
					}}
				>
					<Typography variant="h6">過去に同じロビーで確認したプレイヤー</Typography>
					<Typography variant="caption" color="text.secondary">
						初回・最終日時は、アプリが同じロビーで確認した時刻です。日付検索は最終確認日を対象にします。
					</Typography>
					<Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', my: 2 }}>
						<TextField
							size="small"
							type="password"
							label="BAN管理者パスワード"
							autoComplete="off"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<TextField
							size="small"
							label="登録理由（任意）"
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							slotProps={{ htmlInput: { maxLength: 500 } }}
						/>
					</Box>
					<ToggleButtonGroup
						exclusive
						size="small"
						value={banType}
						aria-label="BANの対象"
						onChange={(_, value: 'uid' | 'ip' | null) => {
							if (!value || (value === 'ip' && !ipBansAvailable)) return;
							setBanType(value);
							setConfirmDigest('');
						}}
					>
						<ToggleButton value="uid" disabled={busy}>
							ユーザー識別子（UID）
						</ToggleButton>
						<ToggleButton value="ip" disabled={busy || !ipBansAvailable}>
							IPアドレス
						</ToggleButton>
					</ToggleButtonGroup>
					<Typography variant="caption" sx={{ display: 'block', my: 1 }}>
						IP BANは同じグローバルIPを使う他のユーザーにも適用されます。IP未取得のプレイヤーはIPでBANできません。
					</Typography>
					<Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
						<TextField
							size="small"
							label="名前で検索"
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') search();
							}}
							slotProps={{ htmlInput: { maxLength: 80 } }}
						/>
						<TextField
							size="small"
							type="date"
							label="最終確認日（開始）"
							value={fromDate}
							onChange={(event) => setFromDate(event.target.value)}
							slotProps={{ inputLabel: { shrink: true } }}
						/>
						<TextField
							size="small"
							type="date"
							label="最終確認日（終了）"
							value={toDate}
							onChange={(event) => setToDate(event.target.value)}
							slotProps={{ inputLabel: { shrink: true } }}
						/>
						<Button variant="contained" disabled={!password || busy} onClick={search}>
							検索
						</Button>
					</Box>
					<Typography role="status" variant="body2" sx={{ mb: 1 }}>
						{message}
					</Typography>
					<Typography variant="subtitle2" sx={{ mb: 1 }}>
						該当: {total}人
					</Typography>
					<Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
						{history.map((item) => (
							<Paper key={item.uid_digest} sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'center' }}>
								<Box sx={{ flex: 1 }}>
									<Typography variant="body2">
										{item.display_name} ／ ID: …{item.uid_digest.slice(-8)}
										{item.friend_code ? ` ／ ${item.friend_code}` : ''}
										{' ／ '}IP: {item.public_ip || '未取得'}
									</Typography>
									<Typography variant="caption" component="div">
										UID: {(item.uid_banned ?? item.is_banned) ? 'BAN済み' : '未BAN'} ／ IP:{' '}
										{item.ip_banned === undefined ? '未確認' : item.ip_banned ? 'BAN済み' : '未BAN'}
									</Typography>
									<Typography variant="caption">
										初回: {formatSeenAt(item.first_seen_at)} ／ 最終: {formatSeenAt(item.last_seen_at)}
									</Typography>
								</Box>
								{(banType === 'ip' ? item.ip_banned : (item.uid_banned ?? item.is_banned)) ? (
									<Typography variant="caption">{banType === 'ip' ? 'IP' : 'UID'} BAN済み</Typography>
								) : (
									<Button
										color="error"
										variant="outlined"
										disabled={busy || !password || (banType === 'ip' && (!ipBansAvailable || !item.public_ip))}
										onClick={() => {
											if (confirmDigest !== item.uid_digest) {
												setConfirmDigest(item.uid_digest);
												setMessage(
													`${item.display_name}を${banType === 'ip' ? 'IP' : 'UID'}でBANする場合は、もう一度押してください。`
												);
												return;
											}
											void operate(
												banType === 'ip' ? 'add-history-ip' : 'add-history',
												filter,
												offset,
												item.uid_digest
											);
										}}
									>
										{banType === 'ip' ? 'IP' : 'UID'}
										{confirmDigest === item.uid_digest ? ' BANを確定' : 'でBAN登録'}
									</Button>
								)}
							</Paper>
						))}
					</Box>
					{total > pageSize && (
						<Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
							<Button
								disabled={busy || offset === 0}
								onClick={() => void operate('list', filter, Math.max(0, offset - pageSize))}
							>
								前へ
							</Button>
							<Typography variant="caption">
								{offset + 1}〜{Math.min(offset + pageSize, total)} / {total}
							</Typography>
							<Button
								disabled={busy || offset + pageSize >= total}
								onClick={() => void operate('list', filter, offset + pageSize)}
							>
								次へ
							</Button>
						</Box>
					)}
				</Box>
			</ThemeProvider>
		</StyledEngineProvider>
	);
}

createRoot(document.getElementById('app')!).render(<PlayerHistoryWindow />);
