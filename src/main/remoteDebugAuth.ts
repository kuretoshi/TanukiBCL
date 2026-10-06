export type DebugAuthResult = 'authorized' | 'denied' | 'unavailable';

/** Only the main process sends passwords to the configured HTTPS endpoint. */
export async function verifyRemoteDebugPassword(
	password: unknown,
	endpoint: string,
	request: typeof fetch
): Promise<DebugAuthResult> {
	if (typeof password !== 'string' || !password || password.length > 1024) return 'denied';
	try {
		const url = new URL(endpoint);
		if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return 'unavailable';
		const response = await request(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password }),
			redirect: 'error',
			signal: AbortSignal.timeout(10000),
		});
		if (response.status === 401) return 'denied';
		if (response.status !== 200) return 'unavailable';
		const text = await response.text();
		if (text.length > 1024) return 'unavailable';
		return JSON.parse(text)?.authorized === true ? 'authorized' : 'denied';
	} catch {
		return 'unavailable';
	}
}
