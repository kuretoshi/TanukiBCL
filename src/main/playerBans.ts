const PLAYER_BAN_BASE_URL = 'https://debug-auth.kuretoshi.work/v1/player-bans';

export interface PlayerBanRecord {
	uid_digest: string;
	display_name: string;
	friend_code: string;
	reason: string;
	created_at: number;
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
	request: typeof fetch
): Promise<'clear' | 'banned' | 'unavailable'> {
	if (typeof playerUid !== 'string' || !playerUid.trim() || playerUid.length > 256) return 'unavailable';
	try {
		const result = (await postBanRequest('check', { playerUid }, request)) as { banned?: unknown };
		return result.banned === true ? 'banned' : result.banned === false ? 'clear' : 'unavailable';
	} catch {
		return 'unavailable';
	}
}

export async function managePlayerBans(
	payload: unknown,
	request: typeof fetch
): Promise<{ bans: PlayerBanRecord[] } | { error: string }> {
	if (!payload || typeof payload !== 'object') return { error: '入力内容を確認してください。' };
	const data = payload as Record<string, unknown>;
	if (typeof data.password !== 'string' || !data.password || data.password.length > 1024)
		return { error: '管理者パスワードを入力してください。' };
	if (!['list', 'add', 'remove'].includes(String(data.action))) return { error: '操作を確認してください。' };
	try {
		const result = (await postBanRequest('manage', data, request)) as { bans?: PlayerBanRecord[] };
		return Array.isArray(result.bans) ? { bans: result.bans } : { error: 'BAN一覧を取得できませんでした。' };
	} catch (error) {
		return { error: error instanceof Error ? error.message : 'BANサーバーを確認できません。' };
	}
}
