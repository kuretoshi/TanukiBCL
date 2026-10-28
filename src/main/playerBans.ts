const PLAYER_BAN_BASE_URL = 'https://debug-auth.kuretoshi.work/v1/player-bans';

export interface PlayerBanRecord {
	uid_digest: string;
	player_uid: string;
	display_name: string;
	friend_code: string;
	reason: string;
	created_at: number;
}

export interface PendingPlayerNameBan {
	player_name: string;
	reason: string;
	created_at: number;
}

export interface PlayerHistoryRecord {
	uid_digest: string;
	display_name: string;
	friend_code: string;
	first_seen_at: number;
	last_seen_at: number;
	is_banned: number;
}

async function postBanRequest(path: 'check' | 'manage', payload: object, request: typeof fetch): Promise<unknown> {
	const response = await request(`${PLAYER_BAN_BASE_URL}/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
		redirect: 'error',
		signal: AbortSignal.timeout(7000),
	});
	const body = await response.json();
	if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'BANサーバーを確認できません。');
	return body;
}

export async function checkPlayerBan(
	playerUid: unknown,
	playerName: unknown,
	friendCode: unknown,
	observedPlayers: unknown,
	request: typeof fetch
): Promise<'clear' | 'banned' | 'unavailable'> {
	if (typeof playerUid !== 'string' || !playerUid.trim() || playerUid.length > 256) return 'unavailable';
	if (typeof playerName !== 'string' || playerName.length > 80) return 'unavailable';
	if (typeof friendCode !== 'string' || friendCode.length > 80) return 'unavailable';
	const observed = Array.isArray(observedPlayers)
		? observedPlayers
				.slice(0, 29)
				.filter(
					(player) =>
						player &&
						typeof player.playerUid === 'string' &&
						player.playerUid.length <= 256 &&
						typeof player.playerName === 'string' &&
						player.playerName.length <= 80 &&
						(typeof player.friendCode === 'undefined' ||
							(typeof player.friendCode === 'string' && player.friendCode.length <= 80))
				)
		: [];
	try {
		const result = (await postBanRequest(
			'check',
			{ playerUid, playerName, friendCode, observedPlayers: observed },
			request
		)) as {
			banned?: unknown;
		};
		return result.banned === true ? 'banned' : result.banned === false ? 'clear' : 'unavailable';
	} catch {
		return 'unavailable';
	}
}

export async function managePlayerBans(
	payload: unknown,
	request: typeof fetch
): Promise<
	| {
			bans: PlayerBanRecord[];
			pending: PendingPlayerNameBan[];
			history: PlayerHistoryRecord[];
			historyTotal: number;
			historyAvailable: boolean;
	  }
	| { error: string }
> {
	if (!payload || typeof payload !== 'object') return { error: '入力内容を確認してください。' };
	const data = payload as Record<string, unknown>;
	if (typeof data.password !== 'string' || !data.password || data.password.length > 1024)
		return { error: '管理者パスワードを入力してください。' };
	if (!['list', 'add', 'remove', 'add-name', 'remove-name', 'add-history'].includes(String(data.action)))
		return { error: '操作を確認してください。' };
	try {
		const result = (await postBanRequest('manage', data, request)) as {
			bans?: PlayerBanRecord[];
			pending?: PendingPlayerNameBan[];
			history?: PlayerHistoryRecord[];
			historyTotal?: number;
		};
		return Array.isArray(result.bans) && Array.isArray(result.pending)
			? {
					bans: result.bans,
					pending: result.pending,
					history: result.history ?? [],
					historyTotal: result.historyTotal ?? 0,
					historyAvailable: Array.isArray(result.history),
				}
			: { error: 'BAN一覧を取得できませんでした。' };
	} catch (error) {
		return { error: error instanceof Error ? error.message : 'BANサーバーを確認できません。' };
	}
}
